# Spec 003: Provider & Model Configuration

- Статус: Accepted; поведение реализовано по [ADR-0017](../DECISIONS/ADR-0017-provider-model-configuration.md).
- Дата утверждения: 2026-11-02.

## Наблюдаемое поведение

1. В Web UI можно создать OpenAI-compatible provider с названием, Base URL и необязательным API key.
2. Web UI проверяет сохранённый provider по ID, показывает connection/auth/discovery ошибку и может читать `/models`.
3. Пользователь может сохранить точный Model ID вручную, если discovery недоступен или не включает его.
4. Capabilities streaming, tool calling и reasoning явно показываются как `unknown`, пока они не подтверждены; unknown не запрещает запуск.
5. Пользователь может задать global default и изменить модель текущей сессии в composer. Следующий новый ход использует актуальную модель без перезапуска host.
6. CLI и Web разрешают модели из одного SQLite store через общий Application API. CLI принимает `--model-config-id`; старые provider/env аргументы сохраняют совместимость.
7. Completed AgentRun сохраняет snapshot фактических provider/model IDs и отображаемых имён. Редактирование каталога или выбор для последующих ходов не меняет уже выполняющийся Run и его snapshot.
8. После перезапуска Web UI видит сохранённые providers, models, global default, session selection и traces завершённых ходов.

## Схема и безопасность

- Разделить ProviderConfig, ModelConfig и выбор на один AgentRun.
- SQLite schema v1 мигрирует транзакционно на v2; старые session/message/run records сохраняются.
- API key текущей macOS реализации хранится в Keychain под случайным credential reference. SQLite хранит только reference, Web response — только boolean наличия. На неподдерживаемой платформе сохранение credentials завершается ошибкой; plaintext fallback нет.
- Provider configuration API доступен только loopback UI: проверяются Host и same-host Origin, CORS не включается.
- Base URL валидируется. Remote HTTP требует явного согласия. Requests с Bearer key не следуют redirects.
- Discovery ограничен по времени, размеру тела и числу моделей.

## За пределами среза

Capability probing, plugin system, загрузка модели, GPU management, fallback routing, балансировщик, active-run recovery и event replay.

## Критерии проверки

- Unit/integration tests: config persistence/reopen, миграция v1→v2, отсутствие API key в SQLite/API, явный→session→global precedence и стабильный run snapshot.
- Provider tests: bearer header, discovery/manual fallback, unsupported auth/connectivity, timeout/size limit и no redirect.
- Web/CLI tests: оба клиента используют один SQLite catalog; разные модели двух последовательных ходов одной сессии видны в run history.
- Ручной browser сценарий с реальным LM Studio: добавить endpoint, проверить, обнаружить/ввести ID, отправить ход, сменить модель, отправить следующий ход и перезагрузить страницу. Статус ручной проверки записывается в `NOW.md`.
