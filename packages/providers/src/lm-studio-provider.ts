import type {
  ModelMessage,
  ModelRequest,
  ModelResponse,
  TextGenerationProvider,
  ToolDefinition,
} from "../../core/src/agent-runtime";

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

export class LmStudioProvider implements TextGenerationProvider {
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
