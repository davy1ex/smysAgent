import type { Session, SessionHistory, UserMessage } from "../../core/src/session";

export const STORE_FORMAT_VERSION = 1;

export interface StoreDocument {
  formatVersion: typeof STORE_FORMAT_VERSION;
  sessions: Session[];
  messages: UserMessage[];
}

export function emptyStore(): StoreDocument {
  return {
    formatVersion: STORE_FORMAT_VERSION,
    sessions: [],
    messages: [],
  };
}

export function isStoreDocument(value: unknown): value is StoreDocument {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.formatVersion !== STORE_FORMAT_VERSION ||
    !Array.isArray(candidate.sessions) ||
    !Array.isArray(candidate.messages)
  ) {
    return false;
  }

  const sessions = candidate.sessions;
  const messages = candidate.messages;
  if (!sessions.every(isSession) || !messages.every(isUserMessage)) {
    return false;
  }

  const sessionIds = new Set(sessions.map((session) => session.id));
  if (sessionIds.size !== sessions.length) {
    return false;
  }
  const messageKeys = new Set<string>();
  const messageIds = new Set<string>();
  for (const message of messages) {
    if (!sessionIds.has(message.sessionId)) {
      return false;
    }
    if (messageIds.has(message.id)) {
      return false;
    }
    const key = `${message.sessionId}:${message.sequence}`;
    if (messageKeys.has(key)) {
      return false;
    }
    messageIds.add(message.id);
    messageKeys.add(key);
  }
  return true;
}

function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && candidate.id.length > 0 && typeof candidate.createdAt === "string";
}

function isUserMessage(value: unknown): value is UserMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.sessionId !== "string" ||
    !Number.isInteger(candidate.sequence) ||
    (candidate.sequence as number) < 1 ||
    candidate.role !== "user" ||
    typeof candidate.createdAt !== "string" ||
    !Array.isArray(candidate.content) ||
    candidate.content.length !== 1
  ) {
    return false;
  }
  const content = candidate.content[0] as Record<string, unknown> | undefined;
  return content?.type === "text" && typeof content.text === "string";
}

export function toHistory(session: Session, messages: UserMessage[]): SessionHistory {
  return {
    session,
    messages: messages
      .filter((message) => message.sessionId === session.id)
      .sort((left, right) => left.sequence - right.sequence),
  };
}
