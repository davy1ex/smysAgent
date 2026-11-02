# Changelog

Заметные изменения проекта, сгруппированные по дате.

## 2026-11-02

### Added

- Completed AgentRun traces: ordered model calls, full per-call reasoning и tool calls с аргументами и результатами. Trace связан с сессией и user/assistant messages по стабильным ID.
- SQLite `store.sqlite` как активное хранилище Web Host и CLI. Application API возвращает завершённые traces вместе с историей, а Web восстанавливает trajectory после повторного открытия сессии.
- Однократный импорт JSON store v1/v2/v3 в новую SQLite БД с точной резервной копией исходного файла. Legacy reasoning сохраняется; traces для старых ходов не синтезируются.

### Changed

- Финальный assistant message и completed trace записываются одной транзакцией; reasoning хранится отдельно от текста ответа.
- ADR-0016 зафиксировал SQLite, контракт AgentRun, миграцию и политику локального хранения. ADR-0015 отмечен как заменённый.

### Scope

- Сохраняются только успешно завершённые runs. Reconnect активного inference, replay событий и scheduler не входят в эту версию.

Реализация зафиксирована коммитом `7def147`.

### Provider & Model Configuration (ADR-0017)

#### Added

- Web UI для добавления и редактирования OpenAI-compatible providers, проверки подключения, обнаружения моделей через `/models` и ручного ввода Model ID.
- Выбор модели в composer для сессии и настройка global default. Новый ход разрешает модель по приоритету per-run → session → global; CLI использует общий SQLite config и принимает одноразовый `--model-config-id`.
- Общий OpenAI-compatible Chat Completions adapter; существующий LM Studio provider сохранён как compatibility wrapper с reasoning, streaming, tools и cancellation.
- Provider/model catalog и session selection в SQLite schema v2 с транзакционной миграцией v1 → v2. Успешные AgentRun сохраняют snapshot фактически выбранного provider/model.
- API-key storage через macOS Keychain. SQLite хранит только credential reference, Web API возвращает только признак наличия ключа.

#### Changed

- Web и CLI читают общий конфигурационный источник. Новые настройки действуют со следующего хода без перезапуска host; legacy env-настройки остаются fallback.
- Provider management ограничен loopback Host/same-host Origin; CORS не включён. Проверка и discovery используют сохранённый provider ID. Discovery ограничен по времени, размеру ответа и числу моделей; capabilities обнаруженных моделей остаются `unknown`.
- `docs/DECISIONS/ADR-0017-provider-model-configuration.md` фиксирует схему, Application API/ports, credential vault, HTTP ограничения, совместимость и rollback.

#### Verification

- Прошли 85 root tests, 3 Web tests, typecheck, lint и Web production build.
- В ручном browser прогоне с LM Studio обнаружены 23 Model ID; два последовательных хода выполнены выбранной моделью без перезапуска host. После reload восстановились provider, selections и run snapshots. Capabilities остались `unknown`.

#### Scope

- API-key storage поддерживается на macOS; на других платформах нет plaintext fallback. Автоматическая загрузка моделей, GPU management, capability inference, fallback routing и plugin system не входят в этот срез.
