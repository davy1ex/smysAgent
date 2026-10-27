import type { MessageId, Session, SessionHistory, SessionId, UserMessage } from "../../core/src/session";

export interface UserMessageDraft {
  id: MessageId;
  createdAt: string;
  text: string;
}

export interface SessionRepository {
  createSession(session: Session): Promise<void>;
  appendUserMessage(sessionId: SessionId, draft: UserMessageDraft): Promise<UserMessage | null>;
  getHistory(sessionId: SessionId): Promise<SessionHistory | null>;
}
