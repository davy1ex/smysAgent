import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProviderError, OpenAICompatibleProviderFactory } from "../../packages/providers/lm-studio-provider";

test("OpenAI-compatible model discovery sends bearer auth and only follows the configured endpoint", async () => {
  const requests: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
  const factory = new OpenAICompatibleProviderFactory(async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect,
    });
    return new Response(JSON.stringify({ data: [{ id: " model-one " }, { id: "model-two" }, { id: "model-one" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  assert.deepEqual(await factory.discoverModels({ baseUrl: "http://localhost:1234/v1/", apiToken: "runtime-secret" }), ["model-one", "model-two"]);
  assert.deepEqual(requests, [{
    url: "http://localhost:1234/v1/models",
    authorization: "Bearer runtime-secret",
    redirect: "manual",
  }]);
});

test("OpenAI-compatible discovery reports auth, missing endpoint, redirect, and response size distinctly", async () => {
  const unauthorized = new OpenAICompatibleProviderFactory(async () => new Response("", { status: 401 }));
  await assert.rejects(unauthorized.discoverModels({ baseUrl: "http://localhost:1234/v1" }), /rejected authorization/);

  const missing = new OpenAICompatibleProviderFactory(async () => new Response("", { status: 404 }));
  await assert.rejects(missing.discoverModels({ baseUrl: "http://localhost:1234/v1" }), /enter a Model ID manually/);

  let redirectCalls = 0;
  const redirect = new OpenAICompatibleProviderFactory(async () => {
    redirectCalls += 1;
    return new Response("", { status: 307, headers: { location: "http://attacker.invalid/models" } });
  });
  await assert.rejects(redirect.discoverModels({ baseUrl: "http://localhost:1234/v1", apiToken: "runtime-secret" }), /HTTP 307/);
  assert.equal(redirectCalls, 1);

  const oversized = new OpenAICompatibleProviderFactory(async () => new Response("x".repeat(100), { status: 200 }), 100, 16);
  await assert.rejects(oversized.discoverModels({ baseUrl: "http://localhost:1234/v1" }), OpenAICompatibleProviderError);
});

test("OpenAI-compatible discovery turns network timeouts into a bounded provider error", async () => {
  const factory = new OpenAICompatibleProviderFactory(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }), 5);

  await assert.rejects(factory.discoverModels({ baseUrl: "http://localhost:1234/v1" }), /timed out/);
});

test("OpenAI-compatible provider fixes its model and does not follow inference redirects", async () => {
  let requestBody: Record<string, unknown> | undefined;
  let redirect: RequestRedirect | undefined;
  const factory = new OpenAICompatibleProviderFactory(async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    redirect = init?.redirect;
    return new Response(JSON.stringify({ choices: [{ message: { content: "reply" } }] }), { status: 200 });
  });
  const provider = factory.create({ baseUrl: "http://localhost:1234/v1", modelId: "fixed-model" });
  const response = await provider.generate({ messages: [{ role: "user", content: "hello" }], tools: [] });

  assert.equal(requestBody?.model, "fixed-model");
  assert.equal(redirect, "manual");
  assert.deepEqual(response, { kind: "final", text: "reply" });
});
