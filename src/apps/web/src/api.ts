export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
}

export interface SessionRecord {
  id: string;
  createdAt: string;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  sequence: number;
  role: "user" | "assistant";
  content: [{ type: "text"; text: string }];
  createdAt: string;
}

export interface SessionHistory {
  session: SessionRecord;
  messages: SessionMessage[];
}

export interface AgentTurn {
  runId: string;
  userMessage: SessionMessage;
  assistantMessage: SessionMessage;
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

export async function createSession(): Promise<SessionRecord> {
  const result = await request<{ session: SessionRecord }>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return result.session;
}

export async function fetchHistory(sessionId: string): Promise<SessionHistory> {
  return request<SessionHistory>(`/api/sessions/${encodeURIComponent(sessionId)}/history`);
}

export async function sendMessage(sessionId: string, text: string): Promise<AgentTurn> {
  return request<AgentTurn>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
