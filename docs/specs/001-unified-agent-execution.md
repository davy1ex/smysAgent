# SPEC 001 — Unified Agent Execution

**Направление:** `Accepted` по [`ROADMAP.md`](../ROADMAP.md).

**Архитектура:** `Accepted` в [ADR-0012](../DECISIONS/ADR-0012-unified-agent-execution.md): он заменяет ADR-0010 и расширяет контракт событий из ADR-0011.

**Реализация:** `Implemented` по текущему коду; automated suite прошёл 2026-11-02. Это не утверждение о полной ручной валидации Web UX.

## Цель

CLI и Web выполняют agent turn через один Application lifecycle и один Core loop. Streaming текста, tools, permissions, reasoning events и отмена не должны создавать отдельную бизнес-логику для каждого host.

## Контракт

Принятый технический контракт полностью задаёт [ADR-0012](../DECISIONS/ADR-0012-unified-agent-execution.md). Этот spec фиксирует требования и evidence реализации, не создавая параллельный контракт:

- Application использует `executeTurn()`; старые use case имена являются совместимыми делегатами.
- Core выполняет общий ограниченный loop; provider передаёт нормализованный финальный ответ или tool call и необязательные assistant text deltas.
- Runtime проверяет инструменты и permission policy; CLI и Web не реализуют собственный agent loop.
- Web SSE и CLI streaming передают реальные runtime/lifecycle events и text deltas.
- Полный assistant message сохраняется один раз после успешного завершения. Ошибка или отмена не сохраняет partial assistant text.
- Reasoning остаётся временным результатом хода; текущий контракт не предоставляет reasoning deltas.

## Evidence реализации

- Код: `src/packages/core/agent/runtime.ts`, `src/packages/core/agent/events.ts`, `src/packages/application/use-cases.ts`, `src/packages/providers/`, `src/apps/cli/main.ts`, `src/apps/web-host/server.ts`.
- Проверки: `npm test` — 55 passed, 0 failed. Релевантные тесты находятся в `src/tests/application/session-use-cases.test.ts`, `src/tests/providers/lm-studio-provider.test.ts`, `src/tests/cli/cli-persistence.test.ts` и `src/tests/web-host/web-api.test.ts`.
- В Web React нет отдельного automated rendering test; ручной браузерный сценарий для этого аудита не запускался.

## Границы

Persistent run status, event log/replay, reconnect после reload, продолжение inference после разрыва клиента и защита локального inference resource не входят в подтверждённый контракт M1. Их UX-требования собраны в [spec 002](./002-live-inference-ui.md); архитектурные решения остаются открытыми.
