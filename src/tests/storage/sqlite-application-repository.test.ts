import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteApplicationRepository } from "../../packages/storage";

test("SQLite stores ordered completed run steps and keeps them after reopening", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-sqlite-run-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const repository = new SqliteApplicationRepository(dataDir);
  await repository.createSession({ id: "session-1", createdAt: "2026-11-02T08:00:00.000Z" });
  const user = await repository.appendUserMessage("session-1", {
    id: "user-1",
    createdAt: "2026-11-02T08:01:00.000Z",
    text: "calculate",
  });
  assert.ok(user);
  await repository.completeRun({
    run: {
      id: "run-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      status: "completed",
      startedAt: "2026-11-02T08:01:00.000Z",
      completedAt: "2026-11-02T08:01:04.000Z",
      modelSelection: {
        providerId: "provider-1",
        providerName: "Local provider",
        modelConfigId: "model-config-1",
        modelId: "model-a",
        modelName: "Model A",
      },
      steps: [
        { type: "model", callIndex: 1, phase: "waiting" },
        { type: "reasoning", callIndex: 1, text: "Prepare calculation.\nSecond line." },
        { type: "tool", callIndex: 1, callId: "tool-1", name: "demo.add", arguments: { a: 2, b: 3 }, result: "5" },
        { type: "model", callIndex: 2, phase: "generating" },
        { type: "reasoning", callIndex: 2, text: "Use the result." },
      ],
    },
    assistantMessage: {
      id: "assistant-1",
      createdAt: "2026-11-02T08:01:04.000Z",
      text: "The sum is 5.",
    },
  });
  await repository.close();

  const reopened = new SqliteApplicationRepository(dataDir);
  const history = await reopened.getHistory("session-1");
  const runs = await reopened.listCompletedRuns("session-1");
  await reopened.close();

  assert.deepEqual(history?.messages.map((message) => [message.id, message.role, message.content[0].text]), [
    ["user-1", "user", "calculate"],
    ["assistant-1", "assistant", "The sum is 5."],
  ]);
  assert.equal(history?.messages[1]?.role === "assistant" ? history.messages[1].reasoning : undefined, undefined);
  assert.deepEqual(runs[0]?.steps, [
    { type: "model", callIndex: 1, phase: "waiting" },
    { type: "reasoning", callIndex: 1, text: "Prepare calculation.\nSecond line." },
    { type: "tool", callIndex: 1, callId: "tool-1", name: "demo.add", arguments: { a: 2, b: 3 }, result: "5" },
    { type: "model", callIndex: 2, phase: "generating" },
    { type: "reasoning", callIndex: 2, text: "Use the result." },
  ]);
  assert.equal(runs[0]?.userMessageId, "user-1");
  assert.equal(runs[0]?.assistantMessageId, "assistant-1");
  assert.deepEqual(runs[0]?.modelSelection, {
    providerId: "provider-1",
    providerName: "Local provider",
    modelConfigId: "model-config-1",
    modelId: "model-a",
    modelName: "Model A",
  });
});

test("SQLite keeps provider/model configuration and selections after reopening", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-sqlite-provider-config-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const repository = new SqliteApplicationRepository(dataDir);
  await repository.createSession({ id: "config-session", createdAt: "2026-11-02T08:00:00.000Z" });
  await repository.saveProviderConfiguration({
    id: "provider-1",
    name: "Local provider",
    protocol: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:1234/v1",
    credentialRef: "vault-reference-only",
    allowInsecureHttp: false,
    createdAt: "2026-11-02T08:00:00.000Z",
    updatedAt: "2026-11-02T08:00:00.000Z",
  });
  await repository.saveModelConfiguration({
    id: "model-config-1",
    providerId: "provider-1",
    modelId: "model-a",
    displayName: "Model A",
    source: "manual",
    capabilities: { streaming: "unknown", toolCalling: "unknown", reasoning: "unknown" },
    createdAt: "2026-11-02T08:00:00.000Z",
    updatedAt: "2026-11-02T08:00:00.000Z",
  });
  await repository.setDefaultModelConfigId("model-config-1");
  await repository.setSessionModelConfigId("config-session", "model-config-1");
  await repository.close();

  const reopened = new SqliteApplicationRepository(dataDir);
  const providers = await reopened.listProviderConfigurations();
  const models = await reopened.listModelConfigurations();
  const defaultModelConfigId = await reopened.getDefaultModelConfigId();
  const sessionModelConfigId = await reopened.getSessionModelConfigId("config-session");
  await reopened.close();

  assert.equal(providers[0]?.credentialRef, "vault-reference-only");
  assert.equal(providers[0]?.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(models[0]?.modelId, "model-a");
  assert.equal(defaultModelConfigId, "model-config-1");
  assert.equal(sessionModelConfigId, "model-config-1");
});

test("SQLite schema v1 migrates in place to provider and model configuration", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-sqlite-v1-migration-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const database = new Database(join(dataDir, "store.sqlite"));
  database.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, extra_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, role TEXT NOT NULL,
      content_text TEXT NOT NULL, created_at TEXT NOT NULL, reasoning_json TEXT, extra_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_message_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT NOT NULL
    );
    CREATE TABLE agent_run_steps (run_id TEXT NOT NULL, ordinal INTEGER NOT NULL, step_json TEXT NOT NULL);
    CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    INSERT INTO sessions (id, created_at) VALUES ('legacy-session', '2026-11-02T08:00:00.000Z');
    INSERT INTO messages (id, session_id, sequence, role, content_text, created_at)
      VALUES ('legacy-user', 'legacy-session', 1, 'user', 'before migration', '2026-11-02T08:01:00.000Z');
    PRAGMA user_version = 1;
  `);
  database.close();

  const migrated = new SqliteApplicationRepository(dataDir);
  const history = await migrated.getHistory("legacy-session");
  assert.equal(history?.messages[0]?.content[0]?.text, "before migration");
  assert.equal(await migrated.getSessionModelConfigId("legacy-session"), null);
  assert.deepEqual(await migrated.listCompletedRuns("legacy-session"), []);
  await migrated.close();

  const check = new Database(join(dataDir, "store.sqlite"), { readonly: true });
  assert.equal(check.pragma("user_version", { simple: true }), 2);
  const configTables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('provider_configs', 'model_configs') ORDER BY name").all();
  assert.deepEqual(configTables, [{ name: "model_configs" }, { name: "provider_configs" }]);
  check.close();
});

test("SQLite imports JSON v1, v2, and v3 once, retaining legacy reasoning and exact backups", async (t) => {
  const fixtures = [
    {
      formatVersion: 1,
      sessions: [{ id: "session-v1", createdAt: "2026-11-02T08:00:00.000Z" }],
      messages: [{
        id: "user-v1", sessionId: "session-v1", sequence: 1, role: "user",
        content: [{ type: "text", text: "legacy v1" }], createdAt: "2026-11-02T08:01:00.000Z",
      }],
    },
    {
      formatVersion: 2,
      sessions: [{ id: "session-v2", createdAt: "2026-11-02T08:00:00.000Z" }],
      messages: [
        {
          id: "user-v2", sessionId: "session-v2", sequence: 1, role: "user",
          content: [{ type: "text", text: "legacy v2" }], createdAt: "2026-11-02T08:01:00.000Z",
        },
        {
          id: "assistant-v2", sessionId: "session-v2", sequence: 2, role: "assistant",
          content: [{ type: "text", text: "old answer" }], createdAt: "2026-11-02T08:02:00.000Z",
        },
      ],
    },
    {
      formatVersion: 3,
      sessions: [{ id: "session-v3", createdAt: "2026-11-02T08:00:00.000Z" }],
      messages: [
        {
          id: "user-v3", sessionId: "session-v3", sequence: 1, role: "user",
          content: [{ type: "text", text: "legacy v3" }], createdAt: "2026-11-02T08:01:00.000Z",
        },
        {
          id: "assistant-v3", sessionId: "session-v3", sequence: 2, role: "assistant",
          content: [{ type: "text", text: "old answer" }], createdAt: "2026-11-02T08:02:00.000Z",
          reasoning: [{ callIndex: 1, text: "Legacy reasoning." }],
        },
      ],
    },
  ];

  for (const fixture of fixtures) {
    const dataDir = await mkdtemp(join(tmpdir(), `smys-agent-sqlite-v${fixture.formatVersion}-`));
    t.after(async () => rm(dataDir, { recursive: true, force: true }));
    const original = Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`);
    await writeFile(join(dataDir, "store.json"), original);
    const repository = new SqliteApplicationRepository(dataDir);
    const history = await repository.getHistory(fixture.sessions[0]!.id);
    assert.equal(history?.messages.length, fixture.messages.length);
    assert.deepEqual(await repository.listCompletedRuns(fixture.sessions[0]!.id), []);
    if (fixture.formatVersion === 3) {
      const assistant = history?.messages[1];
      assert.equal(assistant?.role === "assistant" ? assistant.reasoning?.[0]?.text : undefined, "Legacy reasoning.");
    }
    await repository.close();

    assert.deepEqual(await readFile(join(dataDir, `store.json.v${fixture.formatVersion}.sqlite.bak`)), original);
    const reopened = new SqliteApplicationRepository(dataDir);
    const reopenedHistory = await reopened.getHistory(fixture.sessions[0]!.id);
    await reopened.close();
    assert.equal(reopenedHistory?.messages.length, fixture.messages.length);
  }
});

test("failed completed-run transaction does not leave an assistant message", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-sqlite-atomic-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const repository = new SqliteApplicationRepository(dataDir);
  await repository.createSession({ id: "session", createdAt: "2026-11-02T08:00:00.000Z" });
  await repository.appendUserMessage("session", {
    id: "user", createdAt: "2026-11-02T08:01:00.000Z", text: "hello",
  });
  await assert.rejects(repository.completeRun({
    run: {
      id: "run", sessionId: "session", userMessageId: "user", assistantMessageId: "assistant",
      status: "completed", startedAt: "2026-11-02T08:01:00.000Z", completedAt: "2026-11-02T08:02:00.000Z",
      steps: [{ type: "tool", callIndex: 1, callId: "call", name: "tool", arguments: 1n, result: "result" }],
    },
    assistantMessage: { id: "assistant", createdAt: "2026-11-02T08:02:00.000Z", text: "answer" },
  }));
  const history = await repository.getHistory("session");
  assert.deepEqual(history?.messages.map((message) => message.role), ["user"]);
  assert.deepEqual(await repository.listCompletedRuns("session"), []);
  await repository.close();
});
