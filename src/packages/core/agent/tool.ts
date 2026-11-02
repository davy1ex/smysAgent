import type { SessionId } from "../session";

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

export interface AgentTool {
  definition: ToolDefinition;
  validateInput(input: unknown): boolean;
  execute(input: unknown, context: { sessionId: SessionId; signal?: AbortSignal }): Promise<string>;
}

export interface ToolPermissionRequest {
  sessionId: SessionId;
  toolName: string;
  input: unknown;
  signal?: AbortSignal;
}

export interface ToolPermissionPolicy {
  authorize(request: ToolPermissionRequest): Promise<"allow" | "deny">;
}
