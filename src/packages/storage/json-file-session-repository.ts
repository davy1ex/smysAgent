import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import type {
  AssistantMessage,
  Message,
  Session,
  SessionHistory,
  SessionId,
  UserMessage,
} from "../core/session";
import type { AssistantMessageDraft, SessionRepository, UserMessageDraft } from "../application/ports";
import { StorageError } from "./errors";
import {
  emptyStore,
  isLegacyStoreDocument,
  isStoreDocument,
  migrateV1ToV2,
  toHistory,
  type StoreDocument,
} from "./store-format";

type LoadedStore =
  | { store: StoreDocument; needsMigration: false }
  | { store: StoreDocument; needsMigration: true; originalContents: Buffer };

export class JsonFileSessionRepository implements SessionRepository {
  private closed = false;
  private readonly storePath: string;
  private readonly legacyBackupPath: string;

  constructor(dataDir: string) {
    this.storePath = join(dataDir, "store.json");
    this.legacyBackupPath = join(dataDir, "store.json.v1.bak");
  }

  async createSession(session: Session): Promise<void> {
    this.ensureOpen();
    const loaded = await this.readStore();
    if (loaded.store.sessions.some((existing) => existing.id === session.id)) {
      throw new StorageError("A session with this identifier already exists.");
    }
    loaded.store.sessions.push(session);
    await this.writeStore(loaded.store, loaded);
  }

  async listSessionHistories(): Promise<SessionHistory[]> {
    this.ensureOpen();
    const loaded = await this.readStore();
    return loaded.store.sessions.map((session) => toHistory(session, loaded.store.messages));
  }

  async appendUserMessage(sessionId: SessionId, draft: UserMessageDraft): Promise<UserMessage | null> {
    return (await this.appendMessage(sessionId, draft, "user")) as UserMessage | null;
  }

  async appendAssistantMessage(
    sessionId: SessionId,
    draft: AssistantMessageDraft,
  ): Promise<AssistantMessage | null> {
    return (await this.appendMessage(sessionId, draft, "assistant")) as AssistantMessage | null;
  }

  async getHistory(sessionId: SessionId): Promise<SessionHistory | null> {
    this.ensureOpen();
    const loaded = await this.readStore();
    const session = loaded.store.sessions.find((candidate) => candidate.id === sessionId);
    return session === undefined ? null : toHistory(session, loaded.store.messages);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async appendMessage(
    sessionId: SessionId,
    draft: UserMessageDraft | AssistantMessageDraft,
    role: "user" | "assistant",
  ): Promise<Message | null> {
    this.ensureOpen();
    const loaded = await this.readStore();
    const { store } = loaded;
    if (!store.sessions.some((session) => session.id === sessionId)) {
      return null;
    }

    const sequence = store.messages.reduce(
      (maximum, message) => (message.sessionId === sessionId ? Math.max(maximum, message.sequence) : maximum),
      0,
    ) + 1;
    const common = {
      id: draft.id,
      sessionId,
      sequence,
      content: [{ type: "text" as const, text: draft.text }] as [{ type: "text"; text: string }],
      createdAt: draft.createdAt,
    };
    const message: Message = role === "user"
      ? { ...common, role: "user" }
      : { ...common, role: "assistant" };
    store.messages.push(message);
    await this.writeStore(store, loaded);
    return message;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new StorageError("The storage adapter is closed.");
    }
  }

  private async readStore(): Promise<LoadedStore> {
    try {
      const originalContents = await readFile(this.storePath);
      const serialized = new TextDecoder("utf-8", { fatal: true }).decode(originalContents);
      const parsed: unknown = JSON.parse(serialized);
      if (isStoreDocument(parsed)) {
        return { store: parsed, needsMigration: false };
      }
      if (isLegacyStoreDocument(parsed)) {
        return {
          store: migrateV1ToV2(parsed),
          needsMigration: true,
          originalContents,
        };
      }
      throw new StorageError("The data file has an unsupported or invalid format.");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { store: emptyStore(), needsMigration: false };
      }
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("Could not read the data file.", { cause: error });
    }
  }

  private async writeStore(store: StoreDocument, loaded: LoadedStore): Promise<void> {
    const directory = dirname(this.storePath);
    const temporaryPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (loaded.needsMigration) {
        await this.preserveLegacyStore(loaded.originalContents);
      }
      await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.storePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("Could not write the data file.", { cause: error });
    }
  }

  private async preserveLegacyStore(contents: Buffer): Promise<void> {
    try {
      await writeFile(this.legacyBackupPath, contents, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw new StorageError("Could not preserve the version 1 data file.", { cause: error });
      }
      try {
        const existingBackup = await readFile(this.legacyBackupPath);
        if (!existingBackup.equals(contents)) {
          throw new StorageError("The existing version 1 backup differs from the data file.");
        }
      } catch (backupError) {
        if (backupError instanceof StorageError) {
          throw backupError;
        }
        throw new StorageError("Could not verify the existing version 1 backup.", { cause: backupError });
      }
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
