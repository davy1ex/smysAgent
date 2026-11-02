import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, getHistory, sendMessage } from "../../packages/application";
import { JsonFileSessionRepository, StorageError } from "../../packages/storage";

test("file storage preserves a message after close and reopen", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-storage-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  const firstRepository = new JsonFileSessionRepository(dataDir);
  const session = await createSession(firstRepository);
  const savedMessage = await sendMessage(firstRepository, {
    sessionId: session.id,
    text: "persist across repository instances",
  });
  await firstRepository.close();

  const reopenedRepository = new JsonFileSessionRepository(dataDir);
  const history = await getHistory(reopenedRepository, session.id);
  await reopenedRepository.close();

  assert.equal(history.session.id, session.id);
  assert.deepEqual(history.messages, [savedMessage]);
});

test("file storage preserves per-call assistant reasoning after close and reopen", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-storage-reasoning-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  const firstRepository = new JsonFileSessionRepository(dataDir);
  const session = await createSession(firstRepository);
  await firstRepository.appendAssistantMessage(session.id, {
    id: "assistant-with-reasoning",
    createdAt: "2026-11-02T10:00:00.000Z",
    text: "final reply",
    reasoning: [
      { callIndex: 1, text: "before tool" },
      { callIndex: 2, text: "after tool" },
    ],
  });
  await firstRepository.close();

  const reopenedRepository = new JsonFileSessionRepository(dataDir);
  const history = await getHistory(reopenedRepository, session.id);
  await reopenedRepository.close();

  const assistantMessage = history.messages.find((message) => message.role === "assistant");
  assert.deepEqual(assistantMessage?.role === "assistant" ? assistantMessage.reasoning : undefined, [
    { callIndex: 1, text: "before tool" },
    { callIndex: 2, text: "after tool" },
  ]);
});

test("v1 history reads without rewriting and first write preserves a backup during v3 migration", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-storage-v1-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const storePath = join(dataDir, "store.json");
  const backupPath = join(dataDir, "store.json.v1.bak");
  const legacy = {
    formatVersion: 1,
    migrationNote: { keep: true },
    sessions: [{ id: "legacy-session", createdAt: "2026-10-27T10:00:00.000Z", customSessionField: "keep" }],
    messages: [{
      id: "legacy-user",
      sessionId: "legacy-session",
      sequence: 1,
      role: "user",
      content: [{ type: "text", text: "legacy message" }],
      createdAt: "2026-10-27T10:01:00.000Z",
      customMessageField: "keep",
    }],
  };
  const originalContents = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`);
  await writeFile(storePath, originalContents);

  const readOnlyRepository = new JsonFileSessionRepository(dataDir);
  const legacyHistory = await getHistory(readOnlyRepository, "legacy-session");
  await readOnlyRepository.close();
  assert.equal(legacyHistory.messages[0]?.content[0].text, "legacy message");
  assert.deepEqual(await readFile(storePath), originalContents);

  const writingRepository = new JsonFileSessionRepository(dataDir);
  const assistantMessage = await writingRepository.appendAssistantMessage("legacy-session", {
    id: "legacy-assistant",
    createdAt: "2026-10-27T10:02:00.000Z",
    text: "new reply",
  });
  await writingRepository.close();

  assert.equal(assistantMessage?.sequence, 2);
  assert.deepEqual(await readFile(backupPath), originalContents);
  const migrated = JSON.parse(await readFile(storePath, "utf8")) as {
    formatVersion: number;
    migrationNote: { keep: boolean };
    sessions: Array<Record<string, unknown>>;
    messages: Array<Record<string, unknown>>;
  };
  assert.equal(migrated.formatVersion, 3);
  assert.deepEqual(migrated.migrationNote, { keep: true });
  assert.equal(migrated.sessions[0]?.customSessionField, "keep");
  assert.equal(migrated.messages[0]?.customMessageField, "keep");
  assert.equal(migrated.messages[1]?.role, "assistant");
  assert.equal(migrated.messages[1]?.sequence, 2);
});

test("v2 history migrates to v3 on first write and preserves the original backup", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-storage-v2-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const storePath = join(dataDir, "store.json");
  const backupPath = join(dataDir, "store.json.v2.bak");
  const v2Store = {
    formatVersion: 2,
    note: "preserve unknown fields",
    sessions: [{ id: "v2-session", createdAt: "2026-10-27T10:00:00.000Z" }],
    messages: [
      {
        id: "v2-user",
        sessionId: "v2-session",
        sequence: 1,
        role: "user",
        content: [{ type: "text", text: "legacy user" }],
        createdAt: "2026-10-27T10:01:00.000Z",
      },
      {
        id: "v2-assistant",
        sessionId: "v2-session",
        sequence: 2,
        role: "assistant",
        content: [{ type: "text", text: "legacy assistant" }],
        createdAt: "2026-10-27T10:02:00.000Z",
      },
    ],
  };
  const originalContents = Buffer.from(JSON.stringify(v2Store, null, 2) + "\n");
  await writeFile(storePath, originalContents);

  const readOnlyRepository = new JsonFileSessionRepository(dataDir);
  const history = await getHistory(readOnlyRepository, "v2-session");
  await readOnlyRepository.close();
  assert.equal(history.messages[1]?.content[0]?.text, "legacy assistant");
  assert.deepEqual(await readFile(storePath), originalContents);

  const writingRepository = new JsonFileSessionRepository(dataDir);
  await writingRepository.appendAssistantMessage("v2-session", {
    id: "v3-assistant",
    createdAt: "2026-10-27T10:03:00.000Z",
    text: "new answer",
    reasoning: [{ callIndex: 1, text: "new reasoning" }],
  });
  await writingRepository.close();

  assert.deepEqual(await readFile(backupPath), originalContents);
  const migrated = JSON.parse(await readFile(storePath, "utf8")) as {
    formatVersion: number;
    note: string;
    messages: Array<Record<string, unknown>>;
  };
  assert.equal(migrated.formatVersion, 3);
  assert.equal(migrated.note, "preserve unknown fields");
  assert.deepEqual(migrated.messages[1]?.content, [{ type: "text", text: "legacy assistant" }]);
  assert.deepEqual(migrated.messages[2]?.reasoning, [{ callIndex: 1, text: "new reasoning" }]);
});

test("unknown and malformed stores fail without changing the original file", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-storage-invalid-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const storePath = join(dataDir, "store.json");
  const invalidContents = [
    Buffer.from('{"formatVersion":99,"sessions":[],"messages":[]}\n'),
    Buffer.from('{"formatVersion":3,"sessions":[{"id":"session","createdAt":"2026-11-02T10:00:00.000Z"}],"messages":[{"id":"assistant","sessionId":"session","sequence":1,"role":"assistant","content":[{"type":"text","text":"answer"}],"createdAt":"2026-11-02T10:01:00.000Z","reasoning":[{"callIndex":1,"text":"first"},{"callIndex":1,"text":"duplicate call"}]}]}\n'),
    Buffer.from("not valid json\n"),
    Buffer.from([0x7b, 0xff, 0x7d]),
  ];

  for (const contents of invalidContents) {
    await writeFile(storePath, contents);
    const repository = new JsonFileSessionRepository(dataDir);
    await assert.rejects(getHistory(repository, "any-session"), StorageError);
    await repository.close();
    assert.deepEqual(await readFile(storePath), contents);
  }
});

test("v1 migration refuses a different existing backup without changing either file", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-storage-backup-conflict-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const storePath = join(dataDir, "store.json");
  const backupPath = join(dataDir, "store.json.v1.bak");
  const legacyContents = Buffer.from(JSON.stringify({
    formatVersion: 1,
    sessions: [{ id: "legacy-session", createdAt: "2026-10-27T10:00:00.000Z" }],
    messages: [],
  }));
  const conflictingBackup = Buffer.from("preserve this unrelated backup\n");
  await writeFile(storePath, legacyContents);
  await writeFile(backupPath, conflictingBackup);

  const repository = new JsonFileSessionRepository(dataDir);
  await assert.rejects(
    repository.appendAssistantMessage("legacy-session", {
      id: "assistant-message",
      createdAt: "2026-10-27T10:01:00.000Z",
      text: "reply",
    }),
    /backup differs/,
  );
  await repository.close();

  assert.deepEqual(await readFile(storePath), legacyContents);
  assert.deepEqual(await readFile(backupPath), conflictingBackup);
});
