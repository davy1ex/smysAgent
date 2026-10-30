import type {
  ModelMessage,
  ModelRequest,
  ModelResponse,
  StreamingTextGenerationProvider,
  TextGenerationProvider,
  ToolDefinition,
} from "../core/agent";

export interface LmStudioProviderOptions {
  endpoint: string;
  model: string;
  apiToken?: string;
  fetcher?: typeof fetch;
}

export class LmStudioProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LmStudioProviderError";
  }
}

export class LmStudioProvider implements TextGenerationProvider, StreamingTextGenerationProvider {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: LmStudioProviderOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
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
        headers,
        body: JSON.stringify(body),
      });
    } catch {
      throw new LmStudioProviderError("Could not connect to LM Studio.");
    }

    if (!response.ok) {
      throw new LmStudioProviderError(`LM Studio returned HTTP ${response.status}.`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LmStudioProviderError("LM Studio returned an invalid chat completion response.");
    }

    const modelResponse = getModelResponse(payload);
    if (modelResponse === null) {
      throw new LmStudioProviderError("LM Studio returned an invalid chat completion response.");
    }
    return modelResponse;
  }

  async *streamText(request: ModelRequest, options: { signal?: AbortSignal } = {}): AsyncIterable<string> {
    if (request.tools.length > 0) {
      throw new LmStudioProviderError("LM Studio text streaming does not support tools.");
    }
    options.signal?.throwIfAborted();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiToken !== undefined && this.options.apiToken.length > 0) {
      headers.authorization = `Bearer ${this.options.apiToken}`;
    }

    let response: Response;
    try {
      response = await this.fetcher(this.options.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.options.model,
          messages: request.messages.map(toLmStudioMessage),
          stream: true,
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      options.signal?.throwIfAborted();
      throw new LmStudioProviderError("Could not connect to LM Studio.");
    }

    if (!response.ok) {
      throw new LmStudioProviderError(`LM Studio returned HTTP ${response.status}.`);
    }
    if (response.body === null) {
      throw new LmStudioProviderError("LM Studio returned an invalid text stream.");
    }

    let receivedDone = false;
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
          throw new LmStudioProviderError("LM Studio returned an invalid text stream.");
        }
        const delta = getTextDelta(payload);
        if (delta === null) {
          throw new LmStudioProviderError("LM Studio returned an invalid text stream.");
        }
        if (delta.length > 0) yield delta;
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof LmStudioProviderError) throw error;
      throw new LmStudioProviderError("LM Studio text stream ended unexpectedly.");
    }
    options.signal?.throwIfAborted();
    if (!receivedDone) {
      throw new LmStudioProviderError("LM Studio text stream ended unexpectedly.");
    }
  }
}

async function* readSseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bodyEnded = false;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
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

function getTextDelta(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if ("error" in record) return null;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const firstChoice = choices[0];
  if (typeof firstChoice !== "object" || firstChoice === null) return null;
  const delta = (firstChoice as Record<string, unknown>).delta;
  if (typeof delta !== "object" || delta === null) return null;
  const deltaRecord = delta as Record<string, unknown>;
  if ("tool_calls" in deltaRecord || "function_call" in deltaRecord) return null;
  if (deltaRecord.content === undefined || deltaRecord.content === null) return "";
  return typeof deltaRecord.content === "string" ? deltaRecord.content : null;
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
