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
  });
}
