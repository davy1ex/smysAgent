import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, getHistory, sendMessage } from "../../packages/application/src";
import { JsonFileSessionRepository } from "../../packages/storage/src";

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
