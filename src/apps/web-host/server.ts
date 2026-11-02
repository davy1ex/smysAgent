import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  AgentRuntimeError,
  createSession,
  deleteModelConfiguration,
  deleteProviderConfiguration,
  discoverConfiguredProviderModels,
  executeTurn,
  getProviderCatalog,
  getHistory,
  getSessionTrajectory,
  InvalidArgumentError,
  listSessions,
  resolveModelForRun,
  saveModelConfiguration,
  saveProviderConfiguration,
  setDefaultModelConfiguration,
  setSessionModelConfiguration,
  SessionNotFoundError,
  testConfiguredProviderConnection,
  type AgentTool,
  type ApplicationRepository,
  type CredentialStore,
  type OpenAICompatibleProviderFactory,
  type ProviderConfigurationRepository,
  type TextGenerationProvider,
} from "../../packages/application";
import { LmStudioProviderError, OpenAICompatibleProviderError } from "../../packages/providers/lm-studio-provider";
import { CredentialVaultError } from "../../packages/providers/macos-credential-store";
import { StorageError } from "../../packages/storage";

const MAX_BODY_BYTES = 64 * 1024;

interface ApiFailure {
  status: number;
  body: Record<string, unknown>;
}

export interface WebApiDependencies {
  repository: ApplicationRepository & ProviderConfigurationRepository;
  provider: TextGenerationProvider;
  fallbackModelSelection?: { providerId: string; providerName: string; modelConfigId: string; modelId: string; modelName: string };
  providerFactory?: OpenAICompatibleProviderFactory;
  credentialStore?: CredentialStore;
  tools?: readonly AgentTool[];
}

export function createWebApiServer({
  repository,
  provider,
  fallbackModelSelection,
  providerFactory,
  credentialStore,
  tools = [],
}: WebApiDependencies): Server {
  let mutationQueue = Promise.resolve();

  const serializeMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  return createServer((request, response) => {
    void handleRequest(request, response, repository, provider, fallbackModelSelection, providerFactory, credentialStore, tools, serializeMutation);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  repository: ApplicationRepository & ProviderConfigurationRepository,
  provider: TextGenerationProvider,
  fallbackModelSelection: WebApiDependencies["fallbackModelSelection"],
  providerFactory: WebApiDependencies["providerFactory"],
  credentialStore: WebApiDependencies["credentialStore"],
  availableTools: readonly AgentTool[],
  serializeMutation: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<void> {
  try {
    assertLocalRequest(request);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/provider-config" && request.method === "GET") {
      sendJson(response, 200, { ok: true, credentialVaultAvailable: process.platform === "darwin", ...(await getProviderCatalog(repository)) });
      return;
    }
    if (url.pathname === "/api/providers" && request.method === "POST") {
      const body = await readJsonBody(request);
      const saved = await serializeMutation(() => saveProviderConfiguration(repository, requireCredentialStore(credentialStore), parseProviderInput(body)));
      sendJson(response, 201, { ok: true, provider: saved });
      return;
    }
    const providerRoute = /^\/api\/providers\/([^/]+)$/.exec(url.pathname);
    if (providerRoute !== null && request.method === "PUT") {
      const providerId = decodePathSegment(providerRoute[1]);
      const body = await readJsonBody(request);
      const saved = await serializeMutation(() => saveProviderConfiguration(
        repository,
        requireCredentialStore(credentialStore),
        { ...parseProviderInput(body), id: providerId },
      ));
      sendJson(response, 200, { ok: true, provider: saved });
      return;
    }
    if (providerRoute !== null && request.method === "DELETE") {
      const providerId = decodePathSegment(providerRoute[1]);
      const deleted = await serializeMutation(() => deleteProviderConfiguration(repository, requireCredentialStore(credentialStore), providerId));
      if (!deleted) throw new InvalidArgumentError("Provider configuration was not found.");
      sendJson(response, 200, { ok: true });
      return;
    }
    const providerTestRoute = /^\/api\/providers\/([^/]+)\/test$/.exec(url.pathname);
    if (providerTestRoute !== null && request.method === "POST") {
      await readJsonBody(request);
      const status = await testConfiguredProviderConnection(
        repository,
        requireCredentialStore(credentialStore),
        requireProviderFactory(providerFactory),
        decodePathSegment(providerTestRoute[1]),
      );
      sendJson(response, 200, { ok: true, status });
      return;
    }
    const providerModelsRoute = /^\/api\/providers\/([^/]+)\/models\/discover$/.exec(url.pathname);
    if (providerModelsRoute !== null && request.method === "POST") {
      await readJsonBody(request);
      const models = await serializeMutation(() => discoverConfiguredProviderModels(
        repository,
        requireCredentialStore(credentialStore),
        requireProviderFactory(providerFactory),
        decodePathSegment(providerModelsRoute[1]),
      ));
      sendJson(response, 200, { ok: true, models });
      return;
    }
    if (url.pathname === "/api/models" && request.method === "POST") {
      const body = await readJsonBody(request);
      const model = await serializeMutation(() => saveModelConfiguration(repository, {
        providerId: requiredString(body.providerId, "providerId"),
        modelId: requiredString(body.modelId, "modelId"),
        ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
      }));
      sendJson(response, 201, { ok: true, model });
      return;
    }
    const modelRoute = /^\/api\/models\/([^/]+)$/.exec(url.pathname);
    if (modelRoute !== null && request.method === "DELETE") {
      const deleted = await serializeMutation(() => deleteModelConfiguration(repository, decodePathSegment(modelRoute[1])));
      if (!deleted) throw new InvalidArgumentError("Model configuration was not found.");
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/settings/default-model" && request.method === "PUT") {
      const body = await readJsonBody(request);
      await serializeMutation(() => setDefaultModelConfiguration(repository, optionalNullableString(body.modelConfigId, "modelConfigId")));
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/sessions" && request.method === "GET") {
      sendJson(response, 200, { ok: true, sessions: await listSessions(repository, repository) });
      return;
    }
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      await readJsonBody(request);
      const result = await serializeMutation(async () => ({ session: await createSession(repository) }));
      sendJson(response, 201, { ok: true, ...result });
      return;
    }

    const sessionModelRoute = /^\/api\/sessions\/([^/]+)\/model$/.exec(url.pathname);
    if (sessionModelRoute !== null && request.method === "PATCH") {
      const sessionId = decodePathSegment(sessionModelRoute[1]);
      const body = await readJsonBody(request);
      await serializeMutation(() => setSessionModelConfiguration(repository, sessionId, optionalNullableString(body.modelConfigId, "modelConfigId")));
      sendJson(response, 200, { ok: true });
      return;
    }

    const historyRoute = /^\/api\/sessions\/([^/]+)\/history$/.exec(url.pathname);
    if (historyRoute !== null && request.method === "GET") {
      const sessionId = decodePathSegment(historyRoute[1]);
      sendJson(response, 200, { ok: true, ...(await getSessionTrajectory(repository, sessionId)) });
      return;
    }

    const streamRoute = /^\/api\/sessions\/([^/]+)\/messages\/stream$/.exec(url.pathname);
    if (streamRoute !== null && request.method === "POST") {
      const sessionId = decodePathSegment(streamRoute[1]);
      const body = await readJsonBody(request);
      if (typeof body.text !== "string") {
        throw new InvalidArgumentError("Message text must be a string.");
      }
      const allowedTools = resolveAllowedTools(body.allowTools, availableTools);
      const modelConfigId = optionalString(body.modelConfigId, "modelConfigId");
      const runId = randomUUID();
      const abortController = new AbortController();
      const abortOnRequest = () => abortController.abort();
      const abortOnResponseClose = () => {
        if (!response.writableEnded) abortController.abort();
      };
      request.once("aborted", abortOnRequest);
      response.once("close", abortOnResponseClose);
      try {
        await serializeMutation(() => streamTurnResponse(
          repository,
          provider,
          fallbackModelSelection,
          providerFactory,
          credentialStore,
          sessionId,
          body.text as string,
          modelConfigId,
          allowedTools,
          runId,
          response,
          abortController.signal,
        ));
      } finally {
        request.off("aborted", abortOnRequest);
        response.off("close", abortOnResponseClose);
      }
      return;
    }

    const messageRoute = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (messageRoute !== null && request.method === "POST") {
      const sessionId = decodePathSegment(messageRoute[1]);
      const body = await readJsonBody(request);
      if (typeof body.text !== "string") {
        throw new InvalidArgumentError("Message text must be a string.");
      }
      const allowedTools = resolveAllowedTools(body.allowTools, availableTools);
      const modelConfigId = optionalString(body.modelConfigId, "modelConfigId");
      const runId = randomUUID();
      const result = await serializeMutation(async () => {
        try {
          const resolved = await resolveModelForRunIfConfigured(
            repository, provider, fallbackModelSelection, providerFactory, credentialStore, sessionId, modelConfigId,
          );
          const turn = await executeTurn(
            repository,
            resolved.provider,
            { sessionId, text: body.text as string, runId, ...(resolved.modelSelection === undefined ? {} : { modelSelection: resolved.modelSelection }) },
            createWebAgentOptions(allowedTools),
          );
          return {
            status: 200,
            body: {
              ok: true,
              runId: turn.runId,
              userMessage: turn.userMessage,
              assistantMessage: turn.assistantMessage,
              ...(turn.reasoning === undefined ? {} : { reasoning: turn.reasoning }),
            },
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

async function streamTurnResponse(
  repository: ApplicationRepository & ProviderConfigurationRepository,
  provider: TextGenerationProvider,
  fallbackModelSelection: WebApiDependencies["fallbackModelSelection"],
  providerFactory: WebApiDependencies["providerFactory"],
  credentialStore: WebApiDependencies["credentialStore"],
  sessionId: string,
  text: string,
  modelConfigId: string | undefined,
  allowedTools: readonly AgentTool[],
  runId: string,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed) return;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
  response.flushHeaders();
  let turnId: string | undefined;

  try {
    const resolved = await resolveModelForRunIfConfigured(
      repository, provider, fallbackModelSelection, providerFactory, credentialStore, sessionId, modelConfigId,
    );
    await executeTurn(
      repository,
      resolved.provider,
      { sessionId, text, runId, ...(resolved.modelSelection === undefined ? {} : { modelSelection: resolved.modelSelection }) },
      {
        ...createWebAgentOptions(allowedTools),
        signal,
        onTextDelta: () => undefined,
        onEvent: async (event) => {
          if (event.type === "turn.failed") return;
          if (event.type === "turn.started") turnId = event.userMessage.id;
          const { type, ...payload } = event;
          await writeSse(response, signal, type, { ...payload, runId });
        },
      },
    );
  } catch (error) {
    if (signal.aborted || response.destroyed) return;
    const failure = toApiFailure(error);
    const apiError = failure.body.error as Record<string, unknown>;
    await writeSse(response, signal, "turn.failed", {
      runId,
      error: {
        ...apiError,
        runId,
        ...(turnId === undefined ? {} : { turnId }),
      },
    });
  } finally {
    if (!response.destroyed && !response.writableEnded) response.end();
  }
}

function createWebAgentOptions(allowedTools: readonly AgentTool[]) {
  if (allowedTools.length === 0) return {};
  const allowedNames = new Set(allowedTools.map((tool) => tool.definition.name));
  return {
    tools: allowedTools,
    permissionPolicy: {
      async authorize(request: { toolName: string }) {
        return allowedNames.has(request.toolName) ? "allow" as const : "deny" as const;
      },
    },
  };
}

function resolveAllowedTools(value: unknown, availableTools: readonly AgentTool[]): readonly AgentTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string") || new Set(value).size !== value.length) {
    throw new InvalidArgumentError("allowTools must be an array of unique tool names.");
  }
  const byName = new Map(availableTools.map((tool) => [tool.definition.name, tool]));
  const selected: AgentTool[] = [];
  for (const name of value as string[]) {
    const tool = byName.get(name);
    if (tool === undefined) {
      throw new InvalidArgumentError(`Tool is not available: ${name}`);
    }
    selected.push(tool);
  }
  return selected;
}

async function writeSse(
  response: ServerResponse,
  signal: AbortSignal,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  signal.throwIfAborted();
  if (response.destroyed || response.writableEnded) return;
  if (!response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)) {
    await waitForDrain(response, signal);
  }
}

function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDrain, rejectDrain) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolveDrain();
    };
    const onAbort = () => {
      cleanup();
      rejectDrain(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
    };
    response.once("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function findFailedUserMessageId(
  repository: ApplicationRepository,
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

function assertLocalRequest(request: IncomingMessage): void {
  const hostValue = request.headers.host;
  if (typeof hostValue !== "string") throw new HttpSecurityError("The request Host header is required.");
  let host: URL;
  try {
    host = new URL(`http://${hostValue}`);
  } catch {
    throw new HttpSecurityError("The request Host header is invalid.");
  }
  if (!isLoopbackHostname(host.hostname)) throw new HttpSecurityError("The Web API accepts loopback requests only.");

  const originValue = request.headers.origin;
  if (originValue === undefined) return;
  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    throw new HttpSecurityError("The request Origin header is invalid.");
  }
  if (!isLoopbackHostname(origin.hostname) || origin.host.toLowerCase() !== hostValue.toLowerCase()) {
    throw new HttpSecurityError("Cross-origin requests are not allowed.");
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseProviderInput(body: Record<string, unknown>) {
  const name = requiredString(body.name, "name");
  const baseUrl = requiredString(body.baseUrl, "baseUrl");
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") throw new InvalidArgumentError("apiKey must be a string.");
  if (body.clearApiKey !== undefined && typeof body.clearApiKey !== "boolean") throw new InvalidArgumentError("clearApiKey must be a boolean.");
  if (body.allowInsecureHttp !== undefined && typeof body.allowInsecureHttp !== "boolean") {
    throw new InvalidArgumentError("allowInsecureHttp must be a boolean.");
  }
  return {
    name,
    baseUrl,
    ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey as string }),
    ...(body.clearApiKey === true ? { clearApiKey: true } : {}),
    ...(body.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: body.allowInsecureHttp as boolean }),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new InvalidArgumentError(`${field} must be a string.`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new InvalidArgumentError(`${field} must be a non-empty string.`);
  return value;
}

function optionalNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function requireCredentialStore(value: CredentialStore | undefined): CredentialStore {
  if (value === undefined) throw new CredentialVaultError("Credential vault is not configured for this host.");
  return value;
}

function requireProviderFactory(value: OpenAICompatibleProviderFactory | undefined): OpenAICompatibleProviderFactory {
  if (value === undefined) throw new HttpInputError("OpenAI-compatible provider management is unavailable.");
  return value;
}

async function resolveModelForRunIfConfigured(
  repository: ApplicationRepository & ProviderConfigurationRepository,
  fallbackProvider: TextGenerationProvider,
  fallbackModelSelection: WebApiDependencies["fallbackModelSelection"],
  providerFactory: WebApiDependencies["providerFactory"],
  credentialStore: WebApiDependencies["credentialStore"],
  sessionId: string,
  requestedModelConfigId: string | undefined,
): Promise<{ provider: TextGenerationProvider; modelSelection?: WebApiDependencies["fallbackModelSelection"] }> {
  if (providerFactory !== undefined && credentialStore !== undefined) {
    const resolved = await resolveModelForRun(repository, credentialStore, providerFactory, {
      sessionId,
      ...(requestedModelConfigId === undefined ? {} : { requestedModelConfigId }),
    });
    if (resolved !== null) return { provider: resolved.provider, modelSelection: resolved.snapshot };
  } else if (requestedModelConfigId !== undefined) {
    throw new HttpInputError("Configured model execution is unavailable on this host.");
  }
  return {
    provider: fallbackProvider,
    ...(fallbackModelSelection === undefined ? {} : { modelSelection: fallbackModelSelection }),
  };
}

function toApiFailure(error: unknown): ApiFailure {
  if (error instanceof HttpSecurityError) {
    return failure(403, "ORIGIN_FORBIDDEN", error.message);
  }
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
  if (error instanceof CredentialVaultError) {
    return failure(503, "CREDENTIAL_VAULT_UNAVAILABLE", error.message);
  }
  if (error instanceof OpenAICompatibleProviderError) {
    if (error instanceof LmStudioProviderError) return failure(502, "PROVIDER_ERROR", error.message);
    const code = error.message.toLowerCase().includes("authorization")
      ? "PROVIDER_AUTH_ERROR"
      : error.message.toLowerCase().includes("timed out")
        ? "PROVIDER_TIMEOUT"
        : error.message.toLowerCase().includes("could not connect")
          ? "PROVIDER_CONNECTION_ERROR"
          : "PROVIDER_ERROR";
    return failure(error.message.includes("authorization") ? 401 : code === "PROVIDER_TIMEOUT" ? 504 : 502, code, error.message);
  }
  if (error instanceof AgentRuntimeError) {
    return failure(502, error.code, error.message);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return failure(502, "ABORTED", "Turn was cancelled.");
  }
  return failure(500, "INTERNAL_ERROR", "An unexpected error occurred.");
}

function failure(status: number, code: string, message: string): ApiFailure {
  return { status, body: { ok: false, error: { code, message } } };
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

class HttpInputError extends Error {}
class HttpSecurityError extends Error {}
