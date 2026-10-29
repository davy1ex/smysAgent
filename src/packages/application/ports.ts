import type { AssistantMessage, MessageId, Session, SessionHistory, SessionId, UserMessage } from "../core/session";
import type { AgentTool, ToolPermissionPolicy } from "../core/agent";

export interface AgentExecutionOptions {
  tools?: readonly AgentTool[];
  permissionPolicy?: ToolPermissionPolicy;
}

export interface UserMessageDraft {
  id: MessageId;
  createdAt: string;
  text: string;
}

export interface AssistantMessageDraft {
  id: MessageId;
  createdAt: string;
  text: string;
}

export interface SessionRepository {
  createSession(session: Session): Promise<void>;
  listSessionHistories(): Promise<SessionHistory[]>;
  appendUserMessage(sessionId: SessionId, draft: UserMessageDraft): Promise<UserMessage | null>;
  appendAssistantMessage(sessionId: SessionId, draft: AssistantMessageDraft): Promise<AssistantMessage | null>;
  getHistory(sessionId: SessionId): Promise<SessionHistory | null>;
}
