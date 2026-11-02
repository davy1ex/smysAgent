import type { AssistantMessage, UserMessage } from "../session";

export type AgentRuntimeEvent =
  | { type: "model.started"; callIndex: number }
  | { type: "model.completed"; callIndex: number }
  | { type: "reasoning.delta"; callIndex: number; text: string }
  | { type: "reasoning.completed"; callIndex: number; text: string }
  | { type: "tool.requested"; callId: string; name: string; arguments: unknown }
  | { type: "tool.started"; callId: string; name: string }
  | { type: "tool.completed"; callId: string; result: string }
  | { type: "assistant.delta"; text: string };

export type AgentEvent = AgentRuntimeEvent
  | { type: "turn.started"; runId: string; userMessage: UserMessage }
  | { type: "turn.completed"; runId: string; assistantMessage: AssistantMessage; reasoning?: string }
  | { type: "turn.failed"; runId: string; code: string };

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;
