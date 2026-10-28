import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cliPath = resolve(__dirname, "../../apps/cli/src/main.js");

function runCli(dataDir: string, args: string[], envOverrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args, "--data-dir", dataDir], {
    encoding: "utf8",
    env: childEnvironment(envOverrides),
  });
}

function runCliAsync(dataDir: string, args: string[], envOverrides: NodeJS.ProcessEnv = {}): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(process.execPath, [cliPath, ...args, "--data-dir", dataDir], {
      env: childEnvironment(envOverrides),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectProcess);
    child.once("close", (status) => resolveProcess({ status, stdout, stderr }));
  });
}

function childEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  if (!Object.prototype.hasOwnProperty.call(overrides, "LM_API_TOKEN")) {
    delete env.LM_API_TOKEN;
  }
  return env;
}

function runCliFrom(cwd: string, args: string[], envDataDir?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, INIT_CWD: cwd };
  if (envDataDir === undefined) {
    delete env.SMYS_DATA_DIR;
  } else {
    env.SMYS_DATA_DIR = envDataDir;
  }
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", cwd, env });
}

async function readStore(dataDir: string): Promise<{ sessions: Array<{ id: string }>; messages: unknown[] }> {
  return JSON.parse(await readFile(join(dataDir, "store.json"), "utf8")) as {
    sessions: Array<{ id: string }>;
    messages: unknown[];
  };
}

async function startLmStudioStub(status: number, payload: unknown): Promise<{
  endpoint: string;
  requests: Array<{ method: string | undefined; path: string | undefined; authorization: string | undefined; body: unknown }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{
    method: string | undefined;
    path: string | undefined;
    authorization: string | undefined;
    body: unknown;
  }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine the local test server address.");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    requests,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
    }),
  };
}

test("two CLI processes create and then read one persisted message as JSON", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-cli-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const text = "survives a process restart";

  const firstProcess = runCli(dataDir, ["session", "create", "--json", "--initial-message", text]);
  assert.equal(firstProcess.status, 0, firstProcess.stderr);
  assert.equal(firstProcess.stderr, "");
  const created = JSON.parse(firstProcess.stdout) as {
    ok: boolean;
    session: { id: string };
    message: { id: string; role: string; sequence: number; content: Array<{ type: string; text: string }> };
  };
  assert.equal(created.ok, true);
  assert.equal(created.message.role, "user");
  assert.equal(created.message.sequence, 1);
  assert.deepEqual(created.message.content, [{ type: "text", text }]);

  const secondProcess = runCli(dataDir, ["history", "get", "--json", "--session-id", created.session.id]);
  assert.equal(secondProcess.status, 0, secondProcess.stderr);
  assert.equal(secondProcess.stderr, "");
  const history = JSON.parse(secondProcess.stdout) as {
    ok: boolean;
    sessionId: string;
    messages: Array<{ id: string; role: string; sequence: number; content: Array<{ type: string; text: string }> }>;
  };
  assert.equal(history.ok, true);
  assert.equal(history.sessionId, created.session.id);
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0]?.id, created.message.id);
  assert.equal(history.messages[0]?.role, "user");
  assert.equal(history.messages[0]?.sequence, 1);
  assert.deepEqual(history.messages[0]?.content, [{ type: "text", text }]);
});

test("message send persists through the application API and CLI exposes stable errors", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-cli-send-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  const createdProcess = runCli(dataDir, ["session", "create", "--json"]);
  assert.equal(createdProcess.status, 0, createdProcess.stderr);
  const created = JSON.parse(createdProcess.stdout) as { session: { id: string } };

  const sendProcess = runCli(dataDir, ["message", "send", "--json", "--session-id", created.session.id, "--text", "second CLI command"]);
  assert.equal(sendProcess.status, 0, sendProcess.stderr);
  const sent = JSON.parse(sendProcess.stdout) as { message: { role: string; sequence: number } };
  assert.equal(sent.message.role, "user");
  assert.equal(sent.message.sequence, 1);

  const missingSessionProcess = runCli(dataDir, ["history", "get", "--json", "--session-id", "missing"]);
  assert.equal(missingSessionProcess.status, 3);
  assert.deepEqual(JSON.parse(missingSessionProcess.stderr), {
    ok: false,
    error: { code: "SESSION_NOT_FOUND", message: "Session not found: missing" },
  });

  const invalidArgumentsProcess = runCli(dataDir, ["history", "get", "--json"]);
  assert.equal(invalidArgumentsProcess.status, 2);
  assert.equal((JSON.parse(invalidArgumentsProcess.stderr) as { error: { code: string } }).error.code, "INVALID_ARGUMENT");
});

test("fake agent turn persists an assistant reply for a separate history process", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-cli-turn-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  const createdProcess = runCli(dataDir, ["session", "create", "--json"]);
  assert.equal(createdProcess.status, 0, createdProcess.stderr);
  const created = JSON.parse(createdProcess.stdout) as { session: { id: string } };

  const agentProcess = runCli(dataDir, [
    "agent", "run", "--json", "--provider", "fake", "--session-id", created.session.id, "--text", "deterministic input",
  ]);
  assert.equal(agentProcess.status, 0, agentProcess.stderr);
  const result = JSON.parse(agentProcess.stdout) as {
    ok: boolean;
    userMessage: { role: string; sequence: number; content: Array<{ text: string }> };
    assistantMessage: { role: string; sequence: number; content: Array<{ text: string }> };
  };
  assert.equal(result.ok, true);
  assert.equal(result.userMessage.role, "user");
  assert.equal(result.userMessage.sequence, 1);
  assert.equal(result.assistantMessage.role, "assistant");
  assert.equal(result.assistantMessage.sequence, 2);
  assert.deepEqual(result.assistantMessage.content, [{ type: "text", text: "Fake response to: deterministic input" }]);

  const historyProcess = runCli(dataDir, ["history", "get", "--json", "--session-id", created.session.id]);
  assert.equal(historyProcess.status, 0, historyProcess.stderr);
  const history = JSON.parse(historyProcess.stdout) as {
    messages: Array<{ role: string; sequence: number; content: Array<{ text: string }> }>;
  };
  assert.deepEqual(history.messages.map((message) => [message.role, message.sequence, message.content[0]?.text]), [
    ["user", 1, "deterministic input"],
    ["assistant", 2, "Fake response to: deterministic input"],
  ]);

  const implicitProviderProcess = runCli(dataDir, ["agent", "run", "--json", "--session-id", created.session.id, "--text", "no implicit fake"]);
  assert.equal(implicitProviderProcess.status, 2);
  assert.equal((JSON.parse(implicitProviderProcess.stderr) as { error: { code: string } }).error.code, "INVALID_ARGUMENT");

  const missingModelProcess = runCli(dataDir, [
    "agent", "run", "--json", "--provider", "lm-studio", "--session-id", created.session.id, "--text", "missing model",
  ]);
  assert.equal(missingModelProcess.status, 2);
  assert.equal((JSON.parse(missingModelProcess.stderr) as { error: { code: string } }).error.code, "INVALID_ARGUMENT");
});

test("CLI fake smoke explicitly enables and permits demo.add", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-cli-demo-add-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  const createdProcess = runCli(dataDir, ["session", "create", "--json"]);
  assert.equal(createdProcess.status, 0, createdProcess.stderr);
  const created = JSON.parse(createdProcess.stdout) as { session: { id: string } };
  const runProcess = runCli(dataDir, [
    "agent", "run", "--json", "--provider", "fake", "--session-id", created.session.id,
    "--text", "smoke demo.add", "--tool", "demo.add", "--allow-tool", "demo.add",
  ]);

  assert.equal(runProcess.status, 0, runProcess.stderr);
  const result = JSON.parse(runProcess.stdout) as {
    assistantMessage: { role: string; content: Array<{ text: string }> };
  };
  assert.equal(result.assistantMessage.role, "assistant");
  assert.deepEqual(result.assistantMessage.content, [{ type: "text", text: "Fake demo.add result: 5" }]);

  const deniedSessionProcess = runCli(dataDir, ["session", "create", "--json"]);
  assert.equal(deniedSessionProcess.status, 0, deniedSessionProcess.stderr);
  const deniedSession = JSON.parse(deniedSessionProcess.stdout) as { session: { id: string } };
  const deniedRun = runCli(dataDir, [
    "agent", "run", "--json", "--provider", "fake", "--session-id", deniedSession.session.id,
    "--text", "smoke demo.add without permission", "--tool", "demo.add",
  ]);

  assert.equal(deniedRun.status, 1);
  assert.deepEqual(JSON.parse(deniedRun.stderr), {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "The tool call was denied." },
  });
  const historyProcess = runCli(dataDir, ["history", "get", "--json", "--session-id", deniedSession.session.id]);
  assert.equal(historyProcess.status, 0, historyProcess.stderr);
  const history = JSON.parse(historyProcess.stdout) as { messages: Array<{ role: string }> };
  assert.deepEqual(history.messages.map((message) => message.role), ["user"]);
});

test("LM Studio CLI turns persist and a separate history process reads them", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-cli-lm-studio-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const stub = await startLmStudioStub(200, {
    choices: [{ message: { role: "assistant", content: "stubbed model reply" } }],
  });
  t.after(stub.close);

  const createdProcess = runCli(dataDir, ["session", "create", "--json"]);
  assert.equal(createdProcess.status, 0, createdProcess.stderr);
  const created = JSON.parse(createdProcess.stdout) as { session: { id: string } };

  const firstRun = await runCliAsync(dataDir, [
    "agent", "run", "--json", "--provider", "lm-studio", "--model", "publisher/model-id",
    "--endpoint", stub.endpoint, "--session-id", created.session.id, "--text", "first LM Studio request",
  ], {
    LM_STUDIO_ENDPOINT: "http://127.0.0.1:1/unused",
    LM_API_TOKEN: "mock-token",
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const secondRun = await runCliAsync(dataDir, [
    "agent", "run", "--json", "--provider", "lm-studio", "--model", "publisher/model-id",
    "--session-id", created.session.id, "--text", "second LM Studio request",
  ], { LM_STUDIO_ENDPOINT: stub.endpoint });
  assert.equal(secondRun.status, 0, secondRun.stderr);

  assert.deepEqual(stub.requests.map(({ method, path, body }) => ({ method, path, body })), [
    {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "publisher/model-id",
        messages: [{ role: "user", content: "first LM Studio request" }],
        stream: false,
      },
    },
    {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "publisher/model-id",
        messages: [
          { role: "user", content: "first LM Studio request" },
          { role: "assistant", content: "stubbed model reply" },
          { role: "user", content: "second LM Studio request" },
        ],
        stream: false,
      },
    },
  ]);
  assert.equal(stub.requests[0]?.authorization, "Bearer mock-token");
  assert.equal(stub.requests[1]?.authorization, undefined);

  const historyProcess = await runCliAsync(dataDir, ["history", "get", "--json", "--session-id", created.session.id]);
  assert.equal(historyProcess.status, 0, historyProcess.stderr);
  const history = JSON.parse(historyProcess.stdout) as {
    messages: Array<{ role: string; sequence: number; content: Array<{ text: string }> }>;
  };
  assert.deepEqual(history.messages.map((message) => [message.role, message.sequence, message.content[0]?.text]), [
    ["user", 1, "first LM Studio request"],
    ["assistant", 2, "stubbed model reply"],
    ["user", 3, "second LM Studio request"],
    ["assistant", 4, "stubbed model reply"],
  ]);
});

test("LM Studio HTTP failure uses the CLI error contract and leaves the user message in history", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-cli-lm-studio-error-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const stub = await startLmStudioStub(503, { error: "private server response" });
  t.after(stub.close);

  const createdProcess = await runCliAsync(dataDir, ["session", "create", "--json"]);
  assert.equal(createdProcess.status, 0, createdProcess.stderr);
  const created = JSON.parse(createdProcess.stdout) as { session: { id: string } };

  const runProcess = await runCliAsync(dataDir, [
    "agent", "run", "--json", "--provider", "lm-studio", "--model", "publisher/model-id",
    "--endpoint", stub.endpoint, "--session-id", created.session.id, "--text", "request that fails",
  ]);
  assert.equal(runProcess.status, 1);
  assert.deepEqual(JSON.parse(runProcess.stderr), {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "LM Studio returned HTTP 503." },
  });
  assert.equal(runProcess.stderr.includes("private server response"), false);

  const historyProcess = await runCliAsync(dataDir, ["history", "get", "--json", "--session-id", created.session.id]);
  assert.equal(historyProcess.status, 0, historyProcess.stderr);
  const history = JSON.parse(historyProcess.stdout) as {
    messages: Array<{ role: string; content: Array<{ text: string }> }>;
  };
  assert.deepEqual(history.messages.map((message) => [message.role, message.content[0]?.text]), [
    ["user", "request that fails"],
  ]);
});

test("default storage is under the launch directory and survives another CLI process", async (t) => {
  const launchDir = await mkdtemp(join(tmpdir(), "smys-agent-cwd-"));
  t.after(async () => rm(launchDir, { recursive: true, force: true }));
  const text = "cwd default storage";

  const firstProcess = runCliFrom(launchDir, ["session", "create", "--json", "--initial-message", text]);
  assert.equal(firstProcess.status, 0, firstProcess.stderr);
  const created = JSON.parse(firstProcess.stdout) as { session: { id: string }; message: { id: string } };

  const store = await readStore(join(launchDir, ".smys-agent"));
  assert.equal(store.sessions.length, 1);
  assert.equal(store.messages.length, 1);

  const secondProcess = runCliFrom(launchDir, ["history", "get", "--json", "--session-id", created.session.id]);
  assert.equal(secondProcess.status, 0, secondProcess.stderr);
  const history = JSON.parse(secondProcess.stdout) as { messages: Array<{ id: string; content: Array<{ text: string }> }> };
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0]?.id, created.message.id);
  assert.equal(history.messages[0]?.content[0]?.text, text);
});

test("SMYS_DATA_DIR overrides the launch directory and --data-dir overrides SMYS_DATA_DIR", async (t) => {
  const launchDir = await mkdtemp(join(tmpdir(), "smys-agent-override-cwd-"));
  const envDataDir = await mkdtemp(join(tmpdir(), "smys-agent-env-"));
  const optionDataDir = await mkdtemp(join(tmpdir(), "smys-agent-option-"));
  t.after(async () => {
    await Promise.all([
      rm(launchDir, { recursive: true, force: true }),
      rm(envDataDir, { recursive: true, force: true }),
      rm(optionDataDir, { recursive: true, force: true }),
    ]);
  });

  const envProcess = runCliFrom(launchDir, ["session", "create", "--json"], envDataDir);
  assert.equal(envProcess.status, 0, envProcess.stderr);
  assert.equal((await readStore(envDataDir)).sessions.length, 1);
  await assert.rejects(readFile(join(launchDir, ".smys-agent", "store.json")), { code: "ENOENT" });

  const optionProcess = runCliFrom(
    launchDir,
    ["session", "create", "--json", "--data-dir", optionDataDir],
    envDataDir,
  );
  assert.equal(optionProcess.status, 0, optionProcess.stderr);
  assert.equal((await readStore(optionDataDir)).sessions.length, 1);
  assert.equal((await readStore(envDataDir)).sessions.length, 1);
});
