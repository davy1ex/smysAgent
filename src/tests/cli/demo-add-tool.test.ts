import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentRuntimeError,
  runAgentTurn,
  type AgentTool,
} from "../../packages/core/agent";
import type { Message } from "../../packages/core/session";
import { FakeProvider } from "../../packages/providers/fake-provider";
import { createDemoAddTool } from "../../apps/cli/demo-tools";

const userMessage: Message = {
  id: "user-1",
  sessionId: "session-1",
  sequence: 1,
  role: "user",
  content: [{ type: "text", text: "add two and three" }],
  createdAt: "2026-10-28T10:00:00.000Z",
};

test("demo.add returns its sum to the model before the final response", async () => {
  const provider = new FakeProvider([
    { kind: "tool-call", callId: "call-1", name: "demo.add", arguments: { a: 2, b: 3 } },
    { kind: "final", text: "The sum is 5." },
  ]);

  const response = await runAgentTurn([userMessage], provider, {
    sessionId: userMessage.sessionId,
    tools: [createDemoAddTool()],
    permissionPolicy: { async authorize() { return "allow"; } },
  });

  assert.deepEqual(response, { text: "The sum is 5." });
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(provider.requests[1]?.messages.at(-1), {
    role: "tool",
    callId: "call-1",
    name: "demo.add",
    content: "5",
  });
  assert.deepEqual(provider.requests[1]?.tools, []);
});

test("demo.add rejects nonnumeric arguments before execution", async () => {
  const demoAddTool = createDemoAddTool();
  let executions = 0;
  const tool: AgentTool = {
    ...demoAddTool,
    async execute(input, context) {
      executions += 1;
      return demoAddTool.execute(input, context);
    },
  };
  const provider = new FakeProvider([
    { kind: "tool-call", callId: "call-1", name: "demo.add", arguments: { a: "2", b: 3 } },
    { kind: "final", text: "must not be requested" },
  ]);

  await assert.rejects(
    runAgentTurn([userMessage], provider, {
      sessionId: userMessage.sessionId,
      tools: [tool],
      permissionPolicy: { async authorize() { return "allow"; } },
    }),
    (error: unknown) => error instanceof AgentRuntimeError && error.code === "INVALID_TOOL_ARGUMENTS",
  );
  assert.equal(executions, 0);
  assert.equal(provider.requests.length, 1);
});
