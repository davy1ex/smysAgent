import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentRunStep,
  ApplicationRepository,
  AssistantMessageDraft,
  CompletedAgentRun,
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

const SCHEMA_VERSION = 1;

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
}

interface StepRow {
  ordinal: number;
  step_json: string;
}

export class SqliteApplicationRepository implements ApplicationRepository {
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
      this.database.prepare("INSERT INTO sessions (id, created_at, extra_json) VALUES (?, ?, ?)")
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
            (id, session_id, user_message_id, assistant_message_id, status, started_at, completed_at)
          VALUES (?, ?, ?, ?, 'completed', ?, ?)
        `).run(run.id, run.sessionId, run.userMessageId, message.id, run.startedAt, run.completedAt);

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
        SELECT r.id, r.session_id, r.user_message_id, r.assistant_message_id, r.started_at, r.completed_at
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
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
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
      "INSERT INTO sessions (id, created_at, extra_json) VALUES (?, ?, ?)",
    );
    for (const session of store.sessions) {
      insertSession.run(session.id, session.createdAt, stringifyExtra(session, ["id", "createdAt"]));
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
