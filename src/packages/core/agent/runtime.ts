import type { Message, SessionId } from "../session";
import type { AgentEventHandler, AgentRuntimeEvent } from "./events";
import { AgentRuntimeError } from "./errors";
import type {
  ModelMessage,
  ModelResponse,
  StreamingTextGenerationProvider,
  TextGenerationProvider,
} from "./model";
import type { AgentTool, ToolCall, ToolPermissionPolicy } from "./tool";

export interface AgentTurnResult {
  text: string;
  reasoning?: string;
}

export interface AgentRuntimeOptions {
  sessionId: SessionId;
  tools?: readonly AgentTool[];
  permissionPolicy?: ToolPermissionPolicy;
  onEvent?: AgentEventHandler;
}

export interface AgentTextStreamOptions extends AgentRuntimeOptions {
  onTextDelta(text: string): void | Promise<void>;
  signal?: AbortSignal;
}

const MAX_MODEL_CALLS = 2;
const MAX_AVAILABLE_TOOLS = 1;
const MAX_TOOL_EXECUTIONS = 1;

export async function runAgentTurn(
  messages: readonly Message[],
  provider: TextGenerationProvider,
  options: AgentRuntimeOptions,
): Promise<AgentTurnResult> {
  const tools = validateConfiguration(options);
  const conversation = createModelConversation(messages);
  const reasoningParts: string[] = [];
  let toolExecutions = 0;

  for (let modelCall = 0; modelCall < MAX_MODEL_CALLS; modelCall += 1) {
    const callIndex = modelCall + 1;
    await emitEvent(options.onEvent, { type: "model.started", callIndex });
    const response = await provider.generate({
      messages: [...conversation],
      tools: toolExecutions < MAX_TOOL_EXECUTIONS ? tools.map((tool) => tool.definition) : [],
    });

    await collectReasoning(response, reasoningParts, callIndex, options.onEvent);
    if (response.kind === "final") {
      const result = createTurnResult(response, reasoningParts);
      await emitEvent(options.onEvent, { type: "model.completed", callIndex });
      return result;
    }
    if (response.kind !== "tool-call") {
      throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The model provider returned an invalid response.");
    }

    validateToolCallIdentity(response);
    await emitEvent(options.onEvent, { type: "model.completed", callIndex });
    await emitEvent(options.onEvent, {
      type: "tool.requested",
      callId: response.callId,
      name: response.name,
      arguments: response.arguments,
    });
    if (modelCall + 1 >= MAX_MODEL_CALLS || toolExecutions >= MAX_TOOL_EXECUTIONS) {
      throw new AgentRuntimeError("LOOP_LIMIT", "The agent turn exceeded its tool-call limit.");
    }

    const toolCall: ToolCall = {
      callId: response.callId,
      name: response.name,
      arguments: response.arguments,
    };
    const result = await executeToolCall(response, tools, options);
    appendToolExchange(conversation, toolCall, result);
    toolExecutions += 1;
  }

  throw new AgentRuntimeError("LOOP_LIMIT", "The agent turn exceeded its model-call limit.");
}

export async function streamAgentTurn(
  messages: readonly Message[],
  provider: StreamingTextGenerationProvider,
  options: AgentTextStreamOptions,
): Promise<AgentTurnResult> {
  if ((options.tools?.length ?? 0) > 0) {
    throw new AgentRuntimeError("INVALID_CONFIGURATION", "Streaming turns do not support tools.");
  }
  validateConfiguration(options);
  options.signal?.throwIfAborted();

  const conversation = createModelConversation(messages);
  const textParts: string[] = [];
  await emitEvent(options.onEvent, { type: "model.started", callIndex: 1 });
  for await (const delta of provider.streamText({ messages: conversation, tools: [] }, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })) {
    options.signal?.throwIfAborted();
    if (typeof delta !== "string") {
      throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The model provider returned an invalid text chunk.");
    }
    if (delta.length === 0) continue;
    textParts.push(delta);
    await options.onTextDelta(delta);
    await emitEvent(options.onEvent, { type: "assistant.delta", text: delta });
  }
  options.signal?.throwIfAborted();

  const text = textParts.join("");
  if (text.length === 0) {
    throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The model provider returned an empty response.");
  }
  await emitEvent(options.onEvent, { type: "model.completed", callIndex: 1 });
  return { text };
}

function validateConfiguration(options: AgentRuntimeOptions): readonly AgentTool[] {
  const tools = options.tools ?? [];
  if (tools.length > MAX_AVAILABLE_TOOLS) {
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
  return tools;
}

function createModelConversation(messages: readonly Message[]): ModelMessage[] {
  return messages.map((message) => {
    const content = message.content;
    const textPart = content?.[0];
    if (content?.length !== 1 || textPart?.type !== "text" || typeof textPart.text !== "string") {
      throw new AgentRuntimeError("INVALID_CONFIGURATION", "The agent runtime requires exactly one text part per message.");
    }
    return { role: message.role, content: textPart.text };
  });
}

async function collectReasoning(
  response: ModelResponse,
  reasoningParts: string[],
  callIndex: number,
  onEvent: AgentEventHandler | undefined,
): Promise<void> {
  if (typeof response !== "object" || response === null) {
    throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The model provider returned an invalid response.");
  }
  if (response.reasoning !== undefined) {
    if (typeof response.reasoning !== "string") {
      throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The model provider returned invalid reasoning.");
    }
    if (response.reasoning.length > 0) {
      reasoningParts.push(response.reasoning);
      await emitEvent(onEvent, {
        type: "reasoning.completed",
        callIndex,
        text: response.reasoning,
      });
    }
  }
}

function createTurnResult(
  response: Extract<ModelResponse, { kind: "final" }>,
  reasoningParts: readonly string[],
): AgentTurnResult {
  if (typeof response.text !== "string" || response.text.length === 0) {
    throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The model provider returned an empty response.");
  }
  return {
    text: response.text,
    ...(reasoningParts.length > 0 ? { reasoning: reasoningParts.join("\n\n") } : {}),
  };
}

function validateToolCallIdentity(response: Extract<ModelResponse, { kind: "tool-call" }>): void {
  if (
    typeof response.callId !== "string" || response.callId.length === 0 ||
    typeof response.name !== "string" || response.name.length === 0
  ) {
    throw new AgentRuntimeError("INVALID_MODEL_RESPONSE", "The model provider returned an invalid tool call.");
  }
}

async function executeToolCall(
  response: Extract<ModelResponse, { kind: "tool-call" }>,
  tools: readonly AgentTool[],
  options: AgentRuntimeOptions,
): Promise<string> {
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

  await emitEvent(options.onEvent, { type: "tool.started", callId: response.callId, name: response.name });
  let result: string;
  try {
    result = await tool.execute(response.arguments, { sessionId: options.sessionId });
  } catch (cause) {
    throw new AgentRuntimeError("TOOL_EXECUTION_FAILED", "Tool execution failed.", { cause });
  }
  if (typeof result !== "string") {
    throw new AgentRuntimeError("TOOL_EXECUTION_FAILED", "Tool execution returned an invalid result.");
  }
  await emitEvent(options.onEvent, { type: "tool.completed", callId: response.callId, result });
  return result;
}

async function emitEvent(
  onEvent: AgentEventHandler | undefined,
  event: AgentRuntimeEvent,
): Promise<void> {
  await onEvent?.(event);
}

function appendToolExchange(conversation: ModelMessage[], toolCall: ToolCall, result: string): void {
  conversation.push({ role: "assistant", toolCall });
  conversation.push({
    role: "tool",
    callId: toolCall.callId,
    name: toolCall.name,
    content: result,
  });
}
