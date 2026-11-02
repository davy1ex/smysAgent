import { randomUUID } from "node:crypto";
import { InvalidArgumentError, SessionNotFoundError } from "./errors";
import type {
  ApplicationRepository,
  CredentialStore,
  ModelConfiguration,
  ModelSelectionSnapshot,
  OpenAICompatibleProviderFactory,
  ProviderConfiguration,
  ProviderConfigurationRepository,
} from "./ports";
import type { TextGenerationProvider } from "../core/agent";

export interface ProviderConfigurationView extends Omit<ProviderConfiguration, "credentialRef"> {
  hasCredential: boolean;
}

export interface ProviderCatalog {
  providers: ProviderConfigurationView[];
  models: ModelConfiguration[];
  defaultModelConfigId: string | null;
}

export async function getProviderCatalog(repository: ProviderConfigurationRepository): Promise<ProviderCatalog> {
  const [providers, models, defaultModelConfigId] = await Promise.all([
    repository.listProviderConfigurations(),
    repository.listModelConfigurations(),
    repository.getDefaultModelConfigId(),
  ]);
  return {
    providers: providers.map(({ credentialRef, ...provider }) => ({ ...provider, hasCredential: credentialRef !== undefined })),
    models,
    defaultModelConfigId,
  };
}

export async function saveProviderConfiguration(
  repository: ProviderConfigurationRepository,
  credentialStore: CredentialStore,
  input: { id?: string; name: string; baseUrl: string; apiKey?: string; clearApiKey?: boolean; allowInsecureHttp?: boolean },
): Promise<ProviderConfigurationView> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 100) throw new InvalidArgumentError("Provider name must contain 1 to 100 characters.");
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const existing = input.id === undefined ? null : await repository.getProviderConfiguration(input.id);
  if (input.id !== undefined && existing === null) throw new InvalidArgumentError("Provider configuration was not found.");
  const allowInsecureHttp = input.allowInsecureHttp ?? existing?.allowInsecureHttp ?? false;
  if (isRemoteHttp(baseUrl) && !allowInsecureHttp) {
    throw new InvalidArgumentError("Confirm that this HTTP endpoint may receive credentials and model data.");
  }

  let credentialRef = existing?.credentialRef;
  const suppliedApiKey = input.apiKey?.trim();
  if (suppliedApiKey !== undefined && suppliedApiKey.length > 0) {
    const replacementRef = randomUUID();
    await credentialStore.save(replacementRef, suppliedApiKey);
    credentialRef = replacementRef;
  } else if (input.clearApiKey === true) {
    credentialRef = undefined;
  }

  const now = new Date().toISOString();
  const configuration: ProviderConfiguration = {
    id: existing?.id ?? randomUUID(),
    name,
    protocol: "openai-chat-completions",
    baseUrl,
    allowInsecureHttp,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(credentialRef === undefined ? {} : { credentialRef }),
  };
  try {
    await repository.saveProviderConfiguration(configuration);
  } catch (error) {
    if (suppliedApiKey !== undefined && suppliedApiKey.length > 0 && credentialRef !== undefined) {
      await credentialStore.delete(credentialRef).catch(() => undefined);
    }
    throw error;
  }
  if (existing?.credentialRef !== undefined && existing.credentialRef !== credentialRef) {
    await credentialStore.delete(existing.credentialRef);
  }

  return {
    id: configuration.id,
    name: configuration.name,
    protocol: configuration.protocol,
    baseUrl: configuration.baseUrl,
    allowInsecureHttp: configuration.allowInsecureHttp,
    createdAt: configuration.createdAt,
    updatedAt: configuration.updatedAt,
    hasCredential: credentialRef !== undefined,
  };
}

export async function deleteProviderConfiguration(
  repository: ProviderConfigurationRepository,
  credentialStore: CredentialStore,
  providerId: string,
): Promise<boolean> {
  const existing = await repository.getProviderConfiguration(providerId);
  if (existing === null) return false;
  const deleted = await repository.deleteProviderConfiguration(providerId);
  if (deleted && existing.credentialRef !== undefined) await credentialStore.delete(existing.credentialRef);
  return deleted;
}

export async function testConfiguredProviderConnection(
  repository: ProviderConfigurationRepository,
  credentialStore: CredentialStore,
  providerFactory: OpenAICompatibleProviderFactory,
  providerId: string,
): Promise<"connected" | "discovery-unavailable"> {
  const { configuration, apiToken } = await loadProviderCredentials(repository, credentialStore, providerId);
  return providerFactory.testConnection({ baseUrl: configuration.baseUrl, ...(apiToken === undefined ? {} : { apiToken }) });
}

export async function discoverConfiguredProviderModels(
  repository: ProviderConfigurationRepository,
  credentialStore: CredentialStore,
  providerFactory: OpenAICompatibleProviderFactory,
  providerId: string,
): Promise<ModelConfiguration[]> {
  const { configuration, apiToken } = await loadProviderCredentials(repository, credentialStore, providerId);
  const discoveredIds = await providerFactory.discoverModels({
    baseUrl: configuration.baseUrl,
    ...(apiToken === undefined ? {} : { apiToken }),
  });
  const existingModels = await repository.listModelConfigurations();
  const discovered: ModelConfiguration[] = [];
  for (const modelId of discoveredIds) {
    const existing = existingModels.find((model) => model.providerId === providerId && model.modelId === modelId);
    if (existing !== undefined) {
      discovered.push(existing);
      continue;
    }
    const now = new Date().toISOString();
    const model: ModelConfiguration = {
      id: randomUUID(),
      providerId,
      modelId,
      displayName: modelId,
      source: "discovered",
      capabilities: { streaming: "unknown", toolCalling: "unknown", reasoning: "unknown" },
      createdAt: now,
      updatedAt: now,
    };
    await repository.saveModelConfiguration(model);
    discovered.push(model);
  }
  return discovered;
}

export async function saveModelConfiguration(
  repository: ProviderConfigurationRepository,
  input: { providerId: string; modelId: string; displayName?: string; source?: "discovered" | "manual" },
): Promise<ModelConfiguration> {
  const provider = await repository.getProviderConfiguration(input.providerId);
  if (provider === null) throw new InvalidArgumentError("Provider configuration was not found.");
  const modelId = input.modelId.trim();
  if (modelId.length === 0 || modelId.length > 300) throw new InvalidArgumentError("Model ID must contain 1 to 300 characters.");
  const existing = (await repository.listModelConfigurations())
    .find((model) => model.providerId === input.providerId && model.modelId === modelId);
  if (existing !== undefined) return existing;
  const now = new Date().toISOString();
  const model: ModelConfiguration = {
    id: randomUUID(),
    providerId: input.providerId,
    modelId,
    displayName: input.displayName?.trim() || modelId,
    source: input.source ?? "manual",
    capabilities: { streaming: "unknown", toolCalling: "unknown", reasoning: "unknown" },
    createdAt: now,
    updatedAt: now,
  };
  await repository.saveModelConfiguration(model);
  return model;
}

export async function deleteModelConfiguration(
  repository: ProviderConfigurationRepository,
  modelConfigId: string,
): Promise<boolean> {
  return repository.deleteModelConfiguration(modelConfigId);
}

export async function setDefaultModelConfiguration(
  repository: ProviderConfigurationRepository,
  modelConfigId: string | null,
): Promise<void> {
  if (modelConfigId !== null && await repository.getModelConfiguration(modelConfigId) === null) {
    throw new InvalidArgumentError("Model configuration was not found.");
  }
  await repository.setDefaultModelConfigId(modelConfigId);
}

export async function setSessionModelConfiguration(
  repository: ProviderConfigurationRepository,
  sessionId: string,
  modelConfigId: string | null,
): Promise<void> {
  if (modelConfigId !== null && await repository.getModelConfiguration(modelConfigId) === null) {
    throw new InvalidArgumentError("Model configuration was not found.");
  }
  if (!await repository.setSessionModelConfigId(sessionId, modelConfigId)) throw new SessionNotFoundError(sessionId);
}

export interface ResolvedModelForRun {
  provider: TextGenerationProvider;
  snapshot: ModelSelectionSnapshot;
}

export async function resolveModelForRun(
  repository: ProviderConfigurationRepository & Pick<ApplicationRepository, "getHistory">,
  credentialStore: CredentialStore,
  providerFactory: OpenAICompatibleProviderFactory,
  input: { sessionId: string; requestedModelConfigId?: string },
): Promise<ResolvedModelForRun | null> {
  const history = await repository.getHistory(input.sessionId);
  if (history === null) throw new SessionNotFoundError(input.sessionId);
  const modelConfigId = input.requestedModelConfigId ?? await repository.getSessionModelConfigId(input.sessionId) ?? await repository.getDefaultModelConfigId();
  if (modelConfigId === null || modelConfigId === undefined) return null;
  const model = await repository.getModelConfiguration(modelConfigId);
  if (model === null) throw new InvalidArgumentError("The selected model configuration no longer exists.");
  const { configuration: providerConfig, apiToken } = await loadProviderCredentials(repository, credentialStore, model.providerId);
  const provider = providerFactory.create({
    baseUrl: providerConfig.baseUrl,
    modelId: model.modelId,
    ...(apiToken === undefined ? {} : { apiToken }),
  });
  return {
    provider,
    snapshot: {
      providerId: providerConfig.id,
      providerName: providerConfig.name,
      modelConfigId: model.id,
      modelId: model.modelId,
      modelName: model.displayName,
    },
  };
}

async function loadProviderCredentials(
  repository: ProviderConfigurationRepository,
  credentialStore: CredentialStore,
  providerId: string,
): Promise<{ configuration: ProviderConfiguration; apiToken?: string }> {
  const configuration = await repository.getProviderConfiguration(providerId);
  if (configuration === null) throw new InvalidArgumentError("Provider configuration was not found.");
  if (configuration.credentialRef === undefined) return { configuration };
  const apiToken = await credentialStore.get(configuration.credentialRef);
  if (apiToken === null) throw new Error("The saved provider credential is unavailable in the system credential vault.");
  return { configuration, apiToken };
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new InvalidArgumentError("Base URL must be an absolute HTTP or HTTPS URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0
  ) {
    throw new InvalidArgumentError("Base URL must use HTTP or HTTPS and must not contain credentials, query, or fragment.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

function isRemoteHttp(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}
