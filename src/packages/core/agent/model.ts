import type { ToolCall, ToolDefinition } from "./tool";

export type ModelMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; toolCall: ToolCall }
  | { role: "tool"; callId: string; name: string; content: string };

export interface ModelRequest {
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
}

export type ModelResponse =
  | { kind: "final"; text: string; reasoning?: string }
  | { kind: "tool-call"; callId: string; name: string; arguments: unknown; reasoning?: string };

export type ModelTextDeltaHandler = (text: string) => void | Promise<void>;

export interface ModelGenerationOptions {
  signal?: AbortSignal;
  onTextDelta?: ModelTextDeltaHandler;
}

export interface TextGenerationProvider {
  generate(request: ModelRequest, options?: ModelGenerationOptions): Promise<ModelResponse>;
}
