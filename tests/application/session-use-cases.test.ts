import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeError, type AgentTool, type ToolPermissionPolicy } from "../../packages/core/src/agent-runtime";
import type { AssistantMessage, Message, Session, SessionHistory, SessionId, UserMessage } from "../../packages/core/src/session";
import { createSession, getHistory, runAgentTurn, sendMessage, SessionNotFoundError, type SessionRepository, type UserMessageDraft } from "../../packages/application/src";
import { FakeProvider } from "../../packages/providers/src/fake-provider";

class MemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<SessionId, Session>();
  private readonly messages: Message[] = [];

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
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
    draft: { id: string; createdAt: string; text: string },
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
        return { kind: "final", text: "deterministic reply" };
      },
    },
    { sessionId: session.id, text: "hello" },
  );
  const history = await getHistory(repository, session.id);

  assert.equal(providerCalls, 1);
  assert.equal(turn.userMessage.sequence, 1);
  assert.equal(turn.assistantMessage.role, "assistant");
  assert.equal(turn.assistantMessage.sequence, 2);
  assert.deepEqual(history.messages.map((message) => [message.role, message.content[0].text]), [
    ["user", "hello"],
    ["assistant", "deterministic reply"],
  ]);
});

test("application API executes one permitted tool and persists only the final answer", async () => {
  const repository = new MemorySessionRepository();
  const session = await createSession(repository);
  const tool = createTestTool();
  let executions = 0;
  const provider = new FakeProvider([
    { kind: "tool-call", callId: "call-1", name: "test.echo", arguments: { text: "from tool" } },
    { kind: "final", text: "The tool returned: from tool" },
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
  assert.deepEqual(history.messages.map((message) => [message.role, message.content[0].text]), [
    ["user", "use the test tool"],
    ["assistant", "The tool returned: from tool"],
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
