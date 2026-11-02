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

export type AgentRunStep =
  | { type: "model"; callIndex: number; phase: "waiting" | "generating" }
  | { type: "reasoning"; callIndex: number; text: string }
  | { type: "tool"; callIndex: number; callId: string; name: string; arguments: unknown; result: string };

export interface CompletedAgentRun {
  id: string;
  sessionId: SessionId;
  userMessageId: MessageId;
  assistantMessageId: MessageId;
  status: "completed";
  startedAt: string;
  completedAt: string;
  steps: AgentRunStep[];
}

export interface AgentRunRepository {
  /** Atomically appends the final assistant message and its completed run trace. */
  completeRun(input: { run: CompletedAgentRun; assistantMessage: AssistantMessageDraft }): Promise<AssistantMessage | null>;
  listCompletedRuns(sessionId: SessionId): Promise<CompletedAgentRun[]>;
}

export type ApplicationRepository = SessionRepository & AgentRunRepository;
