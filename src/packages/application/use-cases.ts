import { randomUUID } from "node:crypto";
import {
  runAgentTurn as generateAgentReply,
  AgentRuntimeError,
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

export async function executeTurn(
  repository: SessionRepository,
  provider: TextGenerationProvider,
  input: { sessionId: SessionId; text: string; runId?: string },
  agentOptions: AgentExecutionOptions = {},
): Promise<{ runId: string; userMessage: UserMessage; assistantMessage: AssistantMessage; reasoning?: string }> {
  const runId = input.runId ?? randomUUID();
  if (runId.length === 0) {
    throw new InvalidArgumentError("runId must not be empty.");
  }
  let userMessage: UserMessage;
  let assistantMessage: AssistantMessage;
  let reasoning: string | undefined;
  agentOptions.signal?.throwIfAborted();
  try {
    userMessage = await sendMessage(repository, { sessionId: input.sessionId, text: input.text });
    await agentOptions.onEvent?.({ type: "turn.started", runId, userMessage });
    const history = await getHistory(repository, input.sessionId);
    const result = await generateAgentReply(history.messages, provider, {
      sessionId: input.sessionId,
      ...agentOptions,
    });
    reasoning = result.reasoning;
    const savedAssistantMessage = await repository.appendAssistantMessage(input.sessionId, {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      text: result.text,
    });
    if (savedAssistantMessage === null) {
      throw new SessionNotFoundError(input.sessionId);
    }
    assistantMessage = savedAssistantMessage;
  } catch (error) {
    await emitTurnFailure(agentOptions.onEvent, runId, error);
    throw error;
  }

  await agentOptions.onEvent?.({
    type: "turn.completed",
    runId,
    assistantMessage,
    ...(reasoning === undefined ? {} : { reasoning }),
  });
  return {
    runId,
    userMessage,
    assistantMessage,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

export async function runAgentTurn(
  repository: SessionRepository,
  provider: TextGenerationProvider,
  input: { sessionId: SessionId; text: string; runId?: string },
  agentOptions: AgentExecutionOptions = {},
): ReturnType<typeof executeTurn> {
  return executeTurn(repository, provider, input, agentOptions);
}

export interface AgentTurnStreamHandlers {
  onStarted(runId: string, userMessage: UserMessage): void | Promise<void>;
  onTextDelta(text: string): void | Promise<void>;
  signal?: AbortSignal;
}

export async function runAgentTurnStreaming(
  repository: SessionRepository,
  provider: TextGenerationProvider,
  input: { sessionId: SessionId; text: string; runId?: string },
  handlers: AgentTurnStreamHandlers,
  agentOptions: AgentExecutionOptions = {},
): Promise<{ runId: string; userMessage: UserMessage; assistantMessage: AssistantMessage }> {
  const signal = handlers.signal ?? agentOptions.signal;
  const turn = await executeTurn(repository, provider, input, {
    ...agentOptions,
    ...(signal === undefined ? {} : { signal }),
    onTextDelta: async (text) => {
      await agentOptions.onTextDelta?.(text);
      await handlers.onTextDelta(text);
    },
    onEvent: async (event) => {
      await agentOptions.onEvent?.(event);
      if (event.type === "turn.started") {
        await handlers.onStarted(event.runId, event.userMessage);
      }
    },
  });
  return { runId: turn.runId, userMessage: turn.userMessage, assistantMessage: turn.assistantMessage };
}

async function emitTurnFailure(
  onEvent: AgentExecutionOptions["onEvent"],
  runId: string,
  error: unknown,
): Promise<void> {
  const code = error instanceof AgentRuntimeError
    ? error.code
    : error instanceof Error && error.name === "AbortError"
      ? "ABORTED"
    : error instanceof InvalidArgumentError
      ? "INVALID_ARGUMENT"
      : error instanceof SessionNotFoundError
        ? "SESSION_NOT_FOUND"
        : "TURN_FAILED";
  try {
    await onEvent?.({ type: "turn.failed", runId, code });
  } catch {
    // Preserve the original turn failure if an event consumer also fails.
  }
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
