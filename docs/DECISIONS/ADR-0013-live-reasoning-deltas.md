# ADR-0013: Потоковая передача reasoning deltas

- Статус: Accepted
- Дата: 2026-11-02
- Утвердил: владелец проекта в чате

## Контекст

LM Studio передаёт `reasoning_content` во время SSE-потока до начала assistant `content`. Provider накапливает reasoning и возвращает его только в итоговом `ModelResponse`; Core поэтому публикует `reasoning.completed` после возврата `generate()`. Web UI получает reasoning после assistant deltas.

Требуется показать только фактически полученные provider reasoning chunks до завершения inference, сохранив единый Core loop, существующий `AgentEvent` callback, Web SSE transport, итоговый результат для совместимых consumers и текущее хранение сообщений.

## Варианты

1. Оставить `reasoning.completed` после `generate()` и менять только UI — не даёт доступа к reasoning до возврата provider.
2. Добавить необязательный provider callback и additive `reasoning.delta` event, сохранив `reasoning.completed` как canonical completion event — передаёт фактический порядок дельт через уже существующий runtime/event/SSE путь и не требует второго agent loop или endpoint.

## Решение

- `ModelGenerationOptions` получает необязательный `onReasoningDelta`, аналогичный `onTextDelta`. LM Studio вызывает его для каждого непустого `delta.reasoning_content` при чтении upstream frame и продолжает собирать полный reasoning в `ModelResponse`.
- Во время существующего streaming режима Core ожидает callback, проверяет chunk и публикует `{ type: "reasoning.delta", callIndex, text }` через текущий `AgentEventHandler`. `callIndex` связывает chunk с конкретным вызовом модели.
- После успешного provider response Core оставляет `reasoning.completed` с полным canonical `text` для совместимости CLI и иных consumers, сохраняя один и тот же порядок событий. Для providers без reasoning deltas Core продолжает создавать блок только из `ModelResponse.reasoning`; при отсутствии обоих источников блок не создаётся.
- Web Host не получает отдельной логики: он пересылает новое событие общим SSE event callback. Web API принимает `reasoning.delta`; UI дописывает chunk в step соответствующего `callIndex`. На `reasoning.completed` UI заменяет/сверяет накопленный текст canonical значением и помечает существующий step завершённым, не добавляя второй блок и не конкатенируя текст повторно.
- Fake Provider выдаёт scripted reasoning небольшими последовательными chunks до content chunks, только если предоставлен callback. Паузы остаются детерминированной тестовой частью Fake Provider.
- Если один provider frame содержит и reasoning, и content, Core сохраняет порядок callback-ов этого frame; в LM Studio adapter reasoning callback вызывается перед text callback.
- На момент принятия Text streaming, `turn.completed`, cancellation/error handling, итоговый `AgentTurnResult`, CLI text output и JSON message storage сохраняли прежние контракты. `reasoning.delta` — дополнительный тип runtime/NDJSON event; runtime events по-прежнему не сохраняются.

## Последствия

- Web может показать reasoning до первого content delta, когда upstream присылает его раньше; если provider не выдаёт reasoning delta, UI показывает только существующий нейтральный model status.
- Вызов нового callback ожидается до чтения следующего upstream frame, сохраняя существующий backpressure и последовательность events.
- Клиенты `AgentEvent`/CLI NDJSON увидят дополнительный `reasoning.delta`; существующий `reasoning.completed.text` остаётся полным canonical текстом для совместимости. Consumers должны обновлять per-call block по `callIndex`, а не добавлять completion text второй раз.
- Live reasoning deltas остаются временным состоянием текущего SSE/React turn. Completed per-call reasoning сохраняется позднее по ADR-0015. Active inference recovery и улучшение диагностических ошибок не входят в эти решения.
- Это решение не меняло формат хранения, session lifecycle, Application run lifecycle или transport routes; persistence completed reasoning и JSON v3 добавлены позднее по ADR-0015.
- Откат удаляет `onReasoningDelta`, `reasoning.delta` и Web presentation support; миграция данных не нужна.
