# SPEC 002 — Live Inference UI

**UX-требования:** `Accepted` владельцем 2026-11-02.

**Текущее поведение:** проверено по коду и automated tests на HEAD `b08bf82`; браузерная ручная проверка не проводилась.

**Новые технические контракты:** `Proposed` / открыты; этот spec не утверждает `reasoning.delta`, persistent runs, replay, resource locks или SQLite.

## Цель

Web показывает фактическое развитие agent turn в процессе исполнения. Клиент отображает состояние и события, полученные от backend, и не придумывает reasoning или статус завершения.

## Реализовано сейчас

- LM Studio provider в streaming mode передаёт assistant text chunks до конца upstream stream. Core публикует их как `assistant.delta`; Application сохраняет объединённый assistant message один раз после успешного завершения. Fake provider также выдаёт ответ частями.
- Web SSE передаёт `turn.started`, model/tool events, `assistant.delta` и terminal turn event. React сразу создаёт временный пустой assistant draft, добавляет текстовые дельты, показывает курсор и текущий activity label.
- UI начинает с пользовательского `pending` состояния и реагирует на реальные `model.started`/tool events, но сам run status хранится в локальном React state.
- Provider может вернуть reasoning отдельно от ответа. Оно не хранится в JSON history.

Evidence: `src/packages/providers/lm-studio-provider.ts`, `src/packages/core/agent/runtime.ts`, `src/packages/application/use-cases.ts`, `src/apps/web-host/server.ts`, `src/apps/web/src/api.ts`, `src/apps/web/src/App.tsx`; тесты `LM Studio provider yields a token before the upstream stream completes`, `streaming Web API delivers deltas before model completion and persists once before completed` и `application emits ordered per-call reasoning and tool events around persistence`. `npm test`: 55 passed.

## Подтверждённые UX-проблемы и границы

- **Reasoning не отображается live.** LM Studio накапливает `reasoning_content` в памяти provider, затем возвращает его вместе с итоговым `ModelResponse`. Core эмитит `reasoning.completed` после завершения `provider.generate()`. Web не обновляет reasoning по этому runtime event; после `turn.completed` React привязывает reasoning к сохранённому assistant message и показывает `<details>` под ответом. Значит, гипотеза из приложенной заметки о post-hoc блоке подтверждена; гипотеза об отсутствии text streaming опровергается кодом и тестами.
- **Run не восстанавливается после reload/reopen.** При старте React загружает sessions/history; endpoint для получения активного run, snapshot и replay/subscription cursor отсутствуют. Pending/draft/reasoning состояния живут в React state и не сохраняются.
- **Reload сейчас отменяет подключённую генерацию.** `AbortSignal` HTTP-запроса передаётся через Web host до provider. Web API test `disconnecting a streaming Web request aborts provider generation` подтверждает это поведение.
- **Переключение чата в одной живой вкладке не равно восстановлению.** Текущий общий `pending` остаётся в React и активный SSE stream продолжает работать, но состояние скрыто, пока выбрана другая сессия; после возврата оно снова видно. Backend snapshot/reconnect нет.
- **Защита от повторного запуска ограничена.** Один React App не принимает новую отправку при `sending`; один Web host ставит изменяющие запросы в последовательную очередь. Idempotency key/deduplication и общий lock между Web host и отдельным CLI process отсутствуют. Поэтому повторный запрос может выполниться позднее, а независимые процессы не координируются.

## Требуемое поведение

1. Assistant answer появляется как draft во время active run и отображается постепенно по фактическим text deltas. Эта часть уже реализована в текущем Web path.
2. Если provider выдаёт reasoning, UI показывает отдельный блок до финального ответа и обновляет его по мере поступления.
3. Если provider reasoning не выдаёт, UI показывает только правдивый status вроде «Размышляет…» или «Генерирует ответ…»; reasoning не выдумывается.
4. UI показывает фактический backend/run status, а не только локальное значение `sending`.
5. После reload или повторного открытия сессии UI восстанавливает active run state и продолжает получать новые события, если run ещё выполняется.
6. Повторное действие пользователя не должно незаметно создавать конкурирующий локальный inference. Политика отклонения, очереди или deduplication должна быть явной.
7. После завершения сохраняется ровно один финальный assistant history message; временный draft не дублируется.

## Разделение дальнейшей работы

Это несколько независимых срезов, а не один implementation milestone:

1. **Live reasoning display.** Сначала решить, как provider сообщает reasoning chunks, как Core/Application передают их Web host и как транспортирует SSE. Новый event/callback контракт требует ADR до реализации.
2. **Active run reconciliation while host is alive.** Отдельно определить владельца run, status/snapshot API, подписку и cursor/replay semantics, cancel/disconnect semantics, idempotency и правила конкуренции между сессиями/клиентами. Это не только UI-задача.
3. **Durable state and process restart.** Отдельно определить, какие status/events сохраняются, как run становится `interrupted` после потери backend и что восстанавливается. Реальная генерация не считается продолжающейся после перезапуска provider без доказательства. Выбор SQLite требует собственного принятого ADR.

Текущий текстовый streaming не требует повторной реализации как отдельного milestone; его можно включить в проверку каждого будущего среза.

## Критерии приёмки UX

- Искусственно задержанный provider показывает assistant text до окончания ответа.
- Provider с reasoning chunks показывает обновляющийся reasoning panel до финального ответа; provider без reasoning показывает status без сфабрикованного текста.
- Финальный ответ появляется в history ровно один раз после `completed`.
- Reload/reopen показывает server-authoritative активное состояние, а reconnect продолжает получать события без запуска второго provider call.
- Потеря SSE-соединения не подменяется ложным `completed`/`failed`; эффект на run задаётся принятым контрактом.
- Повторная отправка и запрос из независимого клиента/host следуют явной политике локального resource concurrency.

## Открытые решения владельца

- Какой provider/Core/Application event контракт нужен для live reasoning chunks; какие providers реально поддерживают их?
- Должен ли disconnect отменять run или только подписку? Как пользователь явно отменяет run?
- Где живёт авторитетный run registry и какие status/snapshot/replay API нужны?
- Как гарантировать отсутствие незаметного повторного/параллельного локального inference между Web host и CLI: общий host, межпроцессная координация, очередь или конфликт?
- Что переживает перезапуск Web host/provider и как обозначается неизвестное или прерванное состояние?
- Нужна ли SQLite для долговременного хранения, или сначала достаточно другого принятого решения о persistence?

До принятия необходимых ADR эти вопросы остаются `Proposed`; текущие контракты ADR-0012 продолжают действовать.
