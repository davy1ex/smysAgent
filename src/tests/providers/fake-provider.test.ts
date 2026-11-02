import assert from "node:assert/strict";
import test from "node:test";
import { FakeProvider } from "../../packages/providers/fake-provider";

test("Fake Provider emits delayed reasoning chunks before its content chunks", async () => {
  const provider = new FakeProvider([{
    kind: "final",
    text: "answer",
    reasoning: "first thought; second thought.",
  }]);
  const order: string[] = [];
  const reasoningTimes: number[] = [];
  const started = performance.now();

  const result = await provider.generate({ messages: [{ role: "user", content: "prompt" }], tools: [] }, {
    onReasoningDelta: (delta) => {
      order.push(`reasoning:${delta}`);
      reasoningTimes.push(performance.now() - started);
    },
    onTextDelta: (delta) => { order.push(`content:${delta}`); },
  });

  const firstContent = order.findIndex((event) => event.startsWith("content:"));
  assert.ok(firstContent > 1);
  assert.ok(order.slice(0, firstContent).every((event) => event.startsWith("reasoning:")));
  assert.ok(reasoningTimes.at(-1)! > reasoningTimes[0]!);
  assert.deepEqual(result, {
    kind: "final",
    text: "answer",
    reasoning: "first thought; second thought.",
  });
});

test("Fake Provider does not emit reasoning deltas when a response has no reasoning", async () => {
  const provider = new FakeProvider([{ kind: "final", text: "answer" }]);
  let reasoningChunks = 0;
  const textChunks: string[] = [];

  const result = await provider.generate({ messages: [{ role: "user", content: "prompt" }], tools: [] }, {
    onReasoningDelta: () => { reasoningChunks += 1; },
    onTextDelta: (delta) => { textChunks.push(delta); },
  });

  assert.equal(reasoningChunks, 0);
  assert.deepEqual(textChunks, ["answer"]);
  assert.deepEqual(result, { kind: "final", text: "answer" });
});
