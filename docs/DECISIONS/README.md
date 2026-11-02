# Технические решения (ADR)

Здесь хранятся короткие записи о технических решениях: контекст, варианты, принятое решение, последствия и план пересмотра.

## Правило утверждения

AI может исследовать варианты, подготовить предложение или обновить документацию. ADR со статусом `Accepted` и изменения, зависящие от него, утверждает владелец проекта. Упоминание технологии в `ARCHITECTURE.md` или `CONTRACTS.md` само по себе не означает, что решение принято.

Принятый ADR остаётся действующим до явного решения владельца о его замене. `PRODUCT.md`, `ROADMAP.md`, `NOW.md` и `specs/` не отменяют техническое решение. Если план или spec противоречит принятому ADR, работу нужно остановить и запросить решение владельца; при замене ADR указывается `Superseded` и ссылка на заменяющее решение.

## Принятые решения

- [ADR-0001: Headless-first application API и CLI](ADR-0001-headless-first.md) — единый внутренний Application API и CLI; локальный Web transport принят позднее в ADR-0009.
- [ADR-0002: Один ход через fake provider и store v2](ADR-0002-fake-agent-turn-store-v2.md) — CLI выполняет явный детерминированный ход; JSON-хранилище принимает сообщения пользователя и ассистента и мигрирует v1 при первой записи.
- [ADR-0003: LM Studio через OpenAI-compatible Chat Completions](ADR-0003-lm-studio-provider.md) — первый реальный provider передаёт полную историю одним non-streaming запросом без изменения application API и формата хранилища.
- [ADR-0004: Ограниченный agent loop с одним инструментом](ADR-0004-bounded-agent-tool-loop.md) — до двух вызовов модели и одного вызова инструмента за ход; runtime проверяет разрешение, а tool-сообщения не попадают в store v2.
- [ADR-0005: Явный CLI smoke-инструмент `demo.add`](ADR-0005-cli-demo-add.md) — CLI по умолчанию без tools; подключение `demo.add` и разрешение её исполнения требуют отдельных флагов.
- [ADR-0006: Причина ошибки исполнения инструмента](ADR-0006-tool-error-cause.md) — runtime сохраняет исходную причину в `cause`, оставляя CLI безопасное сообщение ошибки.
- [ADR-0007: Статический React web-макет](ADR-0007-static-react-web-preview.md) — отдельный Vite-пакет для оценки чата на локальных UI-фикстурах без подключения Application API.
- [ADR-0008: Shell и компактная лента агента](ADR-0008-ui-shell-compact-timeline.md) — локальная навигация по демо-сессиям, вкладки Chat/Trajectory и три состояния tool call без изменения backend-контрактов.
- [ADR-0009: Локальный HTTP host для Web](ADR-0009-local-web-host.md) — браузер вызывает Application API через loopback Node host; provider и storage остаются на стороне host.
- [ADR-0010: End-to-end text streaming](ADR-0010-end-to-end-text-streaming.md) — superseded by ADR-0012; исходное решение о раздельном streaming пути.
- [ADR-0011: Внутренний контракт событий хода агента](ADR-0011-agent-event-contract.md) — расширен ADR-0012; общий внутренний порядок model/tool/reasoning и turn events.
- [ADR-0012: Единое исполнение хода агента](ADR-0012-unified-agent-execution.md) — один Application lifecycle и Core loop для text streaming, tool calls, reasoning и отмены; host адаптируют вывод и разрешённые capabilities.
- [ADR-0013: Потоковая передача reasoning deltas](ADR-0013-live-reasoning-deltas.md) — необязательный provider callback и per-model-call `reasoning.delta` event через существующий Core/Event/SSE путь; `reasoning.completed` остаётся canonical завершением блока.
- [ADR-0014: Безопасный Markdown в Web ответах](ADR-0014-safe-markdown-web.md) — Web UI рендерит assistant streaming/final content через `react-markdown` и `remark-gfm`, не включая raw HTML.
- [ADR-0015: Сохранение reasoning завершённых ходов](ADR-0015-persist-completed-reasoning.md) — историческое решение JSON v3, superseded by ADR-0016.
- [ADR-0016: SQLite и trajectory завершённых AgentRun](ADR-0016-sqlite-completed-runs.md) — `Accepted` · `Implemented`; SQLite через `better-sqlite3` 12.9.0, отдельный AgentRunRepository, атомарная запись завершённого ответа и trace, однократный импорт JSON v1/v2/v3; active inference/replay не входят.

## Шаблон

```md
# ADR-NNNN: Краткое название

- Статус: Proposed | Accepted | Rejected | Superseded
- Дата: YYYY-MM-DD
- Утвердил: имя владельца или `не утверждено`

## Контекст
Какую проблему решаем и какие ограничения важны.

## Варианты
Короткий список рассмотренных вариантов с компромиссами.

## Решение
Что выбрано и почему. До утверждения оставить статус `Proposed`.

## Последствия
Плюсы, издержки, затронутые контракты и миграция/откат.
```

## Открытые темы

Схема SQLite v1 и локальная политика хранения completed runs зафиксированы ADR-0016. Active run recovery, event replay, desktop shell (включая возможный Tauri), модели исполнения плагинов, расширение provider capabilities и формат record/replay остаются открытыми. Worker/daemon отложен до фонового сценария.
