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

test("v1 history reads without rewriting and first write preserves a backup during v2 migration", async (t) => {
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
  assert.equal(migrated.formatVersion, 2);
  assert.deepEqual(migrated.migrationNote, { keep: true });
  assert.equal(migrated.sessions[0]?.customSessionField, "keep");
  assert.equal(migrated.messages[0]?.customMessageField, "keep");
  assert.equal(migrated.messages[1]?.role, "assistant");
  assert.equal(migrated.messages[1]?.sequence, 2);
});

test("unknown and malformed stores fail without changing the original file", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-agent-storage-invalid-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const storePath = join(dataDir, "store.json");
  const invalidContents = [
    Buffer.from('{"formatVersion":99,"sessions":[],"messages":[]}\n'),
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
