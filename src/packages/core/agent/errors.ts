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
  constructor(readonly code: AgentRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRuntimeError";
  }
}
