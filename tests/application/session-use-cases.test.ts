import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Message, Session, SessionHistory, SessionId, UserMessage } from "../../packages/core/src/session";
import { createSession, getHistory, runAgentTurn, sendMessage, SessionNotFoundError, type SessionRepository, type UserMessageDraft } from "../../packages/application/src";

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
        assert.equal(messages.length, 1);
        assert.equal(messages[0]?.role, "user");
        return "deterministic reply";
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
