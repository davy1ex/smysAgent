import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LmStudioProvider } from "../../packages/providers/lm-studio-provider";
import { JsonFileSessionRepository } from "../../packages/storage";
import { createWebApiServer } from "../../apps/web-host/server";
import { FakeProvider } from "../../packages/providers/fake-provider";
import { createDemoAddTool } from "../../packages/application";

test("local Web API creates sessions, runs a fake turn, and returns persisted history", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-web-api-"));
  const repository = new JsonFileSessionRepository(dataDir);
  const server = createWebApiServer({ repository, provider: new FakeProvider() });

  try {
    const baseUrl = await listen(server);
    const emptyList = await fetch(`${baseUrl}/api/sessions`).then((response) => response.json()) as {
      sessions: unknown[];
    };
    assert.deepEqual(emptyList.sessions, []);

    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json() as { session: { id: string } };

    const turnResponse = await fetch(`${baseUrl}/api/sessions/${created.session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello from Web" }),
    });
    assert.equal(turnResponse.status, 200);
    const turn = await turnResponse.json() as {
      runId: string;
      userMessage: { role: string; content: Array<{ text: string }> };
      assistantMessage: { role: string; content: Array<{ text: string }> };
    };
    assert.ok(turn.runId.length > 0);
    assert.equal(turn.userMessage.role, "user");
    assert.equal(turn.assistantMessage.content[0]?.text, "Fake response to: hello from Web");

    const sessions = await fetch(`${baseUrl}/api/sessions`).then((response) => response.json()) as {
      sessions: Array<{ id: string; title: string; createdAt: string; updatedAt: string }>;
    };
    assert.deepEqual(sessions.sessions.map(({ id, title }) => ({ id, title })), [
      { id: created.session.id, title: "hello from Web" },
    ]);
    assert.ok(sessions.sessions[0]?.createdAt);
    assert.ok(sessions.sessions[0]?.updatedAt);

    const history = await fetch(`${baseUrl}/api/sessions/${created.session.id}/history`).then((response) => response.json()) as {
      messages: Array<{ role: string; content: Array<{ text: string }> }>;
    };
    assert.deepEqual(history.messages.map((message) => [message.role, message.content[0]?.text]), [
      ["user", "hello from Web"],
      ["assistant", "Fake response to: hello from Web"],
    ]);
  } finally {
    await close(server);
    await repository.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("failed provider turn returns its run and message identifiers without losing the user message", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-web-api-failure-"));
  const repository = new JsonFileSessionRepository(dataDir);
  const provider = new LmStudioProvider({
    endpoint: "http://127.0.0.1:1234/v1/chat/completions",
    model: "test-model",
    fetcher: async () => { throw new Error("private provider details"); },
  });
  const server = createWebApiServer({ repository, provider });

  try {
    const baseUrl = await listen(server);
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((response) => response.json()) as {
      session: { id: string };
    };
    const response = await fetch(`${baseUrl}/api/sessions/${created.session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "keep this message" }),
    });
    const failure = await response.json() as {
      error: { code: string; message: string; runId: string; turnId: string };
    };

    assert.equal(response.status, 502);
    assert.equal(failure.error.code, "PROVIDER_ERROR");
    assert.equal(failure.error.message, "Could not connect to LM Studio.");
    assert.ok(failure.error.runId.length > 0);
    assert.ok(failure.error.turnId.length > 0);

    const history = await fetch(`${baseUrl}/api/sessions/${created.session.id}/history`).then((result) => result.json()) as {
      messages: Array<{ id: string; role: string; content: Array<{ text: string }> }>;
    };
    assert.deepEqual(history.messages.map(({ id, role, content }) => ({ id, role, text: content[0]?.text })), [
      { id: failure.error.turnId, role: "user", text: "keep this message" },
    ]);
  } finally {
    await close(server);
    await repository.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local Web API runs a turn through the configured LM Studio provider", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-web-api-lm-studio-"));
  const repository = new JsonFileSessionRepository(dataDir);
  let providerRequest: { model?: string; stream?: boolean } | undefined;
  const provider = new LmStudioProvider({
    endpoint: "http://127.0.0.1:1234/v1/chat/completions",
    model: "local-model",
    fetcher: async (_input, init) => {
      providerRequest = JSON.parse(String(init?.body)) as { model?: string; stream?: boolean };
      return new Response(JSON.stringify({ choices: [{ message: { content: "LM Studio reply" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const server = createWebApiServer({ repository, provider });

  try {
    const baseUrl = await listen(server);
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((response) => response.json()) as { session: { id: string } };
    const response = await fetch(`${baseUrl}/api/sessions/${created.session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello LM Studio" }),
    });
    const turn = await response.json() as { assistantMessage: { content: Array<{ text: string }> } };

    assert.equal(response.status, 200);
    assert.equal(providerRequest?.model, "local-model");
    assert.equal(providerRequest?.stream, false);
    assert.equal(turn.assistantMessage.content[0]?.text, "LM Studio reply");
  } finally {
    await close(server);
    await repository.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("streaming Web API delivers deltas before model completion and persists once before completed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-web-api-stream-"));
  const repository = new JsonFileSessionRepository(dataDir);
  let releaseModel: (() => void) | undefined;
  const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
  const provider = {
    async generate(_request: unknown, options?: { onTextDelta?: (text: string) => void | Promise<void> }) {
      await options?.onTextDelta?.("early ");
      await modelGate;
      await options?.onTextDelta?.("reply");
      return { kind: "final" as const, text: "early reply" };
    },
  };
  const server = createWebApiServer({ repository, provider });

  try {
    const baseUrl = await listen(server);
    const created = await createWebSession(baseUrl);
    const response = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ text: "stream this" }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const readEvent = createSseEventReader(response.body!.getReader());
    const started = await readEvent();
    const modelStarted = await readEvent();
    const firstDelta = await readEvent();
    assert.equal(started.event, "turn.started");
    assert.equal(modelStarted.event, "model.started");
    assert.equal(firstDelta.event, "assistant.delta");
    assert.equal((firstDelta.data as { text: string }).text, "early ");

    const inProgress = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/history`).then((result) => result.json()) as {
      messages: Array<{ role: string }>;
    };
    assert.deepEqual(inProgress.messages.map((message) => message.role), ["user"]);
    releaseModel?.();

    const secondDelta = await readEvent();
    const modelCompleted = await readEvent();
    const completed = await readEvent();
    assert.equal(secondDelta.event, "assistant.delta");
    assert.equal((secondDelta.data as { text: string }).text, "reply");
    assert.equal(modelCompleted.event, "model.completed");
    assert.equal(completed.event, "turn.completed");
    const history = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/history`).then((result) => result.json()) as {
      messages: Array<{ role: string; content: Array<{ text: string }> }>;
    };
    assert.deepEqual(history.messages.map((message) => [message.role, message.content[0]?.text]), [
      ["user", "stream this"],
      ["assistant", "early reply"],
    ]);
  } finally {
    releaseModel?.();
    await close(server);
    await repository.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("streaming Web API reports provider failure without persisting partial assistant text", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-web-api-stream-failure-"));
  const repository = new JsonFileSessionRepository(dataDir);
  const provider = new LmStudioProvider({
    endpoint: "http://127.0.0.1:1234/v1/chat/completions",
    model: "test-model",
    fetcher: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  const server = createWebApiServer({ repository, provider });

  try {
    const baseUrl = await listen(server);
    const created = await createWebSession(baseUrl);
    const response = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "fail after partial" }),
    });
    const readEvent = createSseEventReader(response.body!.getReader());
    assert.equal((await readEvent()).event, "turn.started");
    assert.equal((await readEvent()).event, "model.started");
    assert.equal((await readEvent()).event, "assistant.delta");
    const failed = await readEvent();
    assert.equal(failed.event, "turn.failed");
    assert.equal((failed.data as { error: { code: string } }).error.code, "PROVIDER_ERROR");
    const history = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/history`).then((result) => result.json()) as {
      messages: Array<{ role: string }>;
    };
    assert.deepEqual(history.messages.map((message) => message.role), ["user"]);
  } finally {
    await close(server);
    await repository.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Web SSE executes demo.add only for a tool explicitly allowed on this turn", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-web-api-demo-add-"));
  const repository = new JsonFileSessionRepository(dataDir);
  const provider = new FakeProvider([
    { kind: "tool-call", callId: "web-demo-add", name: "demo.add", arguments: { a: 2, b: 3 } },
    { kind: "final", text: "Fake demo.add result: 5", reasoning: "Use the sum returned by the tool." },
  ]);
  const server = createWebApiServer({ repository, provider, tools: [createDemoAddTool()] });

  try {
    const baseUrl = await listen(server);
    const created = await createWebSession(baseUrl);
    const response = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ text: "add 2 and 3", allowTools: ["demo.add"] }),
    });
    const readEvent = createSseEventReader(response.body!.getReader());
    const events: Array<{ event: string; data: unknown }> = [];
    while (true) {
      const event = await readEvent();
      events.push(event);
      if (event.event === "turn.completed") break;
    }
    const names = events.map(({ event }) => event);
    assert.deepEqual(names, [
      "turn.started",
      "model.started",
      "model.completed",
      "tool.requested",
      "tool.started",
      "tool.completed",
      "model.started",
      "reasoning.delta",
      "reasoning.delta",
      "reasoning.delta",
      "reasoning.delta",
      "reasoning.delta",
      "assistant.delta",
      "assistant.delta",
      "assistant.delta",
      "reasoning.completed",
      "model.completed",
      "turn.completed",
    ]);
    const reasoningDeltas = events.filter(({ event }) => event === "reasoning.delta");
    assert.deepEqual(reasoningDeltas.map(({ data }) => {
      const payload = data as { callIndex: number; text: string };
      return [payload.callIndex, payload.text];
    }), ["Use the ", "sum retu", "rned by ", "the tool", "."].map((text) => [2, text]));
    const completed = events.at(-1)?.data as {
      assistantMessage: { content: Array<{ text: string }>; reasoning?: Array<{ callIndex: number; text: string }> };
      reasoning?: string;
    };
    assert.equal(completed.assistantMessage.content[0]?.text, "Fake demo.add result: 5");
    assert.deepEqual(completed.assistantMessage.reasoning, [
      { callIndex: 2, text: "Use the sum returned by the tool." },
    ]);
    assert.equal(completed.reasoning, "Use the sum returned by the tool.");

    const history = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/history`).then((result) => result.json()) as {
      messages: Array<{ role: string; content: Array<{ text: string }>; reasoning?: Array<{ callIndex: number; text: string }> }>;
    };
    assert.deepEqual(history.messages.map((message) => [message.role, message.content[0]?.text]), [
      ["user", "add 2 and 3"],
      ["assistant", "Fake demo.add result: 5"],
    ]);
    assert.deepEqual(history.messages[1]?.reasoning, [
      { callIndex: 2, text: "Use the sum returned by the tool." },
    ]);
  } finally {
    await close(server);
    await repository.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("Web SSE does not auto-allow a registered tool when the turn has no explicit grant", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-web-api-demo-add-denied-"));
  const repository = new JsonFileSessionRepository(dataDir);
  let executions = 0;
  const tool = createDemoAddTool();
  const provider = new FakeProvider([
    { kind: "tool-call", callId: "web-denied", name: "demo.add", arguments: { a: 2, b: 3 } },
  ]);
  const server = createWebApiServer({
    repository,
    provider,
    tools: [{ ...tool, async execute(input, context) { executions += 1; return tool.execute(input, context); } }],
  });

  try {
    const baseUrl = await listen(server);
    const created = await createWebSession(baseUrl);
    const response = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ text: "add 2 and 3" }),
    });
    const readEvent = createSseEventReader(response.body!.getReader());
    let failure: { error: { code: string } } | undefined;
    while (true) {
      const event = await readEvent();
      if (event.event === "turn.failed") {
        failure = event.data as { error: { code: string } };
        break;
      }
    }
    assert.equal(failure?.error.code, "UNKNOWN_TOOL");
    assert.equal(executions, 0);
    const history = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/history`).then((result) => result.json()) as {
      messages: Array<{ role: string }>;
    };
    assert.deepEqual(history.messages.map((message) => message.role), ["user"]);
  } finally {
    await close(server);
    await repository.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("disconnecting a streaming Web request aborts provider generation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-web-api-stream-abort-"));
  const repository = new JsonFileSessionRepository(dataDir);
  let resolveCancelled: (() => void) | undefined;
  const cancelled = new Promise<void>((resolve) => { resolveCancelled = resolve; });
  const provider = {
    async generate(_request: unknown, options?: { onTextDelta?: (text: string) => void | Promise<void>; signal?: AbortSignal }) {
      await options?.onTextDelta?.("partial");
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) {
          resolveCancelled?.();
          resolve();
          return;
        }
        options?.signal?.addEventListener("abort", () => {
          resolveCancelled?.();
          resolve();
        }, { once: true });
      });
      options?.signal?.throwIfAborted();
      return { kind: "final" as const, text: "unreachable" };
    },
  };
  const server = createWebApiServer({ repository, provider });

  try {
    const baseUrl = await listen(server);
    const created = await createWebSession(baseUrl);
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "cancel this" }),
      signal: controller.signal,
    });
    const readEvent = createSseEventReader(response.body!.getReader());
    assert.equal((await readEvent()).event, "turn.started");
    assert.equal((await readEvent()).event, "model.started");
    assert.equal((await readEvent()).event, "assistant.delta");
    controller.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cancelled,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Provider did not receive cancellation.")), 3000);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    const history = await fetch(`${baseUrl}/api/sessions/${created.sessionId}/history`).then((result) => result.json()) as {
      messages: Array<{ role: string }>;
    };
    assert.deepEqual(history.messages.map((message) => message.role), ["user"]);
  } finally {
    await close(server);
    await repository.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function createWebSession(baseUrl: string): Promise<{ sessionId: string }> {
  const created = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((response) => response.json()) as { session: { id: string } };
  return { sessionId: created.session.id };
}

function createSseEventReader(reader: ReadableStreamDefaultReader<Uint8Array>): () => Promise<{ event: string; data: unknown }> {
  const decoder = new TextDecoder();
  const queued: string[] = [];
  let buffer = "";
  return async () => {
    while (queued.length === 0) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream ended before the expected event.");
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r\n\r\n|\n\n|\r\r/);
      buffer = frames.pop() ?? "";
      queued.push(...frames);
    }
    const frame = queued.shift() ?? "";
    const lines = frame.split(/\r\n|\n|\r/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
    const data = lines.filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    return { event, data: JSON.parse(data) as unknown };
  };
}

async function listen(server: ReturnType<typeof createWebApiServer>): Promise<string> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createWebApiServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
    server.closeAllConnections();
  });
}
