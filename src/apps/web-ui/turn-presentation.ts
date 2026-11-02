export type TurnPresentationStatus = "connecting" | "running" | "completed" | "failed" | "cancelled";
export type TurnStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type TurnStep =
  | { type: "model"; callIndex: number; phase: "waiting" | "generating"; status: TurnStepStatus }
  | { type: "reasoning"; callIndex: number; text: string; status: "running" | "completed" | "failed" | "cancelled" }
  | { type: "tool"; callId: string; name: string; arguments: unknown; status: TurnStepStatus; result?: string };

export interface TurnPresentation {
  status: TurnPresentationStatus;
  steps: TurnStep[];
  error?: string;
  durationMs?: number;
}

export function createTurnPresentation(): TurnPresentation {
  return { status: "connecting", steps: [] };
}

export function restoreCompletedReasoning(
  reasoning: readonly { callIndex: number; text: string }[] | undefined,
): TurnPresentation | undefined {
  if (reasoning === undefined || reasoning.length === 0) return undefined;
  return {
    status: "completed",
    steps: [...reasoning]
      .sort((left, right) => left.callIndex - right.callIndex)
      .map(({ callIndex, text }) => ({ type: "reasoning", callIndex, text, status: "completed" })),
  };
}

export function applyTurnRuntimeEvent(
  presentation: TurnPresentation,
  event: string,
  payload: Record<string, unknown>,
): TurnPresentation {
  switch (event) {
    case "model.started": {
      if (!isInteger(payload.callIndex)) return presentation;
      return {
        ...presentation,
        status: "running",
        steps: [...presentation.steps, {
          type: "model",
          callIndex: payload.callIndex,
          phase: "waiting",
          status: "running",
        }],
      };
    }
    case "assistant.delta":
      return markAssistantDelta(presentation);
    case "reasoning.delta": {
      if (!isInteger(payload.callIndex) || typeof payload.text !== "string" || payload.text.length === 0) {
        return presentation;
      }
      const existingIndex = presentation.steps.findIndex((step) => step.type === "reasoning" && step.callIndex === payload.callIndex);
      if (existingIndex < 0) {
        return {
          ...presentation,
          steps: [...presentation.steps, {
            type: "reasoning",
            callIndex: payload.callIndex,
            text: payload.text,
            status: "running",
          }],
        };
      }
      return {
        ...presentation,
        steps: presentation.steps.map((step, index) => index === existingIndex && step.type === "reasoning"
          ? { ...step, text: step.text + payload.text as string, status: "running" }
          : step),
      };
    }
    case "reasoning.completed": {
      if (!isInteger(payload.callIndex) || typeof payload.text !== "string" || payload.text.length === 0) {
        return presentation;
      }
      const existingIndex = presentation.steps.findIndex((step) => step.type === "reasoning" && step.callIndex === payload.callIndex);
      if (existingIndex < 0) {
        return {
          ...presentation,
          steps: [...presentation.steps, {
            type: "reasoning",
            callIndex: payload.callIndex,
            text: payload.text,
            status: "completed",
          }],
        };
      }
      return {
        ...presentation,
        steps: presentation.steps.map((step, index) => index === existingIndex && step.type === "reasoning"
          ? { ...step, text: payload.text as string, status: "completed" }
          : step),
      };
    }
    case "model.completed": {
      if (!isInteger(payload.callIndex)) return presentation;
      return {
        ...presentation,
        steps: presentation.steps.map((step) => step.type === "model" && step.callIndex === payload.callIndex
          ? { ...step, status: "completed" }
          : step),
      };
    }
    case "tool.requested": {
      if (typeof payload.callId !== "string" || typeof payload.name !== "string") return presentation;
      return {
        ...presentation,
        steps: [...presentation.steps, {
          type: "tool",
          callId: payload.callId,
          name: payload.name,
          arguments: payload.arguments,
          status: "pending",
        }],
      };
    }
    case "tool.started": {
      if (typeof payload.callId !== "string") return presentation;
      return {
        ...presentation,
        steps: presentation.steps.map((step) => step.type === "tool" && step.callId === payload.callId
          ? { ...step, status: "running" }
          : step),
      };
    }
    case "tool.completed": {
      if (typeof payload.callId !== "string" || typeof payload.result !== "string") return presentation;
      return {
        ...presentation,
        steps: presentation.steps.map((step) => step.type === "tool" && step.callId === payload.callId
          ? { ...step, status: "completed", result: payload.result as string }
          : step),
      };
    }
    default:
      return presentation;
  }
}

export function markAssistantDelta(presentation: TurnPresentation): TurnPresentation {
  const activeModelIndex = lastMatchingIndex(presentation.steps, (step) => step.type === "model" && step.status === "running");
  if (activeModelIndex < 0) return presentation;
  return {
    ...presentation,
    steps: presentation.steps.map((step, index) => index === activeModelIndex && step.type === "model"
      ? { ...step, phase: "generating" }
      : step),
  };
}

export function completeTurn(presentation: TurnPresentation, durationMs: number): TurnPresentation {
  return { ...presentation, status: "completed", durationMs: Math.max(0, durationMs) };
}

export function failTurn(
  presentation: TurnPresentation,
  status: "failed" | "cancelled",
  error?: string,
): TurnPresentation {
  const steps = [...presentation.steps];
  const activeIndex = lastMatchingIndex(steps, (step) =>
    (step.type === "model" || step.type === "tool") && (step.status === "pending" || step.status === "running"),
  );
  if (activeIndex >= 0) {
    const active = steps[activeIndex];
    if (active?.type === "model" || active?.type === "tool") {
      steps[activeIndex] = { ...active, status };
    }
  }
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step?.type === "reasoning" && step.status === "running") {
      steps[index] = { ...step, status };
    }
  }
  return {
    ...presentation,
    status,
    steps,
    ...(error === undefined ? {} : { error }),
  };
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function lastMatchingIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return index;
  }
  return -1;
}
