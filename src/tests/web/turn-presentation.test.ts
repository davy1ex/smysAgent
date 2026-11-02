import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTurnRuntimeEvent,
  completeTurn,
  createTurnPresentation,
  failTurn,
  markAssistantDelta,
  restoreCompletedReasoning,
} from "../../apps/web-ui/turn-presentation";

test("turn presentation keeps model, reasoning, and tool events in received order", () => {
  let turn = createTurnPresentation();
  turn = applyTurnRuntimeEvent(turn, "model.started", { callIndex: 1 });
  turn = applyTurnRuntimeEvent(turn, "reasoning.completed", { callIndex: 1, text: "Prepare tool call." });
  turn = applyTurnRuntimeEvent(turn, "model.completed", { callIndex: 1 });
  turn = applyTurnRuntimeEvent(turn, "tool.requested", {
    callId: "call-1",
    name: "demo.add",
    arguments: { a: 2, b: 3 },
  });
  turn = applyTurnRuntimeEvent(turn, "tool.started", { callId: "call-1", name: "demo.add" });
  turn = applyTurnRuntimeEvent(turn, "tool.completed", { callId: "call-1", result: "5" });
  turn = applyTurnRuntimeEvent(turn, "model.started", { callIndex: 2 });
  turn = markAssistantDelta(turn);
  turn = applyTurnRuntimeEvent(turn, "reasoning.completed", { callIndex: 2, text: "Use the tool result." });
  turn = applyTurnRuntimeEvent(turn, "model.completed", { callIndex: 2 });
  turn = completeTurn(turn, 8300);

  assert.equal(turn.status, "completed");
  assert.equal(turn.durationMs, 8300);
  assert.deepEqual(turn.steps.map((step) => step.type), [
    "model", "reasoning", "tool", "model", "reasoning",
  ]);
  assert.deepEqual(turn.steps[0], {
    type: "model", callIndex: 1, phase: "waiting", status: "completed",
  });
  assert.deepEqual(turn.steps[2], {
    type: "tool", callId: "call-1", name: "demo.add", arguments: { a: 2, b: 3 }, status: "completed", result: "5",
  });
  assert.deepEqual(turn.steps[3], {
    type: "model", callIndex: 2, phase: "generating", status: "completed",
  });
});

test("turn presentation does not invent reasoning and preserves distinct failure states", () => {
  let turn = createTurnPresentation();
  turn = applyTurnRuntimeEvent(turn, "model.started", { callIndex: 1 });
  turn = applyTurnRuntimeEvent(turn, "assistant.delta", { text: "partial" });
  assert.deepEqual(turn.steps.map((step) => step.type), ["model"]);

  const failed = failTurn(turn, "failed", "Provider failed.");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "Provider failed.");
  const failedModel = failed.steps[0];
  assert.ok(failedModel?.type === "model");
  assert.equal(failedModel.status, "failed");

  const cancelled = failTurn(turn, "cancelled");
  assert.equal(cancelled.status, "cancelled");
  const cancelledModel = cancelled.steps[0];
  assert.ok(cancelledModel?.type === "model");
  assert.equal(cancelledModel.status, "cancelled");
});

test("history restores completed reasoning blocks in model-call order", () => {
  const restored = restoreCompletedReasoning([
    { callIndex: 2, text: "after tool" },
    { callIndex: 1, text: "before tool" },
  ]);

  assert.deepEqual(restored?.steps, [
    { type: "reasoning", callIndex: 1, text: "before tool", status: "completed" },
    { type: "reasoning", callIndex: 2, text: "after tool", status: "completed" },
  ]);
  assert.equal(restoreCompletedReasoning(undefined), undefined);
  assert.equal(restoreCompletedReasoning([]), undefined);
});

test("turn presentation shows ordered reasoning deltas before content and reconciles completion without duplication", () => {
  const longReasoning = `${"step details\n".repeat(200)}conclusion`;
  let turn = createTurnPresentation();
  turn = applyTurnRuntimeEvent(turn, "model.started", { callIndex: 1 });
  turn = applyTurnRuntimeEvent(turn, "reasoning.delta", { callIndex: 1, text: "first line\n" });

  let reasoning = turn.steps.find((step) => step.type === "reasoning");
  assert.ok(reasoning?.type === "reasoning");
  assert.equal(reasoning.text, "first line\n");
  assert.equal(reasoning.status, "running");

  turn = applyTurnRuntimeEvent(turn, "reasoning.delta", { callIndex: 1, text: longReasoning });
  turn = applyTurnRuntimeEvent(turn, "assistant.delta", { text: "first answer token" });
  reasoning = turn.steps.find((step) => step.type === "reasoning");
  assert.ok(reasoning?.type === "reasoning");
  assert.equal(reasoning.text, `first line\n${longReasoning}`);
  assert.equal(reasoning.text.split("step details").length - 1, 200);

  const canonicalText = `first line\n${longReasoning}`;
  turn = applyTurnRuntimeEvent(turn, "reasoning.completed", { callIndex: 1, text: canonicalText });
  turn = applyTurnRuntimeEvent(turn, "model.completed", { callIndex: 1 });
  turn = applyTurnRuntimeEvent(turn, "tool.requested", { callId: "call-1", name: "demo.add" });
  turn = applyTurnRuntimeEvent(turn, "model.started", { callIndex: 2 });
  turn = applyTurnRuntimeEvent(turn, "reasoning.delta", { callIndex: 2, text: "second model call" });
  turn = applyTurnRuntimeEvent(turn, "reasoning.completed", { callIndex: 2, text: "second model call" });

  const reasoningSteps = turn.steps.filter((step) => step.type === "reasoning");
  assert.equal(reasoningSteps.length, 2);
  assert.deepEqual(reasoningSteps.map((step) => step.type === "reasoning" && [step.callIndex, step.text, step.status]), [
    [1, canonicalText, "completed"],
    [2, "second model call", "completed"],
  ]);
  assert.deepEqual(turn.steps.map((step) => step.type), ["model", "reasoning", "tool", "model", "reasoning"]);
});

test("turn presentation creates a whole-text reasoning block only when completion arrives", () => {
  let turn = createTurnPresentation();
  turn = applyTurnRuntimeEvent(turn, "model.started", { callIndex: 1 });
  turn = applyTurnRuntimeEvent(turn, "reasoning.completed", { callIndex: 1, text: "whole response reasoning" });

  assert.deepEqual(turn.steps.filter((step) => step.type === "reasoning"), [
    { type: "reasoning", callIndex: 1, text: "whole response reasoning", status: "completed" },
  ]);
});

test("turn presentation keeps received reasoning and marks it interrupted after failure or cancellation", () => {
  let turn = createTurnPresentation();
  turn = applyTurnRuntimeEvent(turn, "model.started", { callIndex: 1 });
  turn = applyTurnRuntimeEvent(turn, "reasoning.delta", { callIndex: 1, text: "partial reasoning" });

  for (const status of ["failed", "cancelled"] as const) {
    const terminal = failTurn(turn, status);
    const reasoning = terminal.steps.find((step) => step.type === "reasoning");
    assert.ok(reasoning?.type === "reasoning");
    assert.equal(reasoning.text, "partial reasoning");
    assert.equal(reasoning.status, status);
  }
});
