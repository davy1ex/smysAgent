import { randomUUID } from "node:crypto";
import { runAgentTurn as generateAgentReply, type TextGenerationProvider } from "../../core/src/agent-runtime";
import type { AssistantMessage, Session, SessionHistory, SessionId, UserMessage } from "../../core/src/session";
import { InvalidArgumentError, SessionNotFoundError } from "./errors";
import type { SessionRepository } from "./ports";

export async function createSession(repository: SessionRepository): Promise<Session> {
  const session: Session = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await repository.createSession(session);
  return session;
}

export async function sendMessage(
  repository: SessionRepository,
  input: { sessionId: SessionId; text: string },
): Promise<UserMessage> {
  if (input.sessionId.length === 0) {
    throw new InvalidArgumentError("--session-id must not be empty.");
  }
  if (input.text.length === 0) {
    throw new InvalidArgumentError("Message text must not be empty.");
  }

  const message = await repository.appendUserMessage(input.sessionId, {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    text: input.text,
  });
  if (message === null) {
    throw new SessionNotFoundError(input.sessionId);
  }
  return message;
}

export async function runAgentTurn(
  repository: SessionRepository,
  provider: TextGenerationProvider,
  input: { sessionId: SessionId; text: string },
): Promise<{ userMessage: UserMessage; assistantMessage: AssistantMessage }> {
  const userMessage = await sendMessage(repository, input);
  const history = await getHistory(repository, input.sessionId);
  const text = await generateAgentReply(history.messages, provider);
  const assistantMessage = await repository.appendAssistantMessage(input.sessionId, {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    text,
  });
  if (assistantMessage === null) {
    throw new SessionNotFoundError(input.sessionId);
  }
  return { userMessage, assistantMessage };
}

export async function getHistory(
  repository: SessionRepository,
  sessionId: SessionId,
): Promise<SessionHistory> {
  if (sessionId.length === 0) {
    throw new InvalidArgumentError("--session-id must not be empty.");
  }

  const history = await repository.getHistory(sessionId);
  if (history === null) {
    throw new SessionNotFoundError(sessionId);
  }
  return history;
}
