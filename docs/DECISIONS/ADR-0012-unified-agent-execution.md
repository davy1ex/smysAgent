# ADR-0012: Единое исполнение хода агента

- Статус: Accepted
- Дата: 2026-11-02
- Утвердил: владелец проекта в чате

## Контекст

CLI и обычный Web endpoint использовали `runAgentTurn`, а Web SSE — отдельный `runAgentTurnStreaming`. Core имел два алгоритма: ограниченный цикл с tool calls и reasoning и одношаговый текстовый stream, который запрещал tools. LM Studio также разделял `generate()` и `streamText()`; streaming-метод возвращал только текстовые чанки и не мог завершить tool call. Это позволяло одинаковому ходу зависеть от host и выбранного transport режима.

ADR-0010 ввёл end-to-end streaming как отдельный путь. ADR-0011 определил общий callback событий, но оставил циклы исполнения раздельными.

## Варианты

1. Оставить два Core пути и объединить только запись сообщений в Application — уменьшает дублирование lifecycle, но сохраняет разную семантику хода.
2. Оставить один Application `executeTurn` и один Core loop; расширить `generate()` необязательными отменой и callback текстовых дельт, сохранив нормализованный итоговый `ModelResponse` — позволяет streaming и tool calls в одном цикле.

## Решение

- Application предоставляет `executeTurn()` как единственный lifecycle use case. Старые `runAgentTurn()` и `runAgentTurnStreaming()` остаются совместимыми делегатами.
- Core использует один ограниченный цикл: до двух model calls и одного tool execution. Для любого model call он может передать `AbortSignal` и callback `onTextDelta`; итогом остаётся `final` или `tool-call`.
- Provider-port — `generate(request, { signal?, onTextDelta? })`. Без callback LM Studio отправляет `stream: false`; с callback отправляет `stream: true`, преобразует текстовые чанки, reasoning и один собранный tool call в единый нормализованный ответ. Fake provider поддерживает тот же контракт.
- Application последовательно выдаёт одинаковые `AgentEvent` независимо от выбранного транспорта. Web SSE передаёт runtime и turn events; текстовые чанки и reasoning остаются временными и не входят в store.
- Web request может явно передать `allowTools`. Host предлагает runtime только зарегистрированные и выбранные для этого хода инструменты; без grant инструменты не подключаются. Web UI отдельно включает `demo.add` для текущего сообщения. Permission policy всё равно проверяется runtime до исполнения.
- CLI сохраняет прежний вывод без флагов и контракт `--json`. Новый `--stream` печатает текстовые дельты; `--stream --output ndjson` выводит строки событий. `--json` несовместим с потоковым режимом. `SIGINT` отменяет ход с кодом выхода `130` и `ABORTED`.
- Формат хранения, зависимости и структура сообщений не меняются. При успехе сохраняются user message и финальный assistant text; при ошибке или отмене частичный ответ не сохраняется.

## Последствия

- Provider и Web SSE контракты расширены; старые обычные JSON callers сохраняют форму ответа, а CLI `--json` остаётся прежним.
- OpenAI-compatible streaming tool-call fragments собираются и валидируются. Несколько tool calls, некорректные аргументы и смешанный текст/tool-call отклоняются.
- `onEvent` ожидается последовательно. Медленный Web/CLI consumer оказывает обратное давление на чтение provider stream.
- Web grant — одноразовое явное разрешение на текущий ход, а не интерактивный запрос разрешения в середине исполнения. `ask-user` через runtime остаётся отложенным.
- Откат возвращает provider adapters и host routes к отдельным путям ADR-0010. Формат store и существующая история не затрагиваются.
