import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRequest } from "../../packages/core/agent";
import { LmStudioProvider, LmStudioProviderError } from "../../packages/providers/lm-studio-provider";
import type { Message } from "../../packages/core/session";

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

const request: ModelRequest = {
  messages: messages.map((message) => ({ role: message.role, content: message.content[0].text })),
  tools: [],
};

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

  assert.deepEqual(await provider.generate(request), { kind: "final", text: "model reply" });
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

  await provider.generate({ ...request, messages: request.messages.slice(0, 1) });

  assert.equal(requestHeaders?.has("authorization"), false);
});

test("LM Studio provider streams text deltas from an OpenAI-compatible SSE response", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new LmStudioProvider({
    endpoint,
    model: "model-id",
    fetcher: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"first "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"second"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    },
  });

  const chunks: string[] = [];
  for await (const delta of provider.streamText(request)) chunks.push(delta);

  assert.deepEqual(chunks, ["first ", "second"]);
  assert.deepEqual(requestBody, {
    model: "model-id",
    messages: request.messages,
    stream: true,
  });
});

test("LM Studio provider yields a token before the upstream stream completes", async () => {
  let releaseStream: (() => void) | undefined;
  const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
  const provider = new LmStudioProvider({
    endpoint,
    model: "model-id",
    fetcher: async () => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"early"}}]}\n\n'));
        await streamGate;
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  });

  const iterator = provider.streamText(request)[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: "early", done: false });
  releaseStream?.();
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
});

test("LM Studio provider rejects an interrupted SSE response without a done marker", async () => {
  const provider = new LmStudioProvider({
    endpoint,
    model: "model-id",
    fetcher: async () => sseResponse(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']),
  });

  const chunks: string[] = [];
  await assert.rejects(
    async () => { for await (const delta of provider.streamText(request)) chunks.push(delta); },
    (error: unknown) => error instanceof LmStudioProviderError && error.message === "LM Studio text stream ended unexpectedly.",
  );
  assert.deepEqual(chunks, ["partial"]);
});

test("LM Studio provider propagates cancellation to the upstream stream", async () => {
  const controller = new AbortController();
  const provider = new LmStudioProvider({
    endpoint,
    model: "model-id",
    fetcher: async (_input, init) => {
      assert.equal(init?.signal, controller.signal);
      return new Response(new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        },
        cancel() {},
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  const iterator = provider.streamText(request, { signal: controller.signal })[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), { value: "partial", done: false });
  controller.abort();
  await assert.rejects(iterator.next(), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("LM Studio provider returns reasoning separately from the final text", async () => {
  const provider = new LmStudioProvider({
    endpoint,
    model: "model-id",
    fetcher: async () => jsonResponse({
      choices: [{
        message: {
          role: "assistant",
          content: "final answer",
          reasoning_content: "reasoning text",
        },
      }],
    }),
  });

  assert.deepEqual(await provider.generate(request), {
    kind: "final",
    text: "final answer",
    reasoning: "reasoning text",
  });
});

test("LM Studio provider normalizes a connection failure", async () => {
  const fetcher: typeof fetch = async () => {
    throw new Error("sensitive low-level transport details");
  };
  const provider = new LmStudioProvider({ endpoint, model: "model-id", fetcher });

  await assert.rejects(provider.generate(request), (error: unknown) => {
    assert.ok(error instanceof LmStudioProviderError);
    assert.equal(error.message, "Could not connect to LM Studio.");
    assert.equal(error.message.includes("sensitive"), false);
    return true;
  });
});

test("LM Studio provider reports HTTP failures without exposing the response body", async () => {
  const fetcher: typeof fetch = async () => new Response("private server details", { status: 503 });
  const provider = new LmStudioProvider({ endpoint, model: "model-id", fetcher });

  await assert.rejects(provider.generate(request), (error: unknown) => {
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
    await assert.rejects(provider.generate(request), (error: unknown) => {
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

test("LM Studio provider sends one tool definition and parses one function call", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "Preparing the tool call.",
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "test.echo", arguments: '{"text":"hello"}' },
          }],
        },
      }],
    });
  };
  const toolDefinition = {
    name: "test.echo",
    description: "Returns text.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  };
  const provider = new LmStudioProvider({ endpoint, model: "model-id", fetcher });

  assert.deepEqual(await provider.generate({ ...request, tools: [toolDefinition] }), {
    kind: "tool-call",
    callId: "call-1",
    name: "test.echo",
    arguments: { text: "hello" },
    reasoning: "Preparing the tool call.",
  });
  assert.deepEqual(requestBody?.tools, [{
    type: "function",
    function: {
      name: "test.echo",
      description: "Returns text.",
      parameters: toolDefinition.inputSchema,
    },
  }]);
  assert.equal(requestBody?.tool_choice, "auto");
});

test("LM Studio provider accepts a final text response with an empty tool_calls array", async () => {
  const provider = new LmStudioProvider({
    endpoint,
    model: "liquid/lfm2.5-1.2b",
    fetcher: async () => jsonResponse({
      choices: [{
        message: {
          role: "assistant",
          content: "SMOKE_OK",
          reasoning_content: "",
          tool_calls: [],
        },
      }],
    }),
  });

  assert.deepEqual(await provider.generate(request), { kind: "final", text: "SMOKE_OK" });
});

test("LM Studio provider serializes intermediate tool messages for the follow-up request", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ choices: [{ message: { role: "assistant", content: "final" } }] });
  };
  const provider = new LmStudioProvider({ endpoint, model: "model-id", fetcher });

  const result = await provider.generate({
    messages: [
      { role: "user", content: "use tool" },
      {
        role: "assistant",
        toolCall: { callId: "call-1", name: "test.echo", arguments: { text: "hello" } },
      },
      { role: "tool", callId: "call-1", name: "test.echo", content: "hello" },
    ],
    tools: [],
  });

  assert.deepEqual(result, { kind: "final", text: "final" });
  assert.deepEqual(requestBody?.messages, [
    { role: "user", content: "use tool" },
    {
      role: "assistant",
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "test.echo", arguments: '{"text":"hello"}' },
      }],
    },
    { role: "tool", tool_call_id: "call-1", content: "hello" },
  ]);
  assert.equal("tools" in (requestBody ?? {}), false);
});

test("LM Studio provider rejects malformed and multiple tool calls", async () => {
  const invalidPayloads: unknown[] = [
    { choices: [{ message: { tool_calls: [] } }] },
    { choices: [{ message: { tool_calls: [{ id: "call-1", type: "function", function: { name: "x", arguments: "{" } }] } }] },
    {
      choices: [{
        message: {
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "x", arguments: "{}" } },
            { id: "call-2", type: "function", function: { name: "x", arguments: "{}" } },
          ],
        },
      }],
    },
  ];

  for (const payload of invalidPayloads) {
    const provider = new LmStudioProvider({
      endpoint,
      model: "model-id",
      fetcher: async () => jsonResponse(payload),
    });
    await assert.rejects(provider.generate(request), LmStudioProviderError);
  }
});
