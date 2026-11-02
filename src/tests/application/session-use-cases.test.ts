import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentRuntimeError,
  runAgentTurn as runCoreAgentTurn,
  type AgentEvent,
  type AgentTool,
  type ToolPermissionPolicy,
} from "../../packages/core/agent";
import type { AssistantMessage, Message, Session, SessionHistory, SessionId, UserMessage } from "../../packages/core/session";
import { createSession, getHistory, listSessions, runAgentTurn, runAgentTurnStreaming, sendMessage, SessionNotFoundError, type SessionRepository, type UserMessageDraft } from "../../packages/application";
import { FakeProvider } from "../../packages/providers/fake-provider";

class MemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<SessionId, Session>();
  private readonly messages: Message[] = [];

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async listSessionHistories(): Promise<SessionHistory[]> {
    return [...this.sessions.values()].map((session) => ({
      session,
      messages: this.messages
        .filter((message) => message.sessionId === session.id)
        .sort((left, right) => left.sequence - right.sequence),
    }));
  }

  async appendUserMessage(sessionId: SessionId, draft: UserMessageDraft): Promise<UserMessage | null> {
    if (!this.sessions.has(sessionId)) {
      return null;
    }
    const sequence = this.messages.filter((message) => message.sessionId === sessionId).length + 1;
    const message: UserMessage = {
      id: draft.id,
      sessionId,
      sequence,
      role: "user",
      content: [{ type: "text", text: draft.text }],
      createdAt: draft.createdAt,
    };
    this.messages.push(message);
    return message;
  }

  async appendAssistantMessage(
    sessionId: SessionId,
    draft: { id: string; createdAt: string; text: string; reasoning?: { callIndex: number; text: string }[] },
  ): Promise<AssistantMessage | null> {
    if (!this.sessions.has(sessionId)) {
      return null;
    }
    const sequence = this.messages.filter((message) => message.sessionId === sessionId).length + 1;
    const message: AssistantMessage = {
      id: draft.id,
      sessionId,
      sequence,
      role: "assistant",
      content: [{ type: "text", text: draft.text }],
      createdAt: draft.createdAt,
      ...(draft.reasoning === undefined ? {} : { reasoning: draft.reasoning }),
    };
    this.messages.push(message);
    return message;
  }

  async getHistory(sessionId: SessionId): Promise<SessionHistory | null> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return null;
    }
    return {
      session,
      messages: this.messages
        .filter((message) => message.sessionId === sessionId)
        .sort((left, right) => left.sequence - right.sequence),
    };
  }
}

test("application API creates a session and appends ordered user messages", async () => {
  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  const first = await sendMessage(repository, { sessionId: session.id, text: "first" });
  const second = await sendMessage(repository, { sessionId: session.id, text: "second" });
  const history = await getHistory(repository, session.id);

  assert.equal(first.role, "user");
  assert.deepEqual(first.content, [{ type: "text", text: "first" }]);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(history.messages.map((message) => message.content[0].text), ["first", "second"]);
});

test("application API rejects empty text and unknown sessions", async () => {
  const repository = new MemorySessionRepository();
  await assert.rejects(sendMessage(repository, { sessionId: "missing", text: "hello" }), SessionNotFoundError);
  await assert.rejects(sendMessage(repository, { sessionId: "missing", text: "" }), /must not be empty/);
  await assert.rejects(getHistory(repository, "missing"), SessionNotFoundError);
});

test("application API lists sessions with titles and activity dates derived from messages", async () => {
  const repository = new MemorySessionRepository();
  const older = await createSession(repository);
  const newer = await createSession(repository);
  await sendMessage(repository, { sessionId: older.id, text: "  First question  " });
  await sendMessage(repository, { sessionId: newer.id, text: "Newer question" });

  const sessions = await listSessions(repository);

  assert.deepEqual(new Set(sessions.map(({ id }) => id)), new Set([newer.id, older.id]));
  assert.equal(sessions.find(({ id }) => id === older.id)?.title, "First question");
  assert.equal(sessions.find(({ id }) => id === newer.id)?.title, "Newer question");
});

test("application API runs one provider turn and persists ordered user and assistant messages", async () => {
  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  let providerCalls = 0;
  const turn = await runAgentTurn(
    repository,
    {
      async generate(messages) {
        providerCalls += 1;
        assert.equal(messages.messages.length, 1);
        assert.equal(messages.messages[0]?.role, "user");
        return { kind: "final", text: "deterministic reply", reasoning: "deterministic reasoning" };
      },
    },
    { sessionId: session.id, text: "hello" },
  );
  const history = await getHistory(repository, session.id);

  assert.equal(providerCalls, 1);
  assert.equal(turn.userMessage.sequence, 1);
  assert.equal(turn.assistantMessage.role, "assistant");
  assert.equal(turn.assistantMessage.sequence, 2);
  assert.equal(turn.reasoning, "deterministic reasoning");
  assert.deepEqual(history.messages.map((message) => [message.role, message.content[0].text]), [
    ["user", "hello"],
    ["assistant", "deterministic reply"],
  ]);
});

test("application streaming turn forwards deltas and persists their final text once", async () => {
  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  const chunks: string[] = [];
  const events: AgentEvent[] = [];
  const provider = {
    async generate(_request: unknown, options?: {
      onTextDelta?: (text: string) => void | Promise<void>;
      onReasoningDelta?: (text: string) => void | Promise<void>;
    }) {
      await options?.onReasoningDelta?.("reasoning ");
      await options?.onReasoningDelta?.("arrived first");
      await options?.onTextDelta?.("streamed ");
      await options?.onTextDelta?.("reply");
      return { kind: "final" as const, text: "streamed reply", reasoning: "reasoning arrived first" };
    },
  };
  let startedUser: UserMessage | undefined;
  const turn = await runAgentTurnStreaming(
    repository,
    provider,
    { sessionId: session.id, text: "hello" },
    {
      onStarted(_runId, userMessage) { startedUser = userMessage; },
      onTextDelta(delta) { chunks.push(delta); },
    },
    { onEvent(event) { events.push(event); } },
  );
  const history = await getHistory(repository, session.id);

  assert.deepEqual(chunks, ["streamed ", "reply"]);
  assert.deepEqual(events.map((event) => event.type), [
    "turn.started",
    "model.started",
    "reasoning.delta",
    "reasoning.delta",
    "assistant.delta",
    "assistant.delta",
    "reasoning.completed",
    "model.completed",
    "turn.completed",
  ]);
  assert.deepEqual(events.filter((event) => event.type === "reasoning.delta").map((event) => event.type === "reasoning.delta" && [event.callIndex, event.text]), [
    [1, "reasoning "],
    [1, "arrived first"],
  ]);
  const completedReasoning = events.find((event) => event.type === "reasoning.completed");
  assert.deepEqual(completedReasoning, { type: "reasoning.completed", callIndex: 1, text: "reasoning arrived first" });
  assert.equal(startedUser?.id, turn.userMessage.id);
  assert.equal(turn.assistantMessage.content[0]?.text, "streamed reply");
  assert.deepEqual(history.messages.map((message) => [message.role, message.content[0]?.text]), [
    ["user", "hello"],
    ["assistant", "streamed reply"],
  ]);
  assert.deepEqual(history.messages[1]?.role === "assistant" ? history.messages[1].reasoning : undefined, [
    { callIndex: 1, text: "reasoning arrived first" },
  ]);
});

test("application emits whole-text reasoning only when a provider returns it", async () => {
  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  const events: AgentEvent[] = [];
  const provider = {
    async generate(_request: unknown, options?: { onTextDelta?: (text: string) => void | Promise<void> }) {
      await options?.onTextDelta?.("answer");
      return { kind: "final" as const, text: "answer", reasoning: "whole-text reasoning" };
    },
  };

  await runAgentTurnStreaming(
    repository,
    provider,
    { sessionId: session.id, text: "hello" },
    { onStarted() {}, onTextDelta() {} },
    { onEvent(event) { events.push(event); } },
  );

  assert.deepEqual(events.map((event) => event.type), [
    "turn.started",
    "model.started",
    "assistant.delta",
    "reasoning.completed",
    "model.completed",
    "turn.completed",
  ]);
  assert.deepEqual(events.find((event) => event.type === "reasoning.completed"), {
    type: "reasoning.completed",
    callIndex: 1,
    text: "whole-text reasoning",
  });
});

test("application streaming cancellation leaves the user message without a false assistant completion", async () => {
  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  const controller = new AbortController();
  const provider = {
    async generate(_request: unknown, options?: {
      onTextDelta?: (text: string) => void | Promise<void>;
      onReasoningDelta?: (text: string) => void | Promise<void>;
      signal?: AbortSignal;
    }) {
      await options?.onReasoningDelta?.("partial reasoning");
      options?.signal?.throwIfAborted();
      await options?.onTextDelta?.("unreachable");
      return { kind: "final" as const, text: "unreachable", reasoning: "partial reasoning" };
    },
  };

  await assert.rejects(
    runAgentTurnStreaming(
      repository,
      provider,
      { sessionId: session.id, text: "stop this" },
      {
        signal: controller.signal,
        onStarted() {},
        onTextDelta() {},
      },
      { onEvent(event) { if (event.type === "reasoning.delta") controller.abort(); } },
    ),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  const history = await getHistory(repository, session.id);
  assert.deepEqual(history.messages.map((message) => message.role), ["user"]);
});

test("application API executes one permitted tool and persists only the final answer", async () => {
  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  const tool = createTestTool();
  let executions = 0;
  const provider = new FakeProvider([
    {
      kind: "tool-call",
      callId: "call-1",
      name: "test.echo",
      arguments: { text: "from tool" },
      reasoning: "Call the echo tool.",
    },
    { kind: "final", text: "The tool returned: from tool", reasoning: "Use the tool result." },
  ]);
  const permissionPolicy: ToolPermissionPolicy = {
    async authorize(request) {
      assert.equal(request.sessionId, session.id);
      assert.equal(request.toolName, "test.echo");
      assert.deepEqual(request.input, { text: "from tool" });
      return "allow";
    },
  };
  const executableTool: AgentTool = {
    ...tool,
    async execute(input, context) {
      executions += 1;
      assert.equal(context.sessionId, session.id);
      return tool.execute(input, context);
    },
  };

  const turn = await runAgentTurn(
    repository,
    provider,
    { sessionId: session.id, text: "use the test tool" },
    { tools: [executableTool], permissionPolicy },
  );
  const history = await getHistory(repository, session.id);

  assert.equal(executions, 1);
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(provider.requests[0]?.tools.map((definition) => definition.name), ["test.echo"]);
  assert.deepEqual(provider.requests[1]?.tools, []);
  assert.deepEqual(provider.requests[1]?.messages.slice(-2), [
    {
      role: "assistant",
      toolCall: { callId: "call-1", name: "test.echo", arguments: { text: "from tool" } },
    },
    { role: "tool", callId: "call-1", name: "test.echo", content: "from tool" },
  ]);
  assert.equal(turn.assistantMessage.content[0].text, "The tool returned: from tool");
  assert.equal(turn.reasoning, "Call the echo tool.\n\nUse the tool result.");
  assert.deepEqual(history.messages.map((message) => [message.role, message.content[0].text]), [
    ["user", "use the test tool"],
    ["assistant", "The tool returned: from tool"],
  ]);
});

test("the shared application turn streams its final answer after a permitted tool call", async () => {
  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  const provider = new FakeProvider([
    { kind: "tool-call", callId: "stream-call-1", name: "test.echo", arguments: { text: "from tool" } },
    { kind: "final", text: "Final: from tool" },
  ]);
  const chunks: string[] = [];
  const events: AgentEvent[] = [];
  const turn = await runAgentTurnStreaming(
    repository,
    provider,
    { sessionId: session.id, text: "stream the tool result" },
    { onStarted() {}, onTextDelta(text) { chunks.push(text); } },
    {
      tools: [createTestTool()],
      permissionPolicy: { async authorize() { return "allow"; } },
      onEvent(event) { events.push(event); },
    },
  );

  assert.equal(turn.assistantMessage.content[0]?.text, "Final: from tool");
  assert.equal(chunks.join(""), "Final: from tool");
  assert.deepEqual(provider.requests.map((request) => request.tools.length), [1, 0]);
  assert.deepEqual(events.map((event) => event.type), [
    "turn.started",
    "model.started",
    "model.completed",
    "tool.requested",
    "tool.started",
    "tool.completed",
    "model.started",
    "assistant.delta",
    "assistant.delta",
    "model.completed",
    "turn.completed",
  ]);
  const history = await getHistory(repository, session.id);
  assert.deepEqual(history.messages.map((message) => message.role), ["user", "assistant"]);
});

test("application emits ordered per-call reasoning and tool events around persistence", async () => {
  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  const events: AgentEvent[] = [];
  const provider = new FakeProvider([
    {
      kind: "tool-call",
      callId: "call-1",
      name: "test.echo",
      arguments: { text: "from tool" },
      reasoning: "Prepare the tool call.",
    },
    { kind: "final", text: "The tool returned: from tool", reasoning: "Use the tool result." },
  ]);

  const turn = await runAgentTurn(
    repository,
    provider,
    { sessionId: session.id, text: "use the test tool", runId: "run-1" },
    {
      tools: [createTestTool()],
      permissionPolicy: { async authorize() { return "allow"; } },
      async onEvent(event) {
        events.push(event);
        if (event.type === "turn.completed") {
          const history = await getHistory(repository, session.id);
          assert.equal(history.messages.at(-1)?.role, "assistant");
          const assistant = history.messages.at(-1);
          assert.deepEqual(
            assistant?.role === "assistant" ? assistant.reasoning : undefined,
            [
              { callIndex: 1, text: "Prepare the tool call." },
              { callIndex: 2, text: "Use the tool result." },
            ],
          );
        }
      },
    },
  );

  assert.equal(turn.reasoning, "Prepare the tool call.\n\nUse the tool result.");
  assert.deepEqual(turn.assistantMessage.reasoning, [
    { callIndex: 1, text: "Prepare the tool call." },
    { callIndex: 2, text: "Use the tool result." },
  ]);
  assert.deepEqual(events, [
    { type: "turn.started", runId: "run-1", userMessage: turn.userMessage },
    { type: "model.started", callIndex: 1 },
    { type: "reasoning.completed", callIndex: 1, text: "Prepare the tool call." },
    { type: "model.completed", callIndex: 1 },
    {
      type: "tool.requested",
      callId: "call-1",
      name: "test.echo",
      arguments: { text: "from tool" },
    },
    { type: "tool.started", callId: "call-1", name: "test.echo" },
    { type: "tool.completed", callId: "call-1", result: "from tool" },
    { type: "model.started", callIndex: 2 },
    { type: "reasoning.completed", callIndex: 2, text: "Use the tool result." },
    { type: "model.completed", callIndex: 2 },
    {
      type: "turn.completed",
      runId: "run-1",
      assistantMessage: turn.assistantMessage,
      reasoning: "Prepare the tool call.\n\nUse the tool result.",
    },
  ]);
});

test("application reports a denied tool request without claiming execution", async () => {
  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  const events: AgentEvent[] = [];

  await assert.rejects(
    runAgentTurn(
      repository,
      new FakeProvider([{
        kind: "tool-call",
        callId: "call-denied",
        name: "test.echo",
        arguments: { text: "x" },
      }]),
      { sessionId: session.id, text: "deny the tool", runId: "run-denied" },
      {
        tools: [createTestTool()],
        permissionPolicy: { async authorize() { return "deny"; } },
        onEvent(event) { events.push(event); },
      },
    ),
    (error: unknown) => error instanceof AgentRuntimeError && error.code === "PERMISSION_DENIED",
  );

  assert.deepEqual(events.map((event) => event.type), [
    "turn.started",
    "model.started",
    "model.completed",
    "tool.requested",
    "turn.failed",
  ]);
  const failureEvent = events.at(-1);
  assert.equal(failureEvent?.type, "turn.failed");
  if (failureEvent?.type === "turn.failed") {
    assert.equal(failureEvent.code, "PERMISSION_DENIED");
  }
});

test("application omits reasoning events when the provider supplies no reasoning", async () => {
  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  const events: AgentEvent[] = [];

  await runAgentTurn(
    repository,
    new FakeProvider([{ kind: "final", text: "plain answer" }]),
    { sessionId: session.id, text: "no reasoning" },
    { onEvent(event) { events.push(event); } },
  );

  assert.deepEqual(events.map((event) => event.type), [
    "turn.started",
    "model.started",
    "model.completed",
    "turn.completed",
  ]);
});

test("application API rejects unknown tools, invalid arguments, and denied permission before execution", async () => {
  const scenarios: Array<{
    name: string;
    response: { kind: "tool-call"; callId: string; name: string; arguments: unknown };
    permissionPolicy: ToolPermissionPolicy;
    expectedCode: AgentRuntimeError["code"];
  }> = [
    {
      name: "unknown tool",
      response: { kind: "tool-call", callId: "call-1", name: "missing.tool", arguments: { text: "x" } },
      permissionPolicy: { async authorize() { return "allow"; } },
      expectedCode: "UNKNOWN_TOOL",
    },
    {
      name: "invalid arguments",
      response: { kind: "tool-call", callId: "call-1", name: "test.echo", arguments: { wrong: "x" } },
      permissionPolicy: { async authorize() { return "allow"; } },
      expectedCode: "INVALID_TOOL_ARGUMENTS",
    },
    {
      name: "denied permission",
      response: { kind: "tool-call", callId: "call-1", name: "test.echo", arguments: { text: "x" } },
      permissionPolicy: { async authorize() { return "deny"; } },
      expectedCode: "PERMISSION_DENIED",
    },
  ];

  for (const scenario of scenarios) {
    const repository = new MemorySessionRepository();
    const session = await createSession(repository);
    let executions = 0;
    const tool = createTestTool(async () => { executions += 1; });
    const provider = new FakeProvider([scenario.response]);

    await assert.rejects(
      runAgentTurn(
        repository,
        provider,
        { sessionId: session.id, text: scenario.name },
        { tools: [tool], permissionPolicy: scenario.permissionPolicy },
      ),
      (error: unknown) => error instanceof AgentRuntimeError && error.code === scenario.expectedCode,
    );
    const history = await getHistory(repository, session.id);
    assert.equal(executions, 0, scenario.name);
    assert.deepEqual(history.messages.map((message) => message.role), ["user"], scenario.name);
  }
});

test("application API fails closed when tools lack a permission policy or exceed the configured count", async () => {
  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  const provider = new FakeProvider([{ kind: "final", text: "must not be requested" }]);
  const tool = createTestTool();

  await assert.rejects(
    runAgentTurn(repository, provider, { sessionId: session.id, text: "missing policy" }, { tools: [tool] }),
    (error: unknown) => error instanceof AgentRuntimeError && error.code === "INVALID_CONFIGURATION",
  );
  assert.equal(provider.requests.length, 0);

  await assert.rejects(
    runAgentTurn(
      repository,
      provider,
      { sessionId: session.id, text: "too many tools" },
      { tools: [tool, tool], permissionPolicy: { async authorize() { return "allow"; } } },
    ),
    (error: unknown) => error instanceof AgentRuntimeError && error.code === "INVALID_CONFIGURATION",
  );
  assert.equal(provider.requests.length, 0);
  const history = await getHistory(repository, session.id);
  assert.deepEqual(history.messages.map((message) => message.role), ["user", "user"]);
});

test("core runtime rejects messages that do not contain exactly one text part", async () => {
  let providerCalls = 0;
  const malformedMessage = { role: "user", content: [] } as unknown as Message;

  await assert.rejects(
    runCoreAgentTurn([malformedMessage], {
      async generate() {
        providerCalls += 1;
        return { kind: "final", text: "must not be requested" };
      },
    }, { sessionId: "session-1" }),
    (error: unknown) => error instanceof AgentRuntimeError && error.code === "INVALID_CONFIGURATION",
  );
  assert.equal(providerCalls, 0);
});

test("application API preserves the tool execution cause without exposing its message", async () => {
  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  const cause = new Error("private tool details");
  const tool = createTestTool(() => { throw cause; });

  await assert.rejects(
    runAgentTurn(
      repository,
      new FakeProvider([{
        kind: "tool-call",
        callId: "call-1",
        name: "test.echo",
        arguments: { text: "x" },
      }]),
      { sessionId: session.id, text: "run failing tool" },
      { tools: [tool], permissionPolicy: { async authorize() { return "allow"; } } },
    ),
    (error: unknown) => error instanceof AgentRuntimeError &&
      error.code === "TOOL_EXECUTION_FAILED" &&
      error.message === "Tool execution failed." &&
      error.cause === cause,
  );
});

test("application API stops on tool and provider failures without persisting an assistant response", async () => {
  const failureCases = [
    {
      expectedCode: "TOOL_EXECUTION_FAILED",
      expectedProviderCalls: 1,
      provider: new FakeProvider([
        { kind: "tool-call" as const, callId: "call-1", name: "test.echo", arguments: { text: "x" } },
        { kind: "final" as const, text: "must not be requested" },
      ]),
      tool: createTestTool(() => { throw new Error("private tool details"); }),
    },
    {
      expectedCode: "LOOP_LIMIT",
      expectedProviderCalls: 2,
      provider: new FakeProvider([
        { kind: "tool-call" as const, callId: "call-1", name: "test.echo", arguments: { text: "x" } },
        { kind: "tool-call" as const, callId: "call-2", name: "test.echo", arguments: { text: "x" } },
      ]),
      tool: createTestTool(),
    },
  ] as const;

  for (const failureCase of failureCases) {
    const repository = new MemorySessionRepository();
    const session = await createSession(repository);
    const policy: ToolPermissionPolicy = { async authorize() { return "allow"; } };

    await assert.rejects(
      runAgentTurn(
        repository,
        failureCase.provider,
        { sessionId: session.id, text: "bounded call" },
        { tools: [failureCase.tool], permissionPolicy: policy },
      ),
      (error: unknown) => error instanceof AgentRuntimeError && error.code === failureCase.expectedCode,
    );
    const history = await getHistory(repository, session.id);
    assert.equal(failureCase.provider.requests.length, failureCase.expectedProviderCalls);
    assert.deepEqual(history.messages.map((message) => message.role), ["user"]);
  }

  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  const providerError = new Error("provider unavailable");
  await assert.rejects(
    runAgentTurn(repository, {
      async generate() { throw providerError; },
    }, { sessionId: session.id, text: "provider failure" }),
    (error: unknown) => error === providerError,
  );
  const history = await getHistory(repository, session.id);
  assert.deepEqual(history.messages.map((message) => message.role), ["user"]);
});

function createTestTool(onExecute: () => void = () => undefined): AgentTool {
  return {
    definition: {
      name: "test.echo",
      description: "Returns the supplied text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    validateInput(input): boolean {
      return typeof input === "object" && input !== null &&
        "text" in input && typeof input.text === "string" && Object.keys(input).length === 1;
    },
    async execute(input): Promise<string> {
      onExecute();
      return (input as { text: string }).text;
    },
  };
}
