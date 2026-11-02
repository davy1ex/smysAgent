import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverConfiguredProviderModels,
  executeTurn,
  getProviderCatalog,
  resolveModelForRun,
  saveModelConfiguration,
  saveProviderConfiguration,
  setDefaultModelConfiguration,
  setSessionModelConfiguration,
  testConfiguredProviderConnection,
  type CredentialStore,
  type OpenAICompatibleProviderFactory,
} from "../../packages/application";
import { SqliteApplicationRepository } from "../../packages/storage";

test("provider configuration masks credentials, discovers unknown capabilities, and resolves model precedence per run", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "smys-provider-config-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const repository = new SqliteApplicationRepository(dataDir);
  const secret = `ephemeral-${randomUUID()}`;
  const credentials = new Map<string, string>();
  const credentialStore: CredentialStore = {
    async save(reference, value) { credentials.set(reference, value); },
    async get(reference) { return credentials.get(reference) ?? null; },
    async delete(reference) { credentials.delete(reference); },
  };
  const factoryInputs: Array<{ baseUrl: string; modelId: string; apiToken?: string }> = [];
  const factory: OpenAICompatibleProviderFactory = {
    create(input) {
      factoryInputs.push(input);
      return { async generate() { return { kind: "final", text: `used ${input.modelId}` }; } };
    },
    async testConnection(input) {
      assert.equal(input.apiToken, secret);
      return "connected";
    },
    async discoverModels(input) {
      assert.equal(input.apiToken, secret);
      return ["model-a", "model-b"];
    },
  };

  try {
    const provider = await saveProviderConfiguration(repository, credentialStore, {
      name: "Local OpenAI API",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: secret,
    });
    assert.equal(provider.hasCredential, true);
    assert.equal("credentialRef" in provider, false);
    assert.equal(JSON.stringify(provider).includes(secret), false);
    assert.equal(await testConfiguredProviderConnection(repository, credentialStore, factory, provider.id), "connected");

    const discovered = await discoverConfiguredProviderModels(repository, credentialStore, factory, provider.id);
    assert.deepEqual(discovered.map((model) => model.modelId), ["model-a", "model-b"]);
    assert.deepEqual(discovered[0]?.capabilities, { streaming: "unknown", toolCalling: "unknown", reasoning: "unknown" });
    const manual = await saveModelConfiguration(repository, { providerId: provider.id, modelId: "manual-id" });
    assert.deepEqual(manual.capabilities, { streaming: "unknown", toolCalling: "unknown", reasoning: "unknown" });

    const sessionId = `session-${randomUUID()}`;
    await repository.createSession({ id: sessionId, createdAt: new Date().toISOString() });
    const globalModel = discovered[0]!;
    const sessionModel = discovered[1]!;
    await setDefaultModelConfiguration(repository, globalModel.id);
    const globalResolved = await resolveModelForRun(repository, credentialStore, factory, { sessionId });
    assert.equal(globalResolved?.snapshot.modelConfigId, globalModel.id);

    await setSessionModelConfiguration(repository, sessionId, sessionModel.id);
    const sessionResolved = await resolveModelForRun(repository, credentialStore, factory, { sessionId });
    assert.equal(sessionResolved?.snapshot.modelConfigId, sessionModel.id);
    const explicitResolved = await resolveModelForRun(repository, credentialStore, factory, {
      sessionId,
      requestedModelConfigId: globalModel.id,
    });
    assert.equal(explicitResolved?.snapshot.modelConfigId, globalModel.id);
    assert.equal(await repository.getSessionModelConfigId(sessionId), sessionModel.id);

    await repository.saveModelConfiguration({ ...globalModel, displayName: "renamed after run selection" });
    const turn = await executeTurn(repository, explicitResolved!.provider, {
      sessionId,
      text: "verify run snapshot",
      modelSelection: explicitResolved!.snapshot,
    });
    assert.equal(turn.assistantMessage.content[0]?.text, "used model-a");
    const runs = await repository.listCompletedRuns(sessionId);
    assert.equal(runs[0]?.modelSelection?.modelName, "model-a");
    assert.equal(runs[0]?.modelSelection?.modelId, "model-a");
    assert.equal(factoryInputs.at(-1)?.apiToken, secret);

    const catalog = await getProviderCatalog(repository);
    assert.equal(JSON.stringify(catalog).includes(secret), false);
    assert.equal(JSON.stringify(catalog).includes("credentialRef"), false);
    assert.equal(catalog.defaultModelConfigId, globalModel.id);
  } finally {
    await repository.close();
  }
  const databaseBytes = await readFile(join(dataDir, "store.sqlite"));
  assert.equal(databaseBytes.includes(Buffer.from(secret)), false);
});
