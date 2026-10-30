import { randomUUID } from "node:crypto";
import {
  runAgentTurn as generateAgentReply,
  streamAgentTurn as generateAgentReplyStream,
  type StreamingTextGenerationProvider,
  type TextGenerationProvider,
} from "../core/agent";
import type { AssistantMessage, Session, SessionHistory, SessionId, UserMessage } from "../core/session";
import { InvalidArgumentError, SessionNotFoundError } from "./errors";
import type { AgentExecutionOptions, SessionRepository } from "./ports";

export async function createSession(repository: SessionRepository): Promise<Session> {
  const session: Session = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await repository.createSession(session);
  return session;
}

export interface SessionSummary {
  id: SessionId;
  createdAt: string;
  updatedAt: string;
  title: string;
}

export async function listSessions(repository: SessionRepository): Promise<SessionSummary[]> {
  const histories = await repository.listSessionHistories();
  return histories
    .map(({ session, messages }): SessionSummary => {
      const firstUserMessage = messages.find((message) => message.role === "user");
      const title = firstUserMessage?.content[0]?.text.trim() || "Новый чат";
      const lastMessage = messages.at(-1);
      return {
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: lastMessage?.createdAt ?? session.createdAt,
        title,
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
  input: { sessionId: SessionId; text: string; runId?: string },
  agentOptions: AgentExecutionOptions = {},
): Promise<{ runId: string; userMessage: UserMessage; assistantMessage: AssistantMessage; reasoning?: string }> {
  const runId = input.runId ?? randomUUID();
  if (runId.length === 0) {
    throw new InvalidArgumentError("runId must not be empty.");
  }
  const userMessage = await sendMessage(repository, { sessionId: input.sessionId, text: input.text });
  const history = await getHistory(repository, input.sessionId);
  const result = await generateAgentReply(history.messages, provider, {
    sessionId: input.sessionId,
    ...agentOptions,
  });
  const assistantMessage = await repository.appendAssistantMessage(input.sessionId, {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    text: result.text,
  });
  if (assistantMessage === null) {
    throw new SessionNotFoundError(input.sessionId);
  }
  return {
    runId,
    userMessage,
    assistantMessage,
    ...(result.reasoning === undefined ? {} : { reasoning: result.reasoning }),
  };
}

export interface AgentTurnStreamHandlers {
  onStarted(runId: string, userMessage: UserMessage): void | Promise<void>;
  onTextDelta(text: string): void | Promise<void>;
  signal?: AbortSignal;
}

export async function runAgentTurnStreaming(
  repository: SessionRepository,
  provider: TextGenerationProvider & StreamingTextGenerationProvider,
  input: { sessionId: SessionId; text: string; runId?: string },
  handlers: AgentTurnStreamHandlers,
  agentOptions: AgentExecutionOptions = {},
): Promise<{ runId: string; userMessage: UserMessage; assistantMessage: AssistantMessage }> {
  if ((agentOptions.tools?.length ?? 0) > 0) {
    throw new InvalidArgumentError("Streaming turns do not support tools.");
  }
  const runId = input.runId ?? randomUUID();
  if (runId.length === 0) {
    throw new InvalidArgumentError("runId must not be empty.");
  }
  handlers.signal?.throwIfAborted();
  const userMessage = await sendMessage(repository, { sessionId: input.sessionId, text: input.text });
  await handlers.onStarted(runId, userMessage);
  handlers.signal?.throwIfAborted();
  const history = await getHistory(repository, input.sessionId);
  const result = await generateAgentReplyStream(history.messages, provider, {
    sessionId: input.sessionId,
    ...agentOptions,
    onTextDelta: handlers.onTextDelta,
    ...(handlers.signal === undefined ? {} : { signal: handlers.signal }),
  });
  handlers.signal?.throwIfAborted();
  const assistantMessage = await repository.appendAssistantMessage(input.sessionId, {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    text: result.text,
  });
  if (assistantMessage === null) {
    throw new SessionNotFoundError(input.sessionId);
  }
  return { runId, userMessage, assistantMessage };
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
