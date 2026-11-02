# SMYS — NOW

> Проверено 2026-11-02 на исходном HEAD `b08bf82` по коду, тестам и ADR. Этот файл описывает текущее состояние, но не заменяет принятые технические решения.

## Текущий фокус

Уточнить отдельные вертикальные срезы для live-inference UI по [`specs/002-live-inference-ui.md`](./specs/002-live-inference-ui.md). Требования UX утверждены владельцем; новые provider/event/API/storage контракты и реализация пока не утверждены.

## Утверждённое направление и состояние

- Стратегия SMYS и шесть направлений развития зафиксированы в [`PRODUCT.md`](./PRODUCT.md) и [`ROADMAP.md`](./ROADMAP.md).
- **M1 — Unified Agent Execution:** направление принято, единый Application lifecycle и Core loop реализованы по [ADR-0012](./DECISIONS/ADR-0012-unified-agent-execution.md). Полный `npm test` прошёл: 55 тестов, 0 ошибок. Ручная проверка React UI не проводилась, поэтому milestone не помечен как полностью validated.
- Web передаёт реальные runtime/lifecycle SSE events и показывает assistant text deltas по мере поступления. Web создаёт временный пустой assistant draft, затем пополняет его дельтами.
- LM Studio adapter собирает provider reasoning в ходе stream, но не передаёт его по дельтам. Runtime выдаёт `reasoning.completed` только после возврата provider; Web сохраняет reasoning в состоянии React после `turn.completed` и показывает его в раскрываемом блоке у готового ответа.
- История JSON store содержит user/assistant messages. Run state, reasoning, runtime events и partial answer не сохраняются.

## Подтверждённые пробелы

- Live reasoning до/во время генерации отсутствует; вместо него при начале model call показывается общий activity status.
- При первом открытии страницы Web загружает sessions/history, но не запрашивает состояние активного run и не восстанавливает подписку. Обновление страницы закрывает SSE stream; Host передаёт его `AbortSignal` provider, поэтому текущая генерация отменяется.
- Переключение чата в том же смонтированном UI скрывает общий локальный pending turn, но не закрывает текущий stream; после возврата состояние снова видно. Snapshot/status API и повторной подписки нет.
- Один экземпляр Web UI блокирует повторную отправку локальным `sending`; Web host последовательно выполняет изменяющие запросы в одном процессе. Это не даёт idempotency и не координирует Web host с отдельным CLI-процессом.

## Evidence

- Core/Application/Host/Web: `src/packages/core/agent/runtime.ts`, `src/packages/core/agent/events.ts`, `src/packages/providers/lm-studio-provider.ts`, `src/packages/application/use-cases.ts`, `src/apps/web-host/server.ts`, `src/apps/web/src/api.ts`, `src/apps/web/src/App.tsx`.
- Проверки: `npm test` — 55 passed. В частности, тесты покрывают streaming текста до окончания provider stream, порядок reasoning event после provider response, сохранение финального ответа один раз и отмену provider при разрыве Web stream. React rendering отдельными тестами не покрыт.
- Прогресс шести направлений и открытые технические решения: [`ROADMAP.md`](./ROADMAP.md), [`specs/001-unified-agent-execution.md`](./specs/001-unified-agent-execution.md), [`specs/002-live-inference-ui.md`](./specs/002-live-inference-ui.md).

## Следующий шаг

Владелец выбирает и утверждает отдельное архитектурное решение для live reasoning и восстановления/координации run. После этого можно определить один небольшой implementation slice и его проверяемый критерий. Документационное слияние не является разрешением начать эту реализацию.
