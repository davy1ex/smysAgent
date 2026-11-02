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
