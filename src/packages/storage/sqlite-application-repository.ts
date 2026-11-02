import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentRunStep,
  ApplicationRepository,
  AssistantMessageDraft,
  CompletedAgentRun,
  ModelConfiguration,
  ProviderConfiguration,
  ProviderConfigurationRepository,
  UserMessageDraft,
} from "../application/ports";
import type {
  AssistantMessage,
  Message,
  Session,
  SessionHistory,
  SessionId,
  UserMessage,
} from "../core/session";
import { StorageError } from "./errors";
import {
  isLegacyStoreDocument,
  isPreviousStoreDocument,
  isStoreDocument,
  migrateV1ToV3,
  migrateV2ToV3,
  type LegacyV1StoreDocument,
  type LegacyV2StoreDocument,
  type StoreDocument,
} from "./store-format";

const SCHEMA_VERSION = 2;

interface SessionRow {
  id: string;
  created_at: string;
  extra_json: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  sequence: number;
  role: "user" | "assistant";
  content_text: string;
  created_at: string;
  reasoning_json: string | null;
  extra_json: string;
}

interface RunRow {
  id: string;
  session_id: string;
  user_message_id: string;
  assistant_message_id: string;
  started_at: string;
  completed_at: string;
  provider_id: string | null;
  provider_name: string | null;
  model_config_id: string | null;
  model_id: string | null;
  model_name: string | null;
}

interface ModelConfigurationRow {
  id: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  source: "discovered" | "manual";
  capabilities_json: string;
  created_at: string;
  updated_at: string;
}

interface ProviderConfigurationRow {
  id: string;
  name: string;
  protocol: "openai-chat-completions";
  base_url: string;
  credential_ref: string | null;
  allow_insecure_http: number;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  ordinal: number;
  step_json: string;
}

export class SqliteApplicationRepository implements ApplicationRepository, ProviderConfigurationRepository {
  private readonly database: Database.Database;
  private closed = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const databasePath = join(dataDir, "store.sqlite");
    const jsonPath = join(dataDir, "store.json");
    const databaseExisted = existsSync(databasePath);
    let database: Database.Database | undefined;
    try {
      database = new Database(databasePath, { timeout: 5000 });
      chmodSync(databasePath, 0o600);
      database.pragma("foreign_keys = ON");
      database.pragma("busy_timeout = 5000");
      this.initialize(database, dataDir, jsonPath);
      this.database = database;
    } catch (error) {
      database?.close();
      if (!databaseExisted) {
        rmSync(databasePath, { force: true });
        rmSync(`${databasePath}-wal`, { force: true });
        rmSync(`${databasePath}-shm`, { force: true });
      }
      if (error instanceof StorageError) throw error;
      throw new StorageError("Could not open the SQLite data store.", { cause: error });
    }
  }

  async createSession(session: Session): Promise<void> {
    this.ensureOpen();
    try {
      this.database.prepare("INSERT INTO sessions (id, created_at, selected_model_config_id, extra_json) VALUES (?, ?, NULL, ?)")
        .run(session.id, session.createdAt, stringifyExtra(session, ["id", "createdAt"]));
    } catch (error) {
      throw storageFailure("Could not create the session.", error);
    }
  }

  async listSessionHistories(): Promise<SessionHistory[]> {
    this.ensureOpen();
    try {
      const sessions = this.database.prepare("SELECT id, created_at, extra_json FROM sessions ORDER BY rowid")
        .all() as SessionRow[];
      return sessions.map((row) => ({
        session: sessionFromRow(row),
        messages: this.messagesForSession(row.id),
      }));
    } catch (error) {
      throw storageFailure("Could not list sessions.", error);
    }
  }

  async appendUserMessage(sessionId: SessionId, draft: UserMessageDraft): Promise<UserMessage | null> {
    return this.appendMessage(sessionId, draft, "user") as Promise<UserMessage | null>;
  }

  async appendAssistantMessage(
    sessionId: SessionId,
    draft: AssistantMessageDraft,
  ): Promise<AssistantMessage | null> {
    return this.appendMessage(sessionId, draft, "assistant") as Promise<AssistantMessage | null>;
  }

  async completeRun(input: { run: CompletedAgentRun; assistantMessage: AssistantMessageDraft }): Promise<AssistantMessage | null> {
    this.ensureOpen();
    const { run, assistantMessage } = input;
    if (
      run.status !== "completed" || run.assistantMessageId !== assistantMessage.id ||
      run.steps.some((step) => !isAgentRunStep(step))
    ) {
      throw new StorageError("The completed run trace is invalid.");
    }

    try {
      const transaction = this.database.transaction(() => {
        const user = this.database.prepare("SELECT role FROM messages WHERE id = ? AND session_id = ?")
          .get(run.userMessageId, run.sessionId) as { role: string } | undefined;
        if (user === undefined || user.role !== "user") return null;

        const message = this.insertMessage(run.sessionId, assistantMessage, "assistant");
        this.database.prepare(`
          INSERT INTO agent_runs
            (id, session_id, user_message_id, assistant_message_id, status, started_at, completed_at,
             provider_id, provider_name, model_config_id, model_id, model_name)
          VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          run.id,
          run.sessionId,
          run.userMessageId,
          message.id,
          run.startedAt,
          run.completedAt,
          run.modelSelection?.providerId ?? null,
          run.modelSelection?.providerName ?? null,
          run.modelSelection?.modelConfigId ?? null,
          run.modelSelection?.modelId ?? null,
          run.modelSelection?.modelName ?? null,
        );

        const insertStep = this.database.prepare(
          "INSERT INTO agent_run_steps (run_id, ordinal, step_json) VALUES (?, ?, ?)",
        );
        run.steps.forEach((step, ordinal) => {
          const serialized = JSON.stringify(step);
          if (serialized === undefined) throw new StorageError("A run step could not be serialized.");
          insertStep.run(run.id, ordinal, serialized);
        });
        return message as AssistantMessage;
      });
      return transaction.immediate();
    } catch (error) {
      throw storageFailure("Could not persist the completed run.", error);
    }
  }

  async listCompletedRuns(sessionId: SessionId): Promise<CompletedAgentRun[]> {
    this.ensureOpen();
    try {
      const rows = this.database.prepare(`
        SELECT r.id, r.session_id, r.user_message_id, r.assistant_message_id, r.started_at, r.completed_at,
          r.provider_id, r.provider_name, r.model_config_id, r.model_id, r.model_name
        FROM agent_runs r
        JOIN messages m ON m.id = r.user_message_id
        WHERE r.session_id = ? AND r.status = 'completed'
        ORDER BY m.sequence, r.id
      `).all(sessionId) as RunRow[];
      const getSteps = this.database.prepare(
        "SELECT ordinal, step_json FROM agent_run_steps WHERE run_id = ? ORDER BY ordinal",
      );
      return rows.map((row) => {
        const steps = (getSteps.all(row.id) as StepRow[]).map(({ step_json }) => parseAgentRunStep(step_json));
        return {
          id: row.id,
          sessionId: row.session_id,
          userMessageId: row.user_message_id,
          assistantMessageId: row.assistant_message_id,
          status: "completed",
          startedAt: row.started_at,
          completedAt: row.completed_at,
          steps,
          ...(row.provider_id === null || row.provider_name === null || row.model_config_id === null || row.model_id === null || row.model_name === null
            ? {}
            : { modelSelection: {
              providerId: row.provider_id,
              providerName: row.provider_name,
              modelConfigId: row.model_config_id,
              modelId: row.model_id,
              modelName: row.model_name,
            } }),
        };
      });
    } catch (error) {
      throw storageFailure("Could not list completed runs.", error);
    }
  }

  async getHistory(sessionId: SessionId): Promise<SessionHistory | null> {
    this.ensureOpen();
    try {
      const row = this.database.prepare("SELECT id, created_at, extra_json FROM sessions WHERE id = ?")
        .get(sessionId) as SessionRow | undefined;
      if (row === undefined) return null;
      return { session: sessionFromRow(row), messages: this.messagesForSession(sessionId) };
    } catch (error) {
      throw storageFailure("Could not read session history.", error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  async listProviderConfigurations(): Promise<ProviderConfiguration[]> {
    this.ensureOpen();
    try {
      const rows = this.database.prepare(`
        SELECT id, name, protocol, base_url, credential_ref, allow_insecure_http, created_at, updated_at
        FROM provider_configs ORDER BY name COLLATE NOCASE, id
      `).all() as ProviderConfigurationRow[];
      return rows.map(providerConfigurationFromRow);
    } catch (error) {
      throw storageFailure("Could not list provider configurations.", error);
    }
  }

  async getProviderConfiguration(id: string): Promise<ProviderConfiguration | null> {
    this.ensureOpen();
    try {
      const row = this.database.prepare(`
        SELECT id, name, protocol, base_url, credential_ref, allow_insecure_http, created_at, updated_at
        FROM provider_configs WHERE id = ?
      `).get(id) as ProviderConfigurationRow | undefined;
      return row === undefined ? null : providerConfigurationFromRow(row);
    } catch (error) {
      throw storageFailure("Could not read provider configuration.", error);
    }
  }

  async saveProviderConfiguration(configuration: ProviderConfiguration): Promise<void> {
    this.ensureOpen();
    try {
      this.database.prepare(`
        INSERT INTO provider_configs (id, name, protocol, base_url, credential_ref, allow_insecure_http, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          protocol = excluded.protocol,
          base_url = excluded.base_url,
          credential_ref = excluded.credential_ref,
          allow_insecure_http = excluded.allow_insecure_http,
          updated_at = excluded.updated_at
      `).run(
        configuration.id,
        configuration.name,
        configuration.protocol,
        configuration.baseUrl,
        configuration.credentialRef ?? null,
        configuration.allowInsecureHttp ? 1 : 0,
        configuration.createdAt,
        configuration.updatedAt,
      );
    } catch (error) {
      throw storageFailure("Could not save provider configuration.", error);
    }
  }

  async deleteProviderConfiguration(id: string): Promise<boolean> {
    this.ensureOpen();
    try {
      return this.database.transaction(() => {
        const models = this.database.prepare("SELECT id FROM model_configs WHERE provider_id = ?").all(id) as Array<{ id: string }>;
        const removeDefault = this.database.prepare("DELETE FROM app_metadata WHERE key = 'default_model_config_id' AND value_json = ?");
        for (const model of models) removeDefault.run(JSON.stringify(model.id));
        return this.database.prepare("DELETE FROM provider_configs WHERE id = ?").run(id).changes > 0;
      }).immediate();
    } catch (error) {
      throw storageFailure("Could not delete provider configuration.", error);
    }
  }

  async listModelConfigurations(): Promise<ModelConfiguration[]> {
    this.ensureOpen();
    try {
      const rows = this.database.prepare(`
        SELECT id, provider_id, model_id, display_name, source, capabilities_json, created_at, updated_at
        FROM model_configs ORDER BY display_name COLLATE NOCASE, id
      `).all() as ModelConfigurationRow[];
      return rows.map(modelConfigurationFromRow);
    } catch (error) {
      throw storageFailure("Could not list model configurations.", error);
    }
  }

  async getModelConfiguration(id: string): Promise<ModelConfiguration | null> {
    this.ensureOpen();
    try {
      const row = this.database.prepare(`
        SELECT id, provider_id, model_id, display_name, source, capabilities_json, created_at, updated_at
        FROM model_configs WHERE id = ?
      `).get(id) as ModelConfigurationRow | undefined;
      return row === undefined ? null : modelConfigurationFromRow(row);
    } catch (error) {
      throw storageFailure("Could not read model configuration.", error);
    }
  }

  async saveModelConfiguration(configuration: ModelConfiguration): Promise<void> {
    this.ensureOpen();
    try {
      this.database.prepare(`
        INSERT INTO model_configs (id, provider_id, model_id, display_name, source, capabilities_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          display_name = excluded.display_name,
          source = excluded.source,
          capabilities_json = excluded.capabilities_json,
          updated_at = excluded.updated_at
      `).run(
        configuration.id,
        configuration.providerId,
        configuration.modelId,
        configuration.displayName,
        configuration.source,
        JSON.stringify(configuration.capabilities),
        configuration.createdAt,
        configuration.updatedAt,
      );
    } catch (error) {
      throw storageFailure("Could not save model configuration.", error);
    }
  }

  async deleteModelConfiguration(id: string): Promise<boolean> {
    this.ensureOpen();
    try {
      return this.database.transaction(() => {
        this.database.prepare("DELETE FROM app_metadata WHERE key = 'default_model_config_id' AND value_json = ?")
          .run(JSON.stringify(id));
        return this.database.prepare("DELETE FROM model_configs WHERE id = ?").run(id).changes > 0;
      }).immediate();
    } catch (error) {
      throw storageFailure("Could not delete model configuration.", error);
    }
  }

  async getDefaultModelConfigId(): Promise<string | null> {
    this.ensureOpen();
    try {
      const row = this.database.prepare("SELECT value_json FROM app_metadata WHERE key = 'default_model_config_id'")
        .get() as { value_json: string } | undefined;
      if (row === undefined) return null;
      const value = JSON.parse(row.value_json) as unknown;
      return typeof value === "string" ? value : null;
    } catch (error) {
      throw storageFailure("Could not read the default model selection.", error);
    }
  }

  async setDefaultModelConfigId(id: string | null): Promise<void> {
    this.ensureOpen();
    try {
      if (id !== null && this.database.prepare("SELECT 1 FROM model_configs WHERE id = ?").get(id) === undefined) {
        throw new StorageError("The default model configuration does not exist.");
      }
      this.database.prepare(`
        INSERT INTO app_metadata (key, value_json) VALUES ('default_model_config_id', ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `).run(JSON.stringify(id));
    } catch (error) {
      throw storageFailure("Could not save the default model selection.", error);
    }
  }

  async getSessionModelConfigId(sessionId: SessionId): Promise<string | null> {
    this.ensureOpen();
    try {
      const row = this.database.prepare("SELECT selected_model_config_id FROM sessions WHERE id = ?")
        .get(sessionId) as { selected_model_config_id: string | null } | undefined;
      return row?.selected_model_config_id ?? null;
    } catch (error) {
      throw storageFailure("Could not read the session model selection.", error);
    }
  }

  async setSessionModelConfigId(sessionId: SessionId, id: string | null): Promise<boolean> {
    this.ensureOpen();
    try {
      return this.database.prepare("UPDATE sessions SET selected_model_config_id = ? WHERE id = ?")
        .run(id, sessionId).changes > 0;
    } catch (error) {
      throw storageFailure("Could not save the session model selection.", error);
    }
  }

  private async appendMessage(
    sessionId: SessionId,
    draft: UserMessageDraft | AssistantMessageDraft,
    role: "user" | "assistant",
  ): Promise<Message | null> {
    this.ensureOpen();
    try {
      return this.database.transaction(() => {
        if (this.database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId) === undefined) return null;
        return this.insertMessage(sessionId, draft, role);
      }).immediate();
    } catch (error) {
      throw storageFailure("Could not append the message.", error);
    }
  }

  private insertMessage(
    sessionId: SessionId,
    draft: UserMessageDraft | AssistantMessageDraft,
    role: "user" | "assistant",
  ): Message {
    const sequenceRow = this.database.prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM messages WHERE session_id = ?",
    ).get(sessionId) as { next_sequence: number };
    const extra = stringifyExtra(draft, ["id", "createdAt", "text", "reasoning"]);
    const reasoning = role === "assistant" && "reasoning" in draft && draft.reasoning !== undefined
      ? JSON.stringify(draft.reasoning)
      : null;
    this.database.prepare(`
      INSERT INTO messages (id, session_id, sequence, role, content_text, created_at, reasoning_json, extra_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(draft.id, sessionId, sequenceRow.next_sequence, role, draft.text, draft.createdAt, reasoning, extra);
    return {
      id: draft.id,
      sessionId,
      sequence: sequenceRow.next_sequence,
      role,
      content: [{ type: "text", text: draft.text }],
      createdAt: draft.createdAt,
      ...(reasoning === null ? {} : { reasoning: JSON.parse(reasoning) as AssistantMessage["reasoning"] }),
    } as Message;
  }

  private messagesForSession(sessionId: SessionId): Message[] {
    const rows = this.database.prepare(`
      SELECT id, session_id, sequence, role, content_text, created_at, reasoning_json, extra_json
      FROM messages WHERE session_id = ? ORDER BY sequence
    `).all(sessionId) as MessageRow[];
    return rows.map(messageFromRow);
  }

  private initialize(database: Database.Database, dataDir: string, jsonPath: string): void {
    const versionRow = database.pragma("user_version", { simple: true }) as number;
    if (versionRow === SCHEMA_VERSION) return;
    if (versionRow === 1) {
      try {
        database.transaction(() => {
          database.exec(`
            CREATE TABLE provider_configs (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
              protocol TEXT NOT NULL CHECK (protocol = 'openai-chat-completions'),
              base_url TEXT NOT NULL,
              credential_ref TEXT,
              allow_insecure_http INTEGER NOT NULL CHECK (allow_insecure_http IN (0, 1)),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE model_configs (
              id TEXT PRIMARY KEY,
              provider_id TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
              model_id TEXT NOT NULL,
              display_name TEXT NOT NULL,
              source TEXT NOT NULL CHECK (source IN ('discovered', 'manual')),
              capabilities_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE (provider_id, model_id)
            );
            ALTER TABLE sessions ADD COLUMN selected_model_config_id TEXT REFERENCES model_configs(id) ON DELETE SET NULL;
            ALTER TABLE agent_runs ADD COLUMN provider_id TEXT;
            ALTER TABLE agent_runs ADD COLUMN provider_name TEXT;
            ALTER TABLE agent_runs ADD COLUMN model_config_id TEXT;
            ALTER TABLE agent_runs ADD COLUMN model_id TEXT;
            ALTER TABLE agent_runs ADD COLUMN model_name TEXT;
            PRAGMA user_version = ${SCHEMA_VERSION};
          `);
        }).immediate();
        return;
      } catch (error) {
        throw storageFailure("Could not migrate the SQLite data store to schema v2.", error);
      }
    }
    if (versionRow !== 0) throw new StorageError(`Unsupported SQLite schema version: ${versionRow}.`);
    const userTables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all();
    if (userTables.length > 0) throw new StorageError("The SQLite database has an unknown or incomplete schema.");

    let importedStore: StoreDocument | undefined;
    let originalJson: Buffer | undefined;
    let legacyVersion: number | undefined;
    if (existsSync(jsonPath)) {
      originalJson = readFileSync(jsonPath);
      const parsedStore = parseJsonStore(originalJson);
      importedStore = parsedStore.store;
      legacyVersion = parsedStore.sourceVersion;
      preserveJsonBackup(dataDir, originalJson, legacyVersion);
    }

    try {
      database.transaction(() => {
        database.exec(`
          CREATE TABLE provider_configs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
            protocol TEXT NOT NULL CHECK (protocol = 'openai-chat-completions'),
            base_url TEXT NOT NULL,
            credential_ref TEXT,
            allow_insecure_http INTEGER NOT NULL CHECK (allow_insecure_http IN (0, 1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE model_configs (
            id TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
            model_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('discovered', 'manual')),
            capabilities_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (provider_id, model_id)
          );
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            selected_model_config_id TEXT REFERENCES model_configs(id) ON DELETE SET NULL,
            extra_json TEXT NOT NULL DEFAULT '{}'
          );
          CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            sequence INTEGER NOT NULL CHECK (sequence > 0),
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            content_text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            reasoning_json TEXT,
            extra_json TEXT NOT NULL DEFAULT '{}',
            UNIQUE (session_id, sequence),
            UNIQUE (session_id, id)
          );
          CREATE TABLE agent_runs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            user_message_id TEXT NOT NULL UNIQUE,
            assistant_message_id TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK (status = 'completed'),
            started_at TEXT NOT NULL,
            completed_at TEXT NOT NULL,
            provider_id TEXT,
            provider_name TEXT,
            model_config_id TEXT,
            model_id TEXT,
            model_name TEXT,
            FOREIGN KEY (session_id, user_message_id) REFERENCES messages(session_id, id),
            FOREIGN KEY (session_id, assistant_message_id) REFERENCES messages(session_id, id)
          );
          CREATE TABLE agent_run_steps (
            run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
            step_json TEXT NOT NULL,
            PRIMARY KEY (run_id, ordinal)
          );
          CREATE TABLE app_metadata (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
          );
        `);
        if (importedStore !== undefined) this.importStore(database, importedStore, originalJson!, legacyVersion!);
        database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }).immediate();
    } catch (error) {
      throw storageFailure("Could not initialize or import the SQLite data store.", error);
    }
  }

  private importStore(database: Database.Database, store: StoreDocument, originalJson: Buffer, legacyVersion: number): void {
    const insertSession = database.prepare(
      "INSERT INTO sessions (id, created_at, selected_model_config_id, extra_json) VALUES (?, ?, ?, ?)",
    );
    for (const session of store.sessions) {
      insertSession.run(session.id, session.createdAt, null, stringifyExtra(session, ["id", "createdAt", "selectedModelConfigId"]));
    }
    const insertMessage = database.prepare(`
      INSERT INTO messages (id, session_id, sequence, role, content_text, created_at, reasoning_json, extra_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const message of store.messages) {
      insertMessage.run(
        message.id,
        message.sessionId,
        message.sequence,
        message.role,
        message.content[0].text,
        message.createdAt,
        message.role === "assistant" && message.reasoning !== undefined ? JSON.stringify(message.reasoning) : null,
        stringifyExtra(message, ["id", "sessionId", "sequence", "role", "content", "createdAt", "reasoning"]),
      );
    }
    for (const [key, value] of Object.entries(store)) {
      if (["formatVersion", "sessions", "messages"].includes(key)) continue;
      database.prepare("INSERT INTO app_metadata (key, value_json) VALUES (?, ?)").run(key, JSON.stringify(value));
    }
    database.prepare("INSERT INTO app_metadata (key, value_json) VALUES ('json_import', ?)")
      .run(JSON.stringify({ formatVersion: legacyVersion, byteLength: originalJson.length }));
  }

  private ensureOpen(): void {
    if (this.closed) throw new StorageError("The storage adapter is closed.");
  }
}

function parseJsonStore(contents: Buffer): { store: StoreDocument; sourceVersion: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents)) as unknown;
  } catch (error) {
    throw new StorageError("The legacy JSON data file is invalid.", { cause: error });
  }
  if (isStoreDocument(parsed)) return { store: parsed, sourceVersion: parsed.formatVersion };
  if (isPreviousStoreDocument(parsed)) {
    return { store: migrateV2ToV3(parsed as LegacyV2StoreDocument), sourceVersion: 2 };
  }
  if (isLegacyStoreDocument(parsed)) {
    return { store: migrateV1ToV3(parsed as LegacyV1StoreDocument), sourceVersion: 1 };
  }
  throw new StorageError("The legacy JSON data file has an unsupported or invalid format.");
}

function preserveJsonBackup(dataDir: string, contents: Buffer, version: number): void {
  const backupPath = join(dataDir, `store.json.v${version}.sqlite.bak`);
  try {
    writeFileSync(backupPath, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw new StorageError("Could not preserve the legacy JSON data file.", { cause: error });
    }
    if (!readFileSync(backupPath).equals(contents)) {
      throw new StorageError("The existing SQLite migration backup differs from the legacy JSON data file.");
    }
  }
}

function stringifyExtra(value: object, knownKeys: readonly string[]): string {
  const known = new Set(knownKeys);
  const extra = Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
  return JSON.stringify(extra);
}

function sessionFromRow(row: SessionRow): Session {
  return {
    ...JSON.parse(row.extra_json) as Record<string, unknown>,
    id: row.id,
    createdAt: row.created_at,
  };
}

function providerConfigurationFromRow(row: ProviderConfigurationRow): ProviderConfiguration {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    allowInsecureHttp: row.allow_insecure_http === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.credential_ref === null ? {} : { credentialRef: row.credential_ref }),
  };
}

function modelConfigurationFromRow(row: ModelConfigurationRow): ModelConfiguration {
  let capabilities: unknown;
  try {
    capabilities = JSON.parse(row.capabilities_json) as unknown;
  } catch (error) {
    throw new StorageError("A stored model capability record is invalid JSON.", { cause: error });
  }
  if (
    typeof capabilities !== "object" || capabilities === null ||
    !isModelCapabilityStatus((capabilities as Record<string, unknown>).streaming) ||
    !isModelCapabilityStatus((capabilities as Record<string, unknown>).toolCalling) ||
    !isModelCapabilityStatus((capabilities as Record<string, unknown>).reasoning) ||
    (row.source !== "discovered" && row.source !== "manual")
  ) {
    throw new StorageError("A stored model capability record has an unsupported format.");
  }
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    displayName: row.display_name,
    source: row.source,
    capabilities: capabilities as ModelConfiguration["capabilities"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isModelCapabilityStatus(value: unknown): value is ModelConfiguration["capabilities"]["streaming"] {
  return value === "unknown" || value === "supported" || value === "unsupported";
}

function messageFromRow(row: MessageRow): Message {
  const extra = JSON.parse(row.extra_json) as Record<string, unknown>;
  const common = {
    ...extra,
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    content: [{ type: "text" as const, text: row.content_text }] as [{ type: "text"; text: string }],
    createdAt: row.created_at,
  };
  if (row.role === "user") return { ...common, role: "user" } as UserMessage;
  return {
    ...common,
    role: "assistant",
    ...(row.reasoning_json === null ? {} : { reasoning: JSON.parse(row.reasoning_json) as AssistantMessage["reasoning"] }),
  } as AssistantMessage;
}

function parseAgentRunStep(serialized: string): AgentRunStep {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new StorageError("A stored run step is invalid JSON.", { cause: error });
  }
  if (!isAgentRunStep(value)) throw new StorageError("A stored run step has an unsupported format.");
  return value;
}

function isAgentRunStep(value: unknown): value is AgentRunStep {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.callIndex) || (candidate.callIndex as number) < 1) return false;
  if (candidate.type === "model") return candidate.phase === "waiting" || candidate.phase === "generating";
  if (candidate.type === "reasoning") return typeof candidate.text === "string" && candidate.text.length > 0;
  return candidate.type === "tool" &&
    typeof candidate.callId === "string" && candidate.callId.length > 0 &&
    typeof candidate.name === "string" && candidate.name.length > 0 &&
    "arguments" in candidate && typeof candidate.result === "string";
}

function storageFailure(message: string, cause: unknown): StorageError {
  return cause instanceof StorageError ? cause : new StorageError(message, { cause });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
