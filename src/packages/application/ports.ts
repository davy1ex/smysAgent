import type { AssistantMessage, AssistantReasoning, MessageId, Session, SessionHistory, SessionId, UserMessage } from "../core/session";
import type { AgentEventHandler, AgentTool, ToolPermissionPolicy } from "../core/agent";

export interface AgentExecutionOptions {
  tools?: readonly AgentTool[];
  permissionPolicy?: ToolPermissionPolicy;
  onEvent?: AgentEventHandler;
  onTextDelta?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
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
  reasoning?: AssistantReasoning[];
}

export interface SessionRepository {
  createSession(session: Session): Promise<void>;
  listSessionHistories(): Promise<SessionHistory[]>;
  appendUserMessage(sessionId: SessionId, draft: UserMessageDraft): Promise<UserMessage | null>;
  appendAssistantMessage(sessionId: SessionId, draft: AssistantMessageDraft): Promise<AssistantMessage | null>;
  getHistory(sessionId: SessionId): Promise<SessionHistory | null>;
}
