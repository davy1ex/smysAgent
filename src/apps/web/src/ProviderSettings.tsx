import { useEffect, useMemo, useState } from "react";
import {
  addManualModel,
  deleteModel,
  deleteProvider,
  discoverProviderModels,
  saveProvider,
  setDefaultModel,
  testProvider,
  WebApiError,
  type ModelConfiguration,
  type ProviderCatalog,
  type ProviderConfiguration,
} from "./api";

export function ProviderSettings({
  catalog,
  onClose,
  onRefresh,
}: {
  catalog: ProviderCatalog;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [editingProviderId, setEditingProviderId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:1234/v1");
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [manualProviderId, setManualProviderId] = useState(catalog.providers[0]?.id ?? "");
  const [manualModelId, setManualModelId] = useState("");
  const [manualModelName, setManualModelName] = useState("");
  const [statusByProvider, setStatusByProvider] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!catalog.providers.some((provider) => provider.id === manualProviderId)) {
      setManualProviderId(catalog.providers[0]?.id ?? "");
    }
  }, [catalog.providers, manualProviderId]);

  const modelsByProvider = useMemo(() => {
    const result = new Map<string, ModelConfiguration[]>();
    for (const model of catalog.models) result.set(model.providerId, [...(result.get(model.providerId) ?? []), model]);
    return result;
  }, [catalog.models]);
  const remoteHttp = isRemoteHttp(baseUrl);
  const editingProvider = catalog.providers.find((provider) => provider.id === editingProviderId);

  const resetForm = () => {
    setEditingProviderId("");
    setName("");
    setBaseUrl("http://localhost:1234/v1");
    setApiKey("");
    setClearApiKey(false);
    setAllowInsecureHttp(false);
  };

  const editProvider = (provider: ProviderConfiguration) => {
    setEditingProviderId(provider.id);
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setApiKey("");
    setClearApiKey(false);
    setAllowInsecureHttp(provider.allowInsecureHttp);
    setError("");
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await saveProvider({
        ...(editingProviderId ? { id: editingProviderId } : {}),
        name,
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(clearApiKey ? { clearApiKey: true } : {}),
        ...(remoteHttp ? { allowInsecureHttp } : {}),
      });
      resetForm();
      await onRefresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const runProviderAction = async (providerId: string, action: "test" | "discover") => {
    setBusy(true);
    setError("");
    setStatusByProvider((current) => ({ ...current, [providerId]: action === "test" ? "Проверяем соединение…" : "Получаем модели…" }));
    try {
      if (action === "test") {
        const status = await testProvider(providerId);
        setStatusByProvider((current) => ({
          ...current,
          [providerId]: status === "connected"
            ? "Соединение работает; /models доступен."
            : "Сервер ответил, но /models недоступен. Проверьте Base URL или введите Model ID вручную.",
        }));
      } else {
        const models = await discoverProviderModels(providerId);
        setStatusByProvider((current) => ({ ...current, [providerId]: `Сохранено моделей: ${models.length}. Capabilities остаются unknown.` }));
        await onRefresh();
      }
    } catch (cause) {
      const message = messageOf(cause);
      setStatusByProvider((current) => ({ ...current, [providerId]: message }));
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const addManual = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!manualProviderId) return;
    setBusy(true);
    setError("");
    try {
      await addManualModel({ providerId: manualProviderId, modelId: manualModelId, ...(manualModelName ? { displayName: manualModelName } : {}) });
      setManualModelId("");
      setManualModelName("");
      await onRefresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const removeProvider = async (provider: ProviderConfiguration) => {
    if (!window.confirm(`Удалить провайдера «${provider.name}» и его модели?`)) return;
    setBusy(true);
    setError("");
    try {
      await deleteProvider(provider.id);
      await onRefresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const removeModel = async (model: ModelConfiguration) => {
    if (!window.confirm(`Удалить модель «${model.displayName}»?`)) return;
    setBusy(true);
    setError("");
    try {
      await deleteModel(model.id);
      await onRefresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const updateDefault = async (value: string) => {
    setBusy(true);
    setError("");
    try {
      await setDefaultModel(value || null);
      await onRefresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="provider-settings" role="dialog" aria-modal="true" aria-labelledby="provider-settings-title">
        <header className="provider-settings-header">
          <div><span className="settings-eyebrow">SMYS · НАСТРОЙКИ</span><h2 id="provider-settings-title">Провайдеры и модели</h2></div>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Закрыть настройки">×</button>
        </header>

        <div className="provider-settings-content">
          <section className="settings-section">
            <h3>{editingProvider ? "Изменить провайдера" : "Добавить провайдера"}</h3>
            <p className="settings-copy">OpenAI-compatible Chat Completions. Base URL указывается до `/models` и `/chat/completions`.</p>
            <form className="provider-form" onSubmit={(event) => { void save(event); }}>
              <label>Название<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} placeholder="LM Studio" /></label>
              <label>Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required placeholder="http://localhost:1234/v1" /></label>
              {catalog.credentialVaultAvailable
                ? <label>API-ключ (необязательно)<input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={editingProvider?.hasCredential ? "Сохранён; пустое поле оставит его" : "Bearer token"} /></label>
                : <p className="settings-note">Системное хранилище ключей доступно только на macOS. На этой платформе сохранение API-ключей отключено.</p>}
              {editingProvider?.hasCredential && catalog.credentialVaultAvailable && (
                <label className="settings-check"><input type="checkbox" checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)} />Удалить сохранённый API-ключ</label>
              )}
              {remoteHttp && <label className="settings-warning"><input type="checkbox" checked={allowInsecureHttp} onChange={(event) => setAllowInsecureHttp(event.target.checked)} />Подтверждаю передачу ключа и данных модели по HTTP без TLS.</label>}
              <div className="settings-form-actions">
                {editingProvider && <button type="button" className="settings-secondary" disabled={busy} onClick={resetForm}>Отмена</button>}
                <button className="settings-primary" disabled={busy || (remoteHttp && !allowInsecureHttp)}>{busy ? "Сохраняем…" : editingProvider ? "Сохранить" : "Добавить"}</button>
              </div>
            </form>
          </section>

          <section className="settings-section">
            <div className="settings-section-heading"><h3>Глобальная модель по умолчанию</h3><span>для новых чатов</span></div>
            <select aria-label="Глобальная модель по умолчанию" value={catalog.defaultModelConfigId ?? ""} disabled={busy} onChange={(event) => { void updateDefault(event.target.value); }}>
              <option value="">Не выбрана</option>
              {catalog.models.map((model) => <option key={model.id} value={model.id}>{providerName(catalog, model.providerId)} · {model.displayName}</option>)}
            </select>
          </section>

          <section className="settings-section">
            <h3>Провайдеры</h3>
            {catalog.providers.length === 0
              ? <p className="settings-empty">Провайдеры ещё не добавлены.</p>
              : <div className="provider-list">{catalog.providers.map((provider) => (
                <article className="provider-card" key={provider.id}>
                  <div className="provider-card-heading"><div><strong>{provider.name}</strong><span>{provider.baseUrl}</span></div><span className="provider-auth-state">{provider.hasCredential ? "Ключ сохранён" : "Без ключа"}</span></div>
                  {isRemoteHttp(provider.baseUrl) && <p className="settings-warning-copy">HTTP без TLS: ключ и данные модели передаются без шифрования.</p>}
                  <div className="provider-card-actions">
                    <button type="button" disabled={busy} onClick={() => { void runProviderAction(provider.id, "test"); }}>Проверить</button>
                    <button type="button" disabled={busy} onClick={() => { void runProviderAction(provider.id, "discover"); }}>Найти модели</button>
                    <button type="button" disabled={busy} onClick={() => editProvider(provider)}>Изменить</button>
                    <button type="button" className="settings-danger" disabled={busy} onClick={() => { void removeProvider(provider); }}>Удалить</button>
                  </div>
                  {statusByProvider[provider.id] && <p className="provider-status" role="status">{statusByProvider[provider.id]}</p>}
                  <ul className="provider-model-list">{(modelsByProvider.get(provider.id) ?? []).map((model) => (
                    <li key={model.id}>
                      <span><strong>{model.displayName}</strong><small>{model.modelId} · stream {model.capabilities.streaming} · tools {model.capabilities.toolCalling} · reasoning {model.capabilities.reasoning}</small></span>
                      <button type="button" disabled={busy} aria-label={`Удалить модель ${model.displayName}`} onClick={() => { void removeModel(model); }}>×</button>
                    </li>
                  ))}</ul>
                </article>
              ))}</div>}
          </section>

          {catalog.providers.length > 0 && <section className="settings-section">
            <h3>Добавить Model ID вручную</h3>
            <form className="manual-model-form" onSubmit={(event) => { void addManual(event); }}>
              <select aria-label="Провайдер модели" value={manualProviderId} onChange={(event) => setManualProviderId(event.target.value)}>
                {catalog.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
              </select>
              <input aria-label="Model ID" placeholder="Model ID" value={manualModelId} onChange={(event) => setManualModelId(event.target.value)} required maxLength={300} />
              <input aria-label="Название модели" placeholder="Отображаемое имя (необязательно)" value={manualModelName} onChange={(event) => setManualModelName(event.target.value)} />
              <button className="settings-secondary" disabled={busy}>Добавить модель</button>
            </form>
          </section>}

          <p className="settings-note">Capability `unknown` означает, что функция не проверена; это не блокирует выбор. Проверка `/models` подтверждает только доступность endpoint.</p>
          {error && <p className="settings-error" role="alert">{error}</p>}
        </div>
      </section>
    </div>
  );
}

function providerName(catalog: ProviderCatalog, providerId: string): string {
  return catalog.providers.find((provider) => provider.id === providerId)?.name ?? "Удалённый провайдер";
}

function isRemoteHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  if (!(error instanceof WebApiError)) return error instanceof Error ? error.message : "Не удалось выполнить запрос.";
  switch (error.code) {
    case "PROVIDER_AUTH_ERROR": return "Провайдер отклонил авторизацию. Проверьте API-ключ.";
    case "PROVIDER_TIMEOUT": return "Провайдер не ответил за 10 секунд. Проверьте доступность сервера.";
    case "PROVIDER_CONNECTION_ERROR": return "Не удалось подключиться к провайдеру. Проверьте Base URL и запущен ли сервер.";
    case "CREDENTIAL_VAULT_UNAVAILABLE": return "Не удалось сохранить API-ключ в системном хранилище. Значение не сохранено.";
    case "PROVIDER_ERROR": return localizeProviderError(error.message);
    default: return localizeProviderError(error.message);
  }
}

function localizeProviderError(message: string): string {
  if (/does not support model discovery/i.test(message)) return "Endpoint /models не поддерживается. Введите Model ID вручную.";
  if (/models response exceeded the size limit/i.test(message)) return "Ответ /models превышает лимит размера 1 MiB.";
  if (/invalid models response/i.test(message)) return "Endpoint /models вернул неизвестный формат. Введите Model ID вручную.";
  if (/authorization/i.test(message)) return "Провайдер отклонил авторизацию. Проверьте API-ключ.";
  if (/could not connect/i.test(message)) return "Не удалось подключиться к провайдеру. Проверьте Base URL и запущен ли сервер.";
  if (/timed out/i.test(message)) return "Провайдер не ответил за 10 секунд. Проверьте доступность сервера.";
  if (/^provider returned HTTP (\d+)/i.test(message)) return `Провайдер вернул ошибку HTTP ${message.match(/\d+/)?.[0] ?? ""}. Проверьте URL и настройки endpoint.`;
  return message;
}
