import type { AssistantMessage, MessageId, Session, SessionHistory, SessionId, UserMessage } from "../../core/src/session";
import type { AgentTool, ToolPermissionPolicy } from "../../core/src/agent-runtime";

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
  appendUserMessage(sessionId: SessionId, draft: UserMessageDraft): Promise<UserMessage | null>;
  appendAssistantMessage(sessionId: SessionId, draft: AssistantMessageDraft): Promise<AssistantMessage | null>;
  getHistory(sessionId: SessionId): Promise<SessionHistory | null>;
}
