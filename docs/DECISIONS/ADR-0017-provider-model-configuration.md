# ADR-0017: Пользовательская конфигурация OpenAI-compatible провайдеров и моделей

- Статус: Accepted
- Реализация: Implemented (2026-11-02; ручная проверка с реальной LM Studio отмечается отдельно в `NOW.md`)
- Дата: 2026-11-02
- Утвердил: владелец проекта в чате; приложенное подтверждение с уточнениями
- Уточняет schema version из ADR-0016: completed-run persistence сохраняется, SQLite schema повышается с v1 на v2.

## Контекст

Выбор провайдера и модели в основном задавался переменными окружения и при старте host. Web должен управлять локальной конфигурацией провайдеров и моделей, применять новый выбор к следующему ходу без перезапуска, а CLI и Web должны читать один источник конфигурации. Выполнение модели уже проходит через единый Core/Application путь по ADR-0012; новый каталог не должен создавать отдельный agent loop или повторять OpenAI-compatible inference adapter для каждого сервера.

## Варианты

1. Сохранять всё в env и перезапускать host — не выбрано: не даёт пользовательского UI и смены модели в процессе.
2. Сохранять конфигурацию и API keys открытым текстом в SQLite — не выбрано: БД и её копии раскрывали бы credentials.
3. Сохранить provider/model records в общем SQLite store, credentials вынести в системный vault, а provider выбирать перед каждым новым ходом через общий Application resolver — выбрано.

## Решение

### Конфигурация и выбор

- `ProviderConfig` хранит `id`, имя, protocol `openai-chat-completions`, Base URL, необязательный credential reference, явное разрешение удалённого HTTP и timestamps. Пароль/API key не входит в record.
- `ModelConfig` отдельно хранит provider ID, точный Model ID, отображаемое имя, источник `manual | discovered` и состояния capabilities `unknown | supported | unsupported` для streaming, tool calling и reasoning.
- Выбор для запуска не смешивается с ProviderConfig или ModelConfig. Приоритет: явный `modelConfigId` конкретного запуска → сохранённый выбор сессии → глобальная модель по умолчанию. Выбор из чата сохраняется как выбор сессии; CLI `--model-config-id` является override одного запуска.
- Application разрешает provider/model перед началом каждого нового AgentRun и создаёт adapter с фиксированными Base URL, credential и Model ID. Изменение конфигурации не меняет уже созданный provider активного Run. Успешный completed `AgentRun` получает snapshot provider ID/name и model config ID/Model ID/name; значения остаются историей, даже если конфигурация позже переименована или удалена.
- Как и в ADR-0016, неуспешные, отменённые и активные runs не сохраняются. Отмена и уже существующие streaming, reasoning и tool события остаются в Unified Agent Execution.

### Storage и credentials

- SQLite schema становится `user_version=2`. `provider_configs` и `model_configs` — новые таблицы; session получает `selected_model_config_id`; `app_metadata` хранит глобальный default; `agent_runs` хранит snapshot выбранной модели. Миграция существующей schema v1 выполняется транзакционно и сохраняет прежние messages/runs. Однократный JSON v1/v2/v3 import продолжает создавать актуальную схему сразу.
- Web Host и CLI используют тот же `<SMYS_DATA_DIR>/store.sqlite` и Application resolver. Открытые application ports для provider/model configuration реализуются тем же SQLite adapter.
- Credential port предоставляет `save/get/delete` по непрозрачной случайной ссылке. Реализация для текущего хоста хранит API key в macOS Keychain через `@napi-rs/keyring@2.1.2`. SQLite содержит только reference. Credentials не возвращаются Web API и не отображаются в UI после сохранения. Нет plaintext fallback; сейчас запись credentials поддерживается на macOS, на неподдерживаемой платформе операция с ключом завершается понятной ошибкой. Провайдеры без авторизации могут работать без ключа.
- Секрет передаётся от Web UI только при сохранении формы и далее остаётся на host. Изменения конфигурации не принимаются от внешних сетевых HTTP-клиентов: host слушает loopback, проверяет loopback Host и, если задан, exact same-host loopback Origin; CORS не включается.

### Adapter, discovery и сеть

- Один общий OpenAI-compatible Chat Completions adapter обслуживает совместимые endpoints, сохраняя текущий LM Studio adapter как совместимый wrapper с прежними сообщениями ошибок.
- Base URL — абсолютный HTTP(S) URL без userinfo, query или fragment. Для удалённого HTTP требуется явное подтверждение риска в UI; HTTPS и loopback HTTP разрешены без него. Discovery и inference запрещают автоматические redirects, чтобы не переслать Bearer key на другой origin.
- Проверка provider и discovery используют только сохранённый provider ID. `GET /models` ограничен 10 секундами, 1 MiB и 500 model IDs. Ответ discovery создаёт ModelConfig со всеми capabilities в `unknown`. Если `/models` не поддерживается или Model ID неизвестен, пользователь может добавить точный ID вручную.
- Наличие ID в `/models` не доказывает поддержку streaming, tools или reasoning. Автоматические выводы о capabilities и автоматические capability probes не включены.

### Совместимость и границы

- Сохранённые пользовательские настройки имеют приоритет над legacy provider, выбранным через `SMYS_PROVIDER`; если ни явного выбора, ни session/global config нет, CLI/Web продолжают использовать прежние env-настройки. `SMYS_DATA_DIR`, `SMYS_WEB_PORT`, `LM_STUDIO_MODEL`, `LM_STUDIO_ENDPOINT` и `LM_API_TOKEN` остаются доступны для fallback и старых сценариев.
- Не добавляются plugin system, автоматическая загрузка моделей, GPU management, fallback routing, балансировщик, активный Run recovery или event replay.

## Последствия и rollback

- Пользователь может добавить endpoint, проверить `/models`, выбрать discovered/manual модель в чате и продолжить без перезапуска host. CLI может выбрать ту же глобальную или session-модель или передать одноразовый `--model-config-id`.
- `@napi-rs/keyring` добавляет нативный runtime dependency. Vault access failure закрывает операцию; автоматического хранения ключа в SQLite нет. На системах без поддержанного vault настройки без ключа остаются пригодными.
- Переход schema v1 → v2 односторонний для старого бинарника. Перед откатом на версию без v2 нужно восстановить согласованный backup SQLite, сделанный до миграции; новый код не выполняет downgrade и не пишет параллельный JSON store.
- Удаление provider удаляет связанные модели и credential entry; selection ссылок очищается, а завершённые run snapshots остаются в истории.

## Проверяемое поведение

- Application tests проверяют маскирование API key, неизвестные capabilities и приоритет выбора; snapshot completed run не меняется после последующего редактирования конфигурации.
- SQLite tests проверяют сохранение конфигурации после reopen и транзакционную миграцию v1 → v2 без потери сообщений.
- Web API tests проверяют добавление provider, test/discovery по provider ID, отсутствие secret в ответах, same-origin запрет и фактическую смену модели между двумя ходами одной сессии.
- CLI process tests читают тот же SQLite config, выполняют явный и global-default model run и сохраняют фактический snapshot.
- Ручная проверка реального LM Studio — отдельное evidence в `NOW.md`; автоматизированный suite использует локальные HTTP stubs.

## Evidence реализации

- Application/provider ports: [`provider-configuration.ts`](../../src/packages/application/provider-configuration.ts), [`ports.ts`](../../src/packages/application/ports.ts).
- Shared adapter and vault: [`lm-studio-provider.ts`](../../src/packages/providers/lm-studio-provider.ts), [`macos-credential-store.ts`](../../src/packages/providers/macos-credential-store.ts).
- SQLite/API/UI: [`sqlite-application-repository.ts`](../../src/packages/storage/sqlite-application-repository.ts), [`server.ts`](../../src/apps/web-host/server.ts), [`ProviderSettings.tsx`](../../src/apps/web/src/ProviderSettings.tsx), [`App.tsx`](../../src/apps/web/src/App.tsx).
