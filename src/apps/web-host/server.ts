import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  AgentRuntimeError,
  createSession,
  getHistory,
  InvalidArgumentError,
  listSessions,
  runAgentTurn,
  SessionNotFoundError,
  type SessionRepository,
  type TextGenerationProvider,
} from "../../packages/application";
import { LmStudioProviderError } from "../../packages/providers/lm-studio-provider";
import { StorageError } from "../../packages/storage";

const MAX_BODY_BYTES = 64 * 1024;

interface ApiFailure {
  status: number;
  body: Record<string, unknown>;
}

export interface WebApiDependencies {
  repository: SessionRepository;
  provider: TextGenerationProvider;
}

export function createWebApiServer({ repository, provider }: WebApiDependencies): Server {
  let mutationQueue = Promise.resolve();

  const serializeMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  return createServer((request, response) => {
    void handleRequest(request, response, repository, provider, serializeMutation);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  repository: SessionRepository,
  provider: TextGenerationProvider,
  serializeMutation: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/sessions" && request.method === "GET") {
      sendJson(response, 200, { ok: true, sessions: await listSessions(repository) });
      return;
    }
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      await readJsonBody(request);
      const result = await serializeMutation(async () => ({ session: await createSession(repository) }));
      sendJson(response, 201, { ok: true, ...result });
      return;
    }

    const historyRoute = /^\/api\/sessions\/([^/]+)\/history$/.exec(url.pathname);
    if (historyRoute !== null && request.method === "GET") {
      const sessionId = decodePathSegment(historyRoute[1]);
      sendJson(response, 200, { ok: true, ...(await getHistory(repository, sessionId)) });
      return;
    }

    const messageRoute = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (messageRoute !== null && request.method === "POST") {
      const sessionId = decodePathSegment(messageRoute[1]);
      const body = await readJsonBody(request);
      if (typeof body.text !== "string") {
        throw new InvalidArgumentError("Message text must be a string.");
      }
      const runId = randomUUID();
      const result = await serializeMutation(async () => {
        try {
          const turn = await runAgentTurn(repository, provider, { sessionId, text: body.text as string, runId });
          return {
            status: 200,
            body: { ok: true, runId: turn.runId, userMessage: turn.userMessage, assistantMessage: turn.assistantMessage },
          };
        } catch (error) {
          const failure = toApiFailure(error);
          const turnId = await findFailedUserMessageId(repository, sessionId, body.text as string);
          return {
            status: failure.status,
            body: {
              ...failure.body,
              error: {
                ...(failure.body.error as Record<string, unknown>),
                runId,
                ...(turnId === undefined ? {} : { turnId }),
              },
            },
          };
        }
      });
      sendJson(response, result.status, result.body);
      return;
    }

    sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "API route not found." } });
  } catch (error) {
    const failure = toApiFailure(error);
    sendJson(response, failure.status, failure.body);
  }
}

async function findFailedUserMessageId(
  repository: SessionRepository,
  sessionId: string,
  text: string,
): Promise<string | undefined> {
  try {
    const history = await getHistory(repository, sessionId);
    const lastMessage = history.messages.at(-1);
    return lastMessage?.role === "user" && lastMessage.content[0]?.text === text
      ? lastMessage.id
      : undefined;
  } catch {
    return undefined;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpInputError("Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new HttpInputError("Request body is too large.");
    }
    chunks.push(buffer);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpInputError("Request body must contain valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpInputError("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function decodePathSegment(value: string | undefined): string {
  if (value === undefined) {
    throw new HttpInputError("Session identifier is missing.");
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpInputError("Session identifier is invalid.");
  }
}

function toApiFailure(error: unknown): ApiFailure {
  if (error instanceof HttpInputError) {
    return failure(400, "INVALID_REQUEST", error.message);
  }
  if (error instanceof InvalidArgumentError) {
    return failure(400, "INVALID_ARGUMENT", error.message);
  }
  if (error instanceof SessionNotFoundError) {
    return failure(404, "SESSION_NOT_FOUND", error.message);
  }
  if (error instanceof StorageError) {
    return failure(500, "STORAGE_ERROR", error.message);
  }
  if (error instanceof LmStudioProviderError) {
    return failure(502, "PROVIDER_ERROR", error.message);
  }
  if (error instanceof AgentRuntimeError) {
    return failure(502, error.code, error.message);
  }
  return failure(500, "INTERNAL_ERROR", "An unexpected error occurred.");
}

function failure(status: number, code: string, message: string): ApiFailure {
  return { status, body: { ok: false, error: { code, message } } };
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

class HttpInputError extends Error {}
