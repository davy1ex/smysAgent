import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTurnRuntimeEvent,
  completeTurn,
  createTurnPresentation,
  failTurn,
  getReasoningPreview,
  markAssistantDelta,
  restoreCompletedReasoning,
} from "../../apps/web-ui/turn-presentation";
import { FakeProvider } from "../../packages/providers/fake-provider";

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
  assert.equal(reasoning.status, "completed");
  assert.equal(turn.status, "running");
  assert.equal(reasoning.text.split("step details").length - 1, 200);

  const canonicalText = `first line\n${longReasoning}`;
  turn = applyTurnRuntimeEvent(turn, "reasoning.completed", { callIndex: 1, text: canonicalText });
  turn = applyTurnRuntimeEvent(turn, "assistant.delta", { text: "the answer continues" });
  reasoning = turn.steps.find((step) => step.type === "reasoning");
  assert.ok(reasoning?.type === "reasoning");
  assert.equal(reasoning.text, canonicalText);
  assert.equal(reasoning.status, "completed");
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

test("reasoning preview advances on delayed Fake Provider chunks while preserving the full text", async () => {
  const reasoningText = "First thought continues\nSecond thought\nThird thought continues";
  const provider = new FakeProvider([{ kind: "final", text: "A streamed answer.", reasoning: reasoningText }]);
  let turn = createTurnPresentation();
  turn = applyTurnRuntimeEvent(turn, "model.started", { callIndex: 1 });
  const previews: string[] = [];
  let firstAnswerReasoningText: string | undefined;

  await provider.generate({ messages: [], tools: [] }, {
    onReasoningDelta: (text) => {
      turn = applyTurnRuntimeEvent(turn, "reasoning.delta", { callIndex: 1, text });
      const reasoning = turn.steps.find((step) => step.type === "reasoning");
      assert.ok(reasoning?.type === "reasoning");
      previews.push(getReasoningPreview(reasoning.text));
    },
    onTextDelta: (text) => {
      turn = applyTurnRuntimeEvent(turn, "assistant.delta", { text });
      const reasoning = turn.steps.find((step) => step.type === "reasoning");
      if (firstAnswerReasoningText === undefined && reasoning?.type === "reasoning") {
        firstAnswerReasoningText = reasoning.text;
        assert.equal(reasoning.status, "completed");
      }
    },
  });

  assert.ok(previews.length > 1);
  assert.equal(previews[0], reasoningText.slice(0, 8));
  assert.notEqual(previews[0], previews[1]);
  assert.ok(previews.includes("…"));
  const reasoning = turn.steps.find((step) => step.type === "reasoning");
  assert.ok(reasoning?.type === "reasoning");
  assert.equal(reasoning.text, reasoningText);
  assert.equal(previews.at(-1), "Third thought continues");
  assert.equal(firstAnswerReasoningText, reasoningText);
  assert.equal(reasoning.status, "completed");
});

test("reasoning preview follows the current logical line after every delta", () => {
  let turn = createTurnPresentation();
  const deltas = ["First thought", " continues", "\n", "Second thought", "\nThird thought", " continues"];
  const expected = [
    "First thought",
    "First thought continues",
    "…",
    "Second thought",
    "Third thought",
    "Third thought continues",
  ];

  deltas.forEach((text, index) => {
    turn = applyTurnRuntimeEvent(turn, "reasoning.delta", { callIndex: 1, text });
    const reasoning = turn.steps.find((step) => step.type === "reasoning");
    assert.ok(reasoning?.type === "reasoning");
    assert.equal(getReasoningPreview(reasoning.text, { status: reasoning.status }), expected[index]);
  });

  const reasoning = turn.steps.find((step) => step.type === "reasoning");
  assert.ok(reasoning?.type === "reasoning");
  assert.equal(reasoning.text, deltas.join(""));
});

test("reasoning preview handles empty lines, split CRLF, long lines, and per-call streams", () => {
  assert.equal(getReasoningPreview("\n", { status: "running" }), "…");
  assert.equal(getReasoningPreview("First\n\nThird", { status: "running" }), "Third");
  assert.equal(getReasoningPreview("First\r", { status: "running" }), "First");
  assert.equal(getReasoningPreview("First\r\nNext", { status: "running" }), "Next");
  assert.equal(getReasoningPreview("First\r\n\r\n", { status: "running" }), "…");
  let splitCrLf = "First\r";
  assert.equal(getReasoningPreview(splitCrLf, { status: "running" }), "First");
  splitCrLf += "\nNext";
  assert.equal(getReasoningPreview(splitCrLf, { status: "running" }), "Next");

  const longLine = `EARLY ONLY marker. ${"older reasoning. ".repeat(20)}LATEST LINE`;
  const fullText = `Previous line\n${longLine}`;
  const preview = getReasoningPreview(fullText, { maxLength: 140 });
  assert.equal(preview.length, 140);
  assert.ok(preview.startsWith("…"));
  assert.ok(preview.endsWith("LATEST LINE"));
  assert.ok(!preview.includes("EARLY ONLY marker."));
  assert.ok(!preview.includes("Previous line"));
  assert.equal(fullText, `Previous line\n${longLine}`);

  let turn = createTurnPresentation();
  turn = applyTurnRuntimeEvent(turn, "reasoning.delta", { callIndex: 1, text: "first call\nline one" });
  turn = applyTurnRuntimeEvent(turn, "reasoning.delta", { callIndex: 2, text: "second call" });
  let reasoningSteps = turn.steps.filter((step) => step.type === "reasoning");
  assert.deepEqual(reasoningSteps.map((step) => step.type === "reasoning" ? getReasoningPreview(step.text) : ""), [
    "line one", "second call",
  ]);
  turn = applyTurnRuntimeEvent(turn, "reasoning.delta", { callIndex: 1, text: "\nnew line" });
  reasoningSteps = turn.steps.filter((step) => step.type === "reasoning");
  assert.deepEqual(reasoningSteps.map((step) => step.type === "reasoning" ? getReasoningPreview(step.text) : ""), [
    "new line", "second call",
  ]);
});

test("completed reasoning preview uses its last nonempty line and stays unchanged during answer streaming", () => {
  let turn = createTurnPresentation();
  turn = applyTurnRuntimeEvent(turn, "model.started", { callIndex: 1 });
  turn = applyTurnRuntimeEvent(turn, "reasoning.delta", { callIndex: 1, text: "First line\nSecond line\n" });
  let reasoning = turn.steps.find((step) => step.type === "reasoning");
  assert.ok(reasoning?.type === "reasoning");
  assert.equal(getReasoningPreview(reasoning.text, { status: reasoning.status }), "…");

  turn = applyTurnRuntimeEvent(turn, "reasoning.completed", { callIndex: 1, text: "First line\nSecond line\n" });
  reasoning = turn.steps.find((step) => step.type === "reasoning");
  assert.ok(reasoning?.type === "reasoning");
  const completedText = reasoning.text;
  const completedPreview = getReasoningPreview(reasoning.text, { status: reasoning.status });
  assert.equal(completedPreview, "Second line");

  turn = applyTurnRuntimeEvent(turn, "assistant.delta", { text: "The answer starts." });
  turn = applyTurnRuntimeEvent(turn, "assistant.delta", { text: " The answer continues." });
  reasoning = turn.steps.find((step) => step.type === "reasoning");
  assert.ok(reasoning?.type === "reasoning");
  assert.equal(reasoning.text, completedText);
  assert.equal(getReasoningPreview(reasoning.text, { status: reasoning.status }), completedPreview);
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
