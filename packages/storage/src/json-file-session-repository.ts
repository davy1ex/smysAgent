import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Session, SessionHistory, SessionId, UserMessage } from "../../core/src/session";
import type { SessionRepository, UserMessageDraft } from "../../application/src/ports";
import { StorageError } from "./errors";
import { emptyStore, isStoreDocument, toHistory, type StoreDocument } from "./store-format";

export class JsonFileSessionRepository implements SessionRepository {
  private closed = false;
  private readonly storePath: string;

  constructor(dataDir: string) {
    this.storePath = join(dataDir, "store.json");
  }

  async createSession(session: Session): Promise<void> {
    this.ensureOpen();
    const store = await this.readStore();
    if (store.sessions.some((existing) => existing.id === session.id)) {
      throw new StorageError("A session with this identifier already exists.");
    }
    store.sessions.push(session);
    await this.writeStore(store);
  }

  async appendUserMessage(sessionId: SessionId, draft: UserMessageDraft): Promise<UserMessage | null> {
    this.ensureOpen();
    const store = await this.readStore();
    if (!store.sessions.some((session) => session.id === sessionId)) {
      return null;
    }

    const sequence = store.messages.reduce(
      (maximum, message) => (message.sessionId === sessionId ? Math.max(maximum, message.sequence) : maximum),
      0,
    ) + 1;
    const message: UserMessage = {
      id: draft.id,
      sessionId,
      sequence,
      role: "user",
      content: [{ type: "text", text: draft.text }],
      createdAt: draft.createdAt,
    };
    store.messages.push(message);
    await this.writeStore(store);
    return message;
  }

  async getHistory(sessionId: SessionId): Promise<SessionHistory | null> {
    this.ensureOpen();
    const store = await this.readStore();
    const session = store.sessions.find((candidate) => candidate.id === sessionId);
    return session === undefined ? null : toHistory(session, store.messages);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new StorageError("The storage adapter is closed.");
    }
  }

  private async readStore(): Promise<StoreDocument> {
    try {
      const serialized = await readFile(this.storePath, "utf8");
      const parsed: unknown = JSON.parse(serialized);
      if (!isStoreDocument(parsed)) {
        throw new StorageError("The data file has an unsupported or invalid format.");
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return emptyStore();
      }
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("Could not read the data file.", { cause: error });
    }
  }

  private async writeStore(store: StoreDocument): Promise<void> {
    const directory = dirname(this.storePath);
    const temporaryPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.storePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new StorageError("Could not write the data file.", { cause: error });
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
