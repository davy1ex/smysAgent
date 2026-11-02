import type { AssistantMessage, AssistantReasoning, MessageId, Session, SessionHistory, SessionId, UserMessage } from "../core/session";
import type { AgentEventHandler, AgentTool, ToolPermissionPolicy } from "../core/agent";
import type { TextGenerationProvider } from "../core/agent";

export type ModelCapabilityStatus = "unknown" | "supported" | "unsupported";

export interface ModelCapabilities {
  streaming: ModelCapabilityStatus;
  toolCalling: ModelCapabilityStatus;
  reasoning: ModelCapabilityStatus;
}

export interface ProviderConfiguration {
  id: string;
  name: string;
  protocol: "openai-chat-completions";
  baseUrl: string;
  credentialRef?: string;
  allowInsecureHttp: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConfiguration {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  source: "discovered" | "manual";
  capabilities: ModelCapabilities;
  createdAt: string;
  updatedAt: string;
}

export interface ModelSelectionSnapshot {
  providerId: string;
  providerName: string;
  modelConfigId: string;
  modelId: string;
  modelName: string;
}

export interface ProviderConfigurationRepository {
  listProviderConfigurations(): Promise<ProviderConfiguration[]>;
  getProviderConfiguration(id: string): Promise<ProviderConfiguration | null>;
  saveProviderConfiguration(configuration: ProviderConfiguration): Promise<void>;
  deleteProviderConfiguration(id: string): Promise<boolean>;
  listModelConfigurations(): Promise<ModelConfiguration[]>;
  getModelConfiguration(id: string): Promise<ModelConfiguration | null>;
  saveModelConfiguration(configuration: ModelConfiguration): Promise<void>;
  deleteModelConfiguration(id: string): Promise<boolean>;
  getDefaultModelConfigId(): Promise<string | null>;
  getSessionModelConfigId(sessionId: SessionId): Promise<string | null>;
  setDefaultModelConfigId(id: string | null): Promise<void>;
  setSessionModelConfigId(sessionId: SessionId, id: string | null): Promise<boolean>;
}

export interface CredentialStore {
  save(reference: string, secret: string): Promise<void>;
  get(reference: string): Promise<string | null>;
  delete(reference: string): Promise<void>;
}

export interface OpenAICompatibleProviderFactory {
  create(input: { baseUrl: string; modelId: string; apiToken?: string }): TextGenerationProvider;
  testConnection(input: { baseUrl: string; apiToken?: string }): Promise<"connected" | "discovery-unavailable">;
  discoverModels(input: { baseUrl: string; apiToken?: string }): Promise<string[]>;
}

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
  modelSelection?: ModelSelectionSnapshot;
}

export interface AgentRunRepository {
  /** Atomically appends the final assistant message and its completed run trace. */
  completeRun(input: { run: CompletedAgentRun; assistantMessage: AssistantMessageDraft }): Promise<AssistantMessage | null>;
  listCompletedRuns(sessionId: SessionId): Promise<CompletedAgentRun[]>;
}

export type ApplicationRepository = SessionRepository & AgentRunRepository;
