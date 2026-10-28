import type { Message, SessionId } from "./session";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  callId: string;
  name: string;
  arguments: unknown;
}

export type ModelMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; toolCall: ToolCall }
  | { role: "tool"; callId: string; name: string; content: string };

export interface ModelRequest {
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
}

export type ModelResponse =
  | { kind: "final"; text: string }
  | { kind: "tool-call"; callId: string; name: string; arguments: unknown };

export interface TextGenerationProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export interface AgentTool {
  definition: ToolDefinition;
  validateInput(input: unknown): boolean;
  execute(input: unknown, context: { sessionId: SessionId }): Promise<string>;
}

export interface ToolPermissionRequest {
  sessionId: SessionId;
  toolName: string;
  input: unknown;
}

export interface ToolPermissionPolicy {
  authorize(request: ToolPermissionRequest): Promise<"allow" | "deny">;
}

export interface AgentRuntimeOptions {
  sessionId: SessionId;
  tools?: readonly AgentTool[];
  permissionPolicy?: ToolPermissionPolicy;
}

export type AgentRuntimeErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_MODEL_RESPONSE"
  | "UNKNOWN_TOOL"
  | "INVALID_TOOL_ARGUMENTS"
  | "PERMISSION_DENIED"
  | "PERMISSION_CHECK_FAILED"
  | "TOOL_EXECUTION_FAILED"
  | "LOOP_LIMIT";

export class AgentRuntimeError extends Error {
  constructor(readonly code: AgentRuntimeErrorCode, message: string) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

const MAX_MODEL_CALLS = 2;
const MAX_TOOL_CALLS = 1;

export async function runAgentTurn(
  messages: readonly Message[],
  provider: TextGenerationProvider,
  options: AgentRuntimeOptions,
): Promise<string> {
  const tools = options.tools ?? [];
  if (tools.length > MAX_TOOL_CALLS) {
    throw new AgentRuntimeError("INVALID_CONFIGURATION", "An agent turn can expose at most one tool.");
  }
  if (tools.some((tool) =>
    typeof tool.definition?.name !== "string" || tool.definition.name.length === 0 ||
    typeof tool.definition.inputSchema !== "object" || tool.definition.inputSchema === null ||
    typeof tool.validateInput !== "function" || typeof tool.execute !== "function"
  )) {
    throw new AgentRuntimeError("INVALID_CONFIGURATION", "A tool definition or implementation is invalid.");
  }
  if (tools.length > 0 && options.permissionPolicy === undefined) {
    throw new AgentRuntimeError("INVALID_CONFIGURATION", "A permission policy is required when tools are available.");
  }

  const conversation: ModelMessage[] = messages.map((message) => ({
    role: message.role,
    content: message.content[0].text,
  }));
  let toolCalls = 0;

  for (let modelCall = 0; modelCall < MAX_MODEL_CALLS; modelCall += 1) {
    const response = await provider.generate({
      messages: [...conversation],
      tools: toolCalls < MAX_TOOL_CALLS ? tools.map((tool) => tool.definition) : [],
    });

    if (typeof response !== "object" || response === null) {
      throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The model provider returned an invalid response.");
    }
    if (response.kind === "final") {
      if (typeof response.text !== "string" || response.text.length === 0) {
        throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The model provider returned an empty response.");
      }
      return response.text;
    }
    if (response.kind !== "tool-call") {
      throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The model provider returned an invalid response.");
    }
    if (modelCall + 1 >= MAX_MODEL_CALLS || toolCalls >= MAX_TOOL_CALLS) {
      throw new AgentRuntimeError("LOOP_LIMIT", "The agent turn exceeded its tool-call limit.");
    }
    if (
      typeof response.callId !== "string" || response.callId.length === 0 ||
      typeof response.name !== "string" || response.name.length === 0
    ) {
      throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The model provider returned an invalid tool call.");
    }

    const tool = tools.find((candidate) => candidate.definition.name === response.name);
    if (tool === undefined) {
      throw new AgentRuntimeError("UNKNOWN_TOOL", "The model requested an unavailable tool.");
    }
    let validInput = false;
    try {
      validInput = tool.validateInput(response.arguments);
    } catch {
      validInput = false;
    }
    if (!validInput) {
      throw new AgentRuntimeError("INVALID_TOOL_ARGUMENTS", "Tool arguments did not pass validation.");
    }

    let permission: "allow" | "deny";
    try {
      permission = await options.permissionPolicy!.authorize({
        sessionId: options.sessionId,
        toolName: response.name,
        input: response.arguments,
      });
    } catch {
      throw new AgentRuntimeError("PERMISSION_CHECK_FAILED", "The tool permission check failed.");
    }
    if (permission !== "allow") {
      throw new AgentRuntimeError("PERMISSION_DENIED", "The tool call was denied.");
    }

    let result: string;
    try {
      result = await tool.execute(response.arguments, { sessionId: options.sessionId });
    } catch {
      throw new AgentRuntimeError("TOOL_EXECUTION_FAILED", "Tool execution failed.");
    }
    if (typeof result !== "string") {
      throw new AgentRuntimeError("TOOL_EXECUTION_FAILED", "Tool execution returned an invalid result.");
    }

    conversation.push({
      role: "assistant",
      toolCall: { callId: response.callId, name: response.name, arguments: response.arguments },
    });
    conversation.push({ role: "tool", callId: response.callId, name: response.name, content: result });
    toolCalls += 1;
  }

  throw new AgentRuntimeError("LOOP_LIMIT", "The agent turn exceeded its model-call limit.");
}
