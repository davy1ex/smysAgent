import type {
  ModelGenerationOptions,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  TextGenerationProvider,
  ToolDefinition,
} from "../core/agent";

export interface LmStudioProviderOptions {
  endpoint: string;
  model: string;
  apiToken?: string;
  fetcher?: typeof fetch;
}

export interface OpenAICompatibleProviderOptions {
  endpoint: string;
  model: string;
  apiToken?: string;
  fetcher?: typeof fetch;
}

export class OpenAICompatibleProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAICompatibleProviderError";
  }
}

export class LmStudioProviderError extends OpenAICompatibleProviderError {
  constructor(message: string) {
    super(message);
    this.name = "LmStudioProviderError";
  }
}

export class OpenAICompatibleProvider implements TextGenerationProvider {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly options: OpenAICompatibleProviderOptions,
    private readonly makeError: (message: string) => OpenAICompatibleProviderError = (message) => new OpenAICompatibleProviderError(message),
  ) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async generate(request: ModelRequest, options: ModelGenerationOptions = {}): Promise<ModelResponse> {
    options.signal?.throwIfAborted();
    if (options.onTextDelta !== undefined || options.onReasoningDelta !== undefined) {
      return this.generateStreaming(request, options);
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiToken !== undefined && this.options.apiToken.length > 0) {
      headers.authorization = `Bearer ${this.options.apiToken}`;
    }

    const body = {
      model: this.options.model,
      messages: request.messages.map(toLmStudioMessage),
      stream: false,
      ...(request.tools.length > 0
        ? { tools: request.tools.map(toLmStudioTool), tool_choice: "auto" }
        : {}),
    };

    let response: Response;
    try {
      response = await this.fetcher(this.options.endpoint, {
        method: "POST",
        redirect: "manual",
        headers,
        body: JSON.stringify(body),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      options.signal?.throwIfAborted();
      throw this.providerError("Could not connect to the configured provider.");
    }

    if (!response.ok) {
      throw this.providerError(`Provider returned HTTP ${response.status}.`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw this.providerError("Provider returned an invalid chat completion response.");
    }

    const modelResponse = getModelResponse(payload);
    if (modelResponse === null) {
      throw this.providerError("Provider returned an invalid chat completion response.");
    }
    return modelResponse;
  }

  private async generateStreaming(request: ModelRequest, options: ModelGenerationOptions): Promise<ModelResponse> {
    options.signal?.throwIfAborted();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiToken !== undefined && this.options.apiToken.length > 0) {
      headers.authorization = `Bearer ${this.options.apiToken}`;
    }

    let response: Response;
    try {
      response = await this.fetcher(this.options.endpoint, {
        method: "POST",
        redirect: "manual",
        headers,
        body: JSON.stringify({
          model: this.options.model,
          messages: request.messages.map(toLmStudioMessage),
          stream: true,
          ...(request.tools.length > 0
            ? { tools: request.tools.map(toLmStudioTool), tool_choice: "auto" }
            : {}),
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      options.signal?.throwIfAborted();
      throw this.providerError("Could not connect to the configured provider.");
    }

    if (!response.ok) {
      throw this.providerError(`Provider returned HTTP ${response.status}.`);
    }
    if (response.body === null) {
      throw this.providerError("Provider returned an invalid chat completion stream.");
    }

    let receivedDone = false;
    let callbackFailed = false;
    let callbackFailure: unknown;
    let text = "";
    let reasoning = "";
    const toolCalls = new Map<number, StreamToolCall>();
    try {
      for await (const data of readSseData(response.body, options.signal)) {
        options.signal?.throwIfAborted();
        if (data === "[DONE]") {
          receivedDone = true;
          break;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(data) as unknown;
        } catch {
          throw this.providerError("Provider returned an invalid chat completion stream.");
        }
        const delta = getStreamDelta(payload);
        if (delta === null) {
          throw this.providerError("Provider returned an invalid chat completion stream.");
        }
        if (delta.reasoning.length > 0) {
          reasoning += delta.reasoning;
          try {
            await options.onReasoningDelta?.(delta.reasoning);
          } catch (error) {
            callbackFailed = true;
            callbackFailure = error;
            throw error;
          }
        }
        if (delta.text.length > 0) {
          text += delta.text;
          try {
            await options.onTextDelta?.(delta.text);
          } catch (error) {
            callbackFailed = true;
            callbackFailure = error;
            throw error;
          }
        }
        for (const call of delta.toolCalls) {
          const current = toolCalls.get(call.index) ?? {
            id: "",
            type: "",
            name: "",
            arguments: "",
          };
          current.id += call.id;
          current.type += call.type;
          current.name += call.name;
          current.arguments += call.arguments;
          toolCalls.set(call.index, current);
        }
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (callbackFailed) throw callbackFailure;
      if (error instanceof OpenAICompatibleProviderError) throw error;
      throw this.providerError("Provider chat completion stream ended unexpectedly.");
    }
    options.signal?.throwIfAborted();
    if (!receivedDone) {
      throw this.providerError("Provider chat completion stream ended unexpectedly.");
    }
    if (toolCalls.size > 1) {
      throw this.providerError("Provider returned an invalid tool call in the streaming response.");
    }
    const reasoningField = reasoning.length > 0 ? { reasoning } : {};
    const [toolCall] = toolCalls.values();
    if (toolCall !== undefined) {
      if (text.length > 0 || toolCall.type !== "function" || toolCall.id.length === 0 || toolCall.name.length === 0) {
        throw this.providerError("Provider returned an invalid tool call in the streaming response.");
      }
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(toolCall.arguments) as unknown;
      } catch {
        throw this.providerError("Provider returned an invalid tool call in the streaming response.");
      }
      return {
        kind: "tool-call",
        callId: toolCall.id,
        name: toolCall.name,
        arguments: argumentsValue,
        ...reasoningField,
      };
    }
    if (text.length === 0) {
      throw this.providerError("Provider returned an invalid chat completion stream.");
    }
    return { kind: "final", text, ...reasoningField };
  }

  private providerError(message: string): OpenAICompatibleProviderError {
    return this.makeError(message);
  }
}

export class LmStudioProvider extends OpenAICompatibleProvider {
  constructor(options: LmStudioProviderOptions) {
    super(options, (message) => new LmStudioProviderError(toLmStudioErrorMessage(message)));
  }
}

export class OpenAICompatibleProviderFactory {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 10_000, private readonly maxDiscoveryBytes = 1_048_576) {}

  create(input: { baseUrl: string; modelId: string; apiToken?: string }): OpenAICompatibleProvider {
    const baseUrl = normalizeProviderBaseUrl(input.baseUrl);
    return new OpenAICompatibleProvider({
      endpoint: appendEndpoint(baseUrl, "chat/completions"),
      model: input.modelId,
      fetcher: this.fetcher,
      ...(input.apiToken === undefined ? {} : { apiToken: input.apiToken }),
    });
  }

  async testConnection(input: { baseUrl: string; apiToken?: string }): Promise<"connected" | "discovery-unavailable"> {
    const response = await this.requestModels(input);
    if (response.status === 404 || response.status === 405) return "discovery-unavailable";
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenAICompatibleProviderError(`Provider rejected authorization (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenAICompatibleProviderError(`Provider returned HTTP ${response.status} during connection test.`);
    }
    try {
      const payload = await readJsonBodyLimited(response, this.maxDiscoveryBytes);
      return isModelsPayload(payload) ? "connected" : "discovery-unavailable";
    } catch (error) {
      if (error instanceof OpenAICompatibleProviderError) return "discovery-unavailable";
      throw error;
    }
  }

  async discoverModels(input: { baseUrl: string; apiToken?: string }): Promise<string[]> {
    const response = await this.requestModels(input);
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenAICompatibleProviderError(`Provider rejected authorization (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenAICompatibleProviderError(response.status === 404 || response.status === 405
        ? "Provider does not support model discovery; enter a Model ID manually."
        : `Provider returned HTTP ${response.status} while listing models.`);
    }
    const payload = await readJsonBodyLimited(response, this.maxDiscoveryBytes);
    if (!isModelsPayload(payload)) throw new OpenAICompatibleProviderError("Provider returned an invalid models response.");
    const ids = payload.data
      .map((item) => typeof item === "object" && item !== null ? (item as Record<string, unknown>).id : undefined)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
    if (ids.length > 500) throw new OpenAICompatibleProviderError("Provider returned too many models to display.");
    return [...new Set(ids)];
  }

  private async requestModels(input: { baseUrl: string; apiToken?: string }): Promise<Response> {
    const baseUrl = normalizeProviderBaseUrl(input.baseUrl);
    const headers: Record<string, string> = { accept: "application/json" };
    if (input.apiToken !== undefined) headers.authorization = `Bearer ${input.apiToken}`;
    try {
      return await this.fetcher(appendEndpoint(baseUrl, "models"), {
        method: "GET",
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new OpenAICompatibleProviderError("Provider connection test timed out.");
      }
      throw new OpenAICompatibleProviderError("Could not connect to the configured provider.");
    }
  }
}

function toLmStudioErrorMessage(message: string): string {
  return message
    .replace("Could not connect to the configured provider.", "Could not connect to LM Studio.")
    .replace(/^Provider returned /, "LM Studio returned ")
    .replace(/^Provider chat /, "LM Studio chat ");
}

function normalizeProviderBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new OpenAICompatibleProviderError("Base URL must be an absolute HTTP or HTTPS URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0
  ) {
    throw new OpenAICompatibleProviderError("Base URL must use HTTP or HTTPS and must not contain credentials, query, or fragment.");
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

function appendEndpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl}/${suffix}`;
}

async function readJsonBodyLimited(response: Response, maxBytes: number): Promise<unknown> {
  if (response.body === null) throw new OpenAICompatibleProviderError("Provider returned an empty models response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new OpenAICompatibleProviderError("Provider models response exceeded the size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new OpenAICompatibleProviderError("Provider returned an invalid models response.");
  }
}

function isModelsPayload(value: unknown): value is { data: unknown[] } {
  return typeof value === "object" && value !== null && Array.isArray((value as Record<string, unknown>).data);
}

interface StreamToolCall {
  id: string;
  type: string;
  name: string;
  arguments: string;
}

async function* readSseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bodyEnded = false;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await readWithSignal(reader, signal);
      if (done) {
        bodyEnded = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = findSseBoundary(buffer);
      while (boundary !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = parseSseData(frame);
        if (data !== null) yield data;
        boundary = findSseBoundary(buffer);
      }
    }
    buffer += decoder.decode();
  } finally {
    if (!bodyEnded) {
      await reader.cancel(signal?.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) return reader.read();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function findSseBoundary(value: string): { index: number; length: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(value);
  return match === null ? null : { index: match.index, length: match[0].length };
}

function parseSseData(frame: string): string | null {
  const dataLines = frame.split(/\r\n|\n|\r/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return dataLines.length === 0 ? null : dataLines.join("\n");
}

function getStreamDelta(payload: unknown): {
  text: string;
  reasoning: string;
  toolCalls: Array<{ index: number; id: string; type: string; name: string; arguments: string }>;
} | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if ("error" in record) return null;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const firstChoice = choices[0];
  if (typeof firstChoice !== "object" || firstChoice === null) return null;
  const choice = firstChoice as Record<string, unknown>;
  const delta = choice.delta;
  if ((delta === undefined || delta === null) && choice.finish_reason !== null && choice.finish_reason !== undefined) {
    return { text: "", reasoning: "", toolCalls: [] };
  }
  if (typeof delta !== "object" || delta === null) return null;
  const deltaRecord = delta as Record<string, unknown>;
  if ("function_call" in deltaRecord) return null;
  let text = "";
  if (deltaRecord.content !== undefined && deltaRecord.content !== null) {
    if (typeof deltaRecord.content !== "string") return null;
    text = deltaRecord.content;
  }
  const reasoning = typeof deltaRecord.reasoning_content === "string" ? deltaRecord.reasoning_content : "";
  const toolCalls: Array<{ index: number; id: string; type: string; name: string; arguments: string }> = [];
  if (deltaRecord.tool_calls !== undefined) {
    if (!Array.isArray(deltaRecord.tool_calls)) return null;
    for (const part of deltaRecord.tool_calls) {
      if (typeof part !== "object" || part === null) return null;
      const call = part as Record<string, unknown>;
      if (typeof call.index !== "number" || !Number.isInteger(call.index) || call.index < 0) return null;
      const fn = call.function;
      if (fn !== undefined && (typeof fn !== "object" || fn === null)) return null;
      const functionRecord = (fn ?? {}) as Record<string, unknown>;
      if (
        (call.id !== undefined && typeof call.id !== "string") ||
        (call.type !== undefined && typeof call.type !== "string") ||
        (functionRecord.name !== undefined && typeof functionRecord.name !== "string") ||
        (functionRecord.arguments !== undefined && typeof functionRecord.arguments !== "string")
      ) return null;
      toolCalls.push({
        index: call.index,
        id: typeof call.id === "string" ? call.id : "",
        type: typeof call.type === "string" ? call.type : "",
        name: typeof functionRecord.name === "string" ? functionRecord.name : "",
        arguments: typeof functionRecord.arguments === "string" ? functionRecord.arguments : "",
      });
    }
  }
  return { text, reasoning, toolCalls };
}

function toLmStudioMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "assistant" && "toolCall" in message) {
    return {
      role: "assistant",
      tool_calls: [{
        id: message.toolCall.callId,
        type: "function",
        function: {
          name: message.toolCall.name,
          arguments: JSON.stringify(message.toolCall.arguments),
        },
      }],
    };
  }
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.callId, content: message.content };
  }
  return { role: message.role, content: message.content };
}

function toLmStudioTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function getModelResponse(payload: unknown): ModelResponse | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const firstChoice = choices[0];
  if (typeof firstChoice !== "object" || firstChoice === null) {
    return null;
  }
  const message = (firstChoice as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const reasoning = typeof candidate.reasoning_content === "string" && candidate.reasoning_content.length > 0
    ? candidate.reasoning_content
    : undefined;
  if ("tool_calls" in candidate && candidate.tool_calls !== undefined) {
    if (!Array.isArray(candidate.tool_calls) || candidate.tool_calls.length > 1) {
      return null;
    }
    if (candidate.tool_calls.length === 0) {
      return typeof candidate.content === "string" && candidate.content.length > 0
        ? { kind: "final", text: candidate.content, ...(reasoning === undefined ? {} : { reasoning }) }
        : null;
    }
    const toolCall = candidate.tool_calls[0];
    if (typeof toolCall !== "object" || toolCall === null) {
      return null;
    }
    const toolCallRecord = toolCall as Record<string, unknown>;
    const functionCall = toolCallRecord.function;
    if (
      toolCallRecord.type !== "function" ||
      typeof toolCallRecord.id !== "string" ||
      toolCallRecord.id.length === 0 ||
      typeof functionCall !== "object" ||
      functionCall === null
    ) {
      return null;
    }
    const functionRecord = functionCall as Record<string, unknown>;
    if (typeof functionRecord.name !== "string" || functionRecord.name.length === 0 || typeof functionRecord.arguments !== "string") {
      return null;
    }
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(functionRecord.arguments) as unknown;
    } catch {
      return null;
    }
    return {
      kind: "tool-call",
      callId: toolCallRecord.id,
      name: functionRecord.name,
      arguments: argumentsValue,
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }

  return typeof candidate.content === "string" && candidate.content.length > 0
    ? { kind: "final", text: candidate.content, ...(reasoning === undefined ? {} : { reasoning }) }
    : null;
}
