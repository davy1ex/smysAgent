import assert from "node:assert/strict";
import test from "node:test";
import { LmStudioProvider, LmStudioProviderError } from "../../packages/providers/src/lm-studio-provider";
import type { Message } from "../../packages/core/src/session";

const endpoint = "http://localhost:1234/v1/chat/completions";
const messages: Message[] = [
  {
    id: "user-1",
    sessionId: "session-1",
    sequence: 1,
    role: "user",
    content: [{ type: "text", text: "first message" }],
    createdAt: "2026-10-28T10:00:00.000Z",
  },
  {
    id: "assistant-1",
    sessionId: "session-1",
    sequence: 2,
    role: "assistant",
    content: [{ type: "text", text: "earlier reply" }],
    createdAt: "2026-10-28T10:00:01.000Z",
  },
];

test("LM Studio provider sends the complete text history without streaming or tools", async () => {
  let requestUrl: RequestInfo | URL | undefined;
  let requestInit: RequestInit | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = input;
    requestInit = init;
    return jsonResponse({ choices: [{ message: { role: "assistant", content: "model reply" } }] });
  };
  const provider = new LmStudioProvider({
    endpoint,
    model: "publisher/model-id",
    apiToken: "mock-token",
    fetcher,
  });

  assert.equal(await provider.generate(messages), "model reply");
  assert.equal(requestUrl, endpoint);
  assert.equal(requestInit?.method, "POST");
  assert.equal(new Headers(requestInit?.headers).get("content-type"), "application/json");
  assert.equal(new Headers(requestInit?.headers).get("authorization"), "Bearer mock-token");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    model: "publisher/model-id",
    messages: [
      { role: "user", content: "first message" },
      { role: "assistant", content: "earlier reply" },
    ],
    stream: false,
  });
});

test("LM Studio provider omits authorization when no token is configured", async () => {
  let requestHeaders: Headers | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    requestHeaders = new Headers(init?.headers);
    return jsonResponse({ choices: [{ message: { role: "assistant", content: "reply" } }] });
  };
  const provider = new LmStudioProvider({ endpoint, model: "model-id", fetcher });

  await provider.generate(messages.slice(0, 1));

  assert.equal(requestHeaders?.has("authorization"), false);
});

test("LM Studio provider normalizes a connection failure", async () => {
  const fetcher: typeof fetch = async () => {
    throw new Error("sensitive low-level transport details");
  };
  const provider = new LmStudioProvider({ endpoint, model: "model-id", fetcher });

  await assert.rejects(provider.generate(messages), (error: unknown) => {
    assert.ok(error instanceof LmStudioProviderError);
    assert.equal(error.message, "Could not connect to LM Studio.");
    assert.equal(error.message.includes("sensitive"), false);
    return true;
  });
});

test("LM Studio provider reports HTTP failures without exposing the response body", async () => {
  const fetcher: typeof fetch = async () => new Response("private server details", { status: 503 });
  const provider = new LmStudioProvider({ endpoint, model: "model-id", fetcher });

  await assert.rejects(provider.generate(messages), (error: unknown) => {
    assert.ok(error instanceof LmStudioProviderError);
    assert.equal(error.message, "LM Studio returned HTTP 503.");
    assert.equal(error.message.includes("private"), false);
    return true;
  });
});

test("LM Studio provider rejects malformed JSON and missing or empty assistant text", async () => {
  const invalidResponses: Array<() => Promise<Response>> = [
    async () => new Response("not json", { status: 200 }),
    async () => jsonResponse({ choices: [] }),
    async () => jsonResponse({ choices: [{ message: {} }] }),
    async () => jsonResponse({ choices: [{ message: { content: null } }] }),
    async () => jsonResponse({ choices: [{ message: { content: "" } }] }),
  ];

  for (const respond of invalidResponses) {
    const fetcher: typeof fetch = async () => respond();
    const provider = new LmStudioProvider({ endpoint, model: "model-id", fetcher });
    await assert.rejects(provider.generate(messages), (error: unknown) => {
      assert.ok(error instanceof LmStudioProviderError);
      assert.equal(error.message, "LM Studio returned an invalid chat completion response.");
      return true;
    });
  }
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
