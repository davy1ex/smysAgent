# ADR-0016: SQLite и trajectory завершённых AgentRun

- Статус: Accepted
- Реализация: Implemented (2026-11-02, commit `7def147`)
- Дата: 2026-11-02
- Утвердил: владелец проекта в чате

## Контекст

JSON store v3 сохраняет per-call reasoning на assistant message, но не связывает run с user/assistant message IDs и не сохраняет model/tool шаги. Web восстанавливает историю сообщений, а runtime events теряются после завершения процесса. Активное inference recovery и replay не входят в этот срез.

ADR-0015 выбрал поле `assistantMessage.reasoning` для узкой задачи восстановления reasoning при существующем JSON store. Требования к completed run traces расширяют эту задачу: нужен отдельный Application port, упорядоченные tool/model/reasoning steps и связь по устойчивым ID.

## Варианты

1. Добавить trace в JSON store v4 — не выбрано: оставляет ограничения текущего хранилища и не использует принятое направление SQLite.
2. Оставить JSON для сообщений и создать SQLite sidecar для runs — не выбрано: создаёт два активных источника истины и не даёт атомарно записать ответ и trace.
3. Импортировать JSON в SQLite и хранить сессии, сообщения и runs в одной БД — выбрано: миграция выполняется один раз, а завершение хода атомарно.

## Решение

- Использовать `better-sqlite3` версии `12.9.0` как SQLite driver и сохранить требование Node `>=20`. TypeScript declarations предоставляет `@types/better-sqlite3`. Драйвер остаётся внутри storage adapter; Core его не импортирует.
- Единственный активный store — `<dataDir>/store.sqlite`. Схема `user_version=1` содержит `sessions`, `messages`, `agent_runs`, `agent_run_steps` и `app_metadata`.
- `agent_runs` хранит `id`, `session_id`, `user_message_id`, `assistant_message_id`, статус `completed`, `started_at`, `completed_at`. Ссылки на сообщения используют их ID и session ID.
- `agent_run_steps` хранит возрастающий `ordinal` и JSON одного из шагов: `model { callIndex, phase }`, `reasoning { callIndex, text }`, `tool { callIndex, callId, name, arguments, result }`.
- Application port `AgentRunRepository.completeRun()` одной SQLite-транзакцией создаёт финальное assistant message и связанный completed run. `listCompletedRuns()` возвращает traces по порядку связанных user messages. `getSessionTrajectory()` соединяет сообщения и runs для HTTP history response.
- Application сохраняет canonical `reasoning.completed` один раз на model call. `reasoning.delta` остаётся временным stream; итоговый assistant text хранится только в сообщении. Core Runtime и SSE event contract не меняются.
- Web Host и CLI используют один SQLite adapter. `GET /api/sessions/:id/history` возвращает прежние `session` и `messages` плюс `runs`. Web связывает trace с ответом через `assistantMessageId`; старое поле `assistantMessage.reasoning` остаётся fallback для импортированных данных.
- При первом открытии новой SQLite БД импортировать JSON v1/v2/v3 в одной транзакции, сохраняя IDs, sequence, timestamps, legacy reasoning и дополнительные JSON поля. Сохранить исходные bytes как `store.json.vN.sqlite.bak`. Не синтезировать traces для старых запусков. После успешного импорта JSON больше не читается как активное хранилище. При последующих стартах существующая SQLite БД не импортируется повторно.
- Сохранять полное reasoning, tool arguments и tool results только после успешного завершения. Трассы хранятся локально рядом с сообщениями, с правами файла `0600`; payload не выводится в логи. Ключи provider не сохраняются. Срок хранения совпадает с историей сессии; отдельного TTL или удаления сессий пока нет.
- Ошибочные, отменённые и активные runs не сохраняются. Reconnect, active inference, event replay, scheduler и subagents не входят в решение.

## Последствия

- Стабильная связь run/message убирает привязку к соседству сообщений; история старых сессий без traces остаётся корректной.
- Изменяется Application API: успешное завершение требует `ApplicationRepository`, сочетающего `SessionRepository` и `AgentRunRepository`.
- После импорта JSON становится историческим backup. Возврат к JSON-only версии не сохранит новые сообщения и runs, созданные после импорта; для downgrade нужен SQLite-aware экспорт или backup БД. Двойная запись в JSON не выполняется.
- Reasoning и сырые tool arguments/results могут содержать чувствительные данные. Они сохраняются без шифрования и маскирования в локальной БД, защищённой файловыми правами и правами пользователя ОС.

## Проверяемое поведение

- Перезапуск SQLite repository и Web Host сохраняет ровно один assistant message и связанные ordered trace steps.
- Второй API client получает идентичные `messages` и `runs`; сессия без traces возвращает `runs: []`.
- Сбой транзакции завершения не оставляет assistant message без trace.

## Evidence реализации

- Storage: [`sqlite-application-repository.ts`](../../src/packages/storage/sqlite-application-repository.ts); Application port и сбор trace: [`ports.ts`](../../src/packages/application/ports.ts), [`use-cases.ts`](../../src/packages/application/use-cases.ts).
- History API и UI restore: [`server.ts`](../../src/apps/web-host/server.ts), [`App.tsx`](../../src/apps/web/src/App.tsx), [`turn-presentation.ts`](../../src/apps/web-ui/turn-presentation.ts).
- Automated verification: 76 root tests и 3 Web tests passed; root build, typecheck, lint и Web production build passed. Отдельно проверен перезапуск Web Host и независимое browser/API чтение.
