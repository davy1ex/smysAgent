import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cliPath = resolve(__dirname, "../../apps/cli/src/main.js");

function runCli(dataDir: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args, "--data-dir", dataDir], {
    encoding: "utf8",
    env: { ...process.env },
  });
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
