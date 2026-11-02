export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  selectedModelConfigId?: string;
}

export interface SessionRecord {
  id: string;
  createdAt: string;
  selectedModelConfigId?: string;
}

export type ModelCapabilityStatus = "unknown" | "supported" | "unsupported";

export interface ModelConfiguration {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  source: "discovered" | "manual";
  capabilities: { streaming: ModelCapabilityStatus; toolCalling: ModelCapabilityStatus; reasoning: ModelCapabilityStatus };
  createdAt: string;
  updatedAt: string;
}

export interface ProviderConfiguration {
  id: string;
  name: string;
  protocol: "openai-chat-completions";
  baseUrl: string;
  allowInsecureHttp: boolean;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCatalog {
  providers: ProviderConfiguration[];
  models: ModelConfiguration[];
  defaultModelConfigId: string | null;
  credentialVaultAvailable: boolean;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  sequence: number;
  role: "user" | "assistant";
  content: [{ type: "text"; text: string }];
  createdAt: string;
  reasoning?: { callIndex: number; text: string }[];
}

export type AgentRunStep =
  | { type: "model"; callIndex: number; phase: "waiting" | "generating" }
  | { type: "reasoning"; callIndex: number; text: string }
  | { type: "tool"; callIndex: number; callId: string; name: string; arguments: unknown; result: string };

export interface CompletedAgentRun {
  id: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: "completed";
  startedAt: string;
  completedAt: string;
  steps: AgentRunStep[];
  modelSelection?: { providerId: string; providerName: string; modelConfigId: string; modelId: string; modelName: string };
}

export interface SessionHistory {
  session: SessionRecord;
  messages: SessionMessage[];
  runs: CompletedAgentRun[];
}

export interface AgentTurn {
  runId: string;
  userMessage: SessionMessage;
  assistantMessage: SessionMessage;
  reasoning?: string;
}

export interface AgentTurnStreamHandlers {
  onStarted(runId: string, userMessage: SessionMessage): void;
  onTextDelta(text: string): void;
  onRuntimeEvent?(event: string, payload: Record<string, unknown>): void;
}

export class WebApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly runId?: string,
    readonly turnId?: string,
  ) {
    super(message);
    this.name = "WebApiError";
  }
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  const result = await request<{ sessions: SessionSummary[] }>("/api/sessions");
  return result.sessions;
}

export async function fetchProviderCatalog(): Promise<ProviderCatalog> {
  const result = await request<ProviderCatalog & { ok: true }>("/api/provider-config");
  return {
    providers: result.providers,
    models: result.models,
    defaultModelConfigId: result.defaultModelConfigId,
    credentialVaultAvailable: result.credentialVaultAvailable,
  };
}

export async function saveProvider(input: {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  clearApiKey?: boolean;
  allowInsecureHttp?: boolean;
}): Promise<ProviderConfiguration> {
  const { id, ...body } = input;
  const path = id === undefined ? "/api/providers" : `/api/providers/${encodeURIComponent(id)}`;
  const result = await request<{ provider: ProviderConfiguration }>(path, {
    method: id === undefined ? "POST" : "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return result.provider;
}

export async function deleteProvider(providerId: string): Promise<void> {
  await request(`/api/providers/${encodeURIComponent(providerId)}`, { method: "DELETE" });
}

export async function testProvider(providerId: string): Promise<"connected" | "discovery-unavailable"> {
  const result = await request<{ status: "connected" | "discovery-unavailable" }>(`/api/providers/${encodeURIComponent(providerId)}/test`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  return result.status;
}

export async function discoverProviderModels(providerId: string): Promise<ModelConfiguration[]> {
  const result = await request<{ models: ModelConfiguration[] }>(`/api/providers/${encodeURIComponent(providerId)}/models/discover`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  return result.models;
}

export async function addManualModel(input: { providerId: string; modelId: string; displayName?: string }): Promise<ModelConfiguration> {
  const result = await request<{ model: ModelConfiguration }>("/api/models", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  return result.model;
}

export async function deleteModel(modelConfigId: string): Promise<void> {
  await request(`/api/models/${encodeURIComponent(modelConfigId)}`, { method: "DELETE" });
}

export async function setDefaultModel(modelConfigId: string | null): Promise<void> {
  await request("/api/settings/default-model", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelConfigId }),
  });
}

export async function setSessionModel(sessionId: string, modelConfigId: string | null): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelConfigId }),
  });
}

export async function createSession(): Promise<SessionRecord> {
  const result = await request<{ session: SessionRecord }>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return result.session;
}

export async function fetchHistory(sessionId: string): Promise<SessionHistory> {
  const history = await request<{
    session: SessionRecord;
    messages: SessionMessage[];
    runs?: CompletedAgentRun[];
  }>(`/api/sessions/${encodeURIComponent(sessionId)}/history`);
  return { ...history, runs: history.runs ?? [] };
}

export async function sendMessage(sessionId: string, text: string, allowTools: readonly string[] = []): Promise<AgentTurn> {
  return request<AgentTurn>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ...(allowTools.length === 0 ? {} : { allowTools }) }),
  });
}

export async function sendMessageStream(
  sessionId: string,
  text: string,
  handlers: AgentTurnStreamHandlers,
  signal?: AbortSignal,
  allowTools: readonly string[] = [],
  modelConfigId?: string,
): Promise<AgentTurn> {
  let response: Response;
  try {
    response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ text, ...(allowTools.length === 0 ? {} : { allowTools }), ...(modelConfigId === undefined ? {} : { modelConfigId }) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    if (signal?.aborted) throw abortedError();
    throw new WebApiError("Не удалось подключиться к локальному SMYS host.", "CONNECTION_FAILED");
  }

  if (!response.ok) {
    const payload = await readJsonResponse(response);
    throw apiErrorFromPayload(payload);
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream") || response.body === null) {
    throw new WebApiError("SMYS host вернул некорректный поток ответа.", "INVALID_RESPONSE");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let runId: string | undefined;
  let turnId: string | undefined;
  let userMessage: SessionMessage | undefined;

  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = findEventBoundary(buffer);
      while (boundary !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const result = processStreamEvent(frame, handlers);
        if (result.type === "started") {
          runId = result.runId;
          turnId = result.userMessage.id;
          userMessage = result.userMessage;
        } else if (result.type === "completed") {
          if (userMessage === undefined) {
            throw new WebApiError("SMYS host завершил ход без события начала.", "INVALID_RESPONSE", runId, turnId);
          }
          void reader.cancel().catch(() => undefined);
          return {
            runId: result.runId,
            userMessage,
            assistantMessage: result.assistantMessage,
            ...(result.reasoning === undefined ? {} : { reasoning: result.reasoning }),
          };
        }
        boundary = findEventBoundary(buffer);
      }
    }
    buffer += decoder.decode();
  } catch (cause) {
    if (cause instanceof WebApiError) throw cause;
    if (signal?.aborted) throw abortedError(runId, turnId);
    throw new WebApiError("Поток ответа прервался до завершения хода.", "STREAM_INTERRUPTED", runId, turnId);
  } finally {
    reader.releaseLock();
  }

  throw new WebApiError("Поток ответа прервался до завершения хода.", "STREAM_INTERRUPTED", runId, turnId);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new WebApiError("Не удалось подключиться к локальному SMYS host.", "CONNECTION_FAILED");
  }

  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new WebApiError("SMYS host вернул некорректный ответ.", "INVALID_RESPONSE");
  }

  if (!response.ok) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
    throw new WebApiError(
      typeof error.message === "string" ? error.message : "Не удалось выполнить запрос.",
      typeof error.code === "string" ? error.code : "REQUEST_FAILED",
      typeof error.runId === "string" ? error.runId : undefined,
      typeof error.turnId === "string" ? error.turnId : undefined,
    );
  }
  if (!isRecord(payload) || payload.ok !== true) {
    throw new WebApiError("SMYS host вернул некорректный ответ.", "INVALID_RESPONSE");
  }
  return payload as T;
}

type ParsedStreamEvent =
  | { type: "started"; runId: string; userMessage: SessionMessage }
  | { type: "delta" }
  | { type: "completed"; runId: string; assistantMessage: SessionMessage; reasoning?: string }
  | { type: "ignored" };

function processStreamEvent(frame: string, handlers: AgentTurnStreamHandlers): ParsedStreamEvent {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return { type: "ignored" };

  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join("\n")) as unknown;
  } catch {
    throw new WebApiError("SMYS host передал некорректное событие потока.", "INVALID_RESPONSE");
  }
  if (!isRecord(payload)) {
    throw new WebApiError("SMYS host передал некорректное событие потока.", "INVALID_RESPONSE");
  }
  if (eventName === "turn.failed") {
    const error = isRecord(payload.error) ? payload.error : {};
    throw new WebApiError(
      typeof error.message === "string" ? error.message : "Не удалось выполнить запрос.",
      typeof error.code === "string" ? error.code : "REQUEST_FAILED",
      typeof error.runId === "string" ? error.runId : undefined,
      typeof error.turnId === "string" ? error.turnId : undefined,
    );
  }
  if (eventName === "turn.started") {
    if (typeof payload.runId !== "string" || !isSessionMessage(payload.userMessage)) {
      throw new WebApiError("SMYS host передал некорректное событие начала хода.", "INVALID_RESPONSE");
    }
    handlers.onStarted(payload.runId, payload.userMessage);
    return { type: "started", runId: payload.runId, userMessage: payload.userMessage };
  }
  if (eventName === "assistant.delta") {
    if (typeof payload.text !== "string") {
      throw new WebApiError("SMYS host передал некорректный фрагмент ответа.", "INVALID_RESPONSE");
    }
    handlers.onTextDelta(payload.text);
    return { type: "delta" };
  }
  if (eventName === "turn.completed") {
    if (typeof payload.runId !== "string" || !isSessionMessage(payload.assistantMessage) || payload.assistantMessage.role !== "assistant") {
      throw new WebApiError("SMYS host передал некорректное событие завершения хода.", "INVALID_RESPONSE");
    }
    return {
      type: "completed",
      runId: payload.runId,
      assistantMessage: payload.assistantMessage,
      ...(typeof payload.reasoning === "string" ? { reasoning: payload.reasoning } : {}),
    };
  }
  if (["model.started", "model.completed", "reasoning.delta", "reasoning.completed", "tool.requested", "tool.started", "tool.completed"].includes(eventName)) {
    handlers.onRuntimeEvent?.(eventName, payload);
    return { type: "ignored" };
  }
  return { type: "ignored" };
}

function isSessionMessage(value: unknown): value is SessionMessage {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.sequence !== "number" ||
    (value.role !== "user" && value.role !== "assistant") ||
    !Array.isArray(value.content) ||
    value.content.length !== 1 ||
    !isRecord(value.content[0]) ||
    value.content[0].type !== "text" ||
    typeof value.content[0].text !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return false;
  }
  return value.reasoning === undefined || (value.role === "assistant" && isAssistantReasoning(value.reasoning));
}

function isAssistantReasoning(value: unknown): value is NonNullable<SessionMessage["reasoning"]> {
  if (!Array.isArray(value)) return false;
  let previousCallIndex = 0;
  return value.every((entry) => {
    if (!isRecord(entry) || typeof entry.callIndex !== "number" || !Number.isInteger(entry.callIndex) || entry.callIndex <= previousCallIndex ||
      typeof entry.text !== "string" || entry.text.length === 0) return false;
    previousCallIndex = entry.callIndex;
    return true;
  });
}

function findEventBoundary(value: string): { index: number; length: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(value);
  return match === null ? null : { index: match.index, length: match[0].length };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw new WebApiError("SMYS host вернул некорректный ответ.", "INVALID_RESPONSE");
  }
}

function apiErrorFromPayload(payload: unknown): WebApiError {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
  return new WebApiError(
    typeof error.message === "string" ? error.message : "Не удалось выполнить запрос.",
    typeof error.code === "string" ? error.code : "REQUEST_FAILED",
    typeof error.runId === "string" ? error.runId : undefined,
    typeof error.turnId === "string" ? error.turnId : undefined,
  );
}

function abortedError(runId?: string, turnId?: string): WebApiError {
  return new WebApiError("Генерация остановлена.", "ABORTED", runId, turnId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
