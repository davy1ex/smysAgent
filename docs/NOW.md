# SMYS — NOW

> Проверено 2026-11-02 после реализации SQLite completed-run traces, миграции JSON и восстановления Web истории по исходникам, тестам, ADR и независимому клиенту.

## Текущий фокус

Live Inference UX и восстановление trajectory завершённых ходов реализованы. Следующий отдельный срез — active inference recovery, reconnect и event replay; они не входят в текущую реализацию.

## Утверждённое направление и состояние

- Стратегия SMYS и шесть направлений развития зафиксированы в [`PRODUCT.md`](./PRODUCT.md) и [`ROADMAP.md`](./ROADMAP.md).
- **M1 — Unified Agent Execution:** общий Application lifecycle и Core loop реализованы по [ADR-0012](./DECISIONS/ADR-0012-unified-agent-execution.md). Live reasoning event contract — [ADR-0013](./DECISIONS/ADR-0013-live-reasoning-deltas.md), безопасный Markdown Web — [ADR-0014](./DECISIONS/ADR-0014-safe-markdown-web.md). [ADR-0016](./DECISIONS/ADR-0016-sqlite-completed-runs.md) supersedes способ persistence из ADR-0015.
- LM Studio adapter вызывает необязательный `onReasoningDelta` при получении `reasoning_content`. Core публикует per-call `reasoning.delta`; существующий SSE передаёт его React до завершения model call. `reasoning.completed` остаётся canonical completion и обновляет блок, не дублируя текст.
- React показывает в однострочном `Think` preview текущую логическую строку reasoning. Строка растёт по реальным дельтам и начинается заново после `\n`/`\r\n`; пустая активная строка показывает нейтральное `…`, а длинная — актуальный хвост с обрезанием слева. После завершения используется последняя непустая строка. Полный raw provider text сохраняется с исходными переносами и доступен по раскрытию; при отсутствии reasoning блок не создаётся. Первый `assistant.delta` завершает статус reasoning активного model call; `reasoning.completed` сверяет полный canonical text.
- Web рендерит streaming и финальный assistant text через `react-markdown` + `remark-gfm`. Raw HTML не рендерится, небезопасные URL не становятся активными ссылками. Assistant `delta` остаётся потоковым.
- Completed AgentRun отдельно хранит ordered model, per-call full reasoning и tool steps. Run связан с session, user message и assistant message стабильными IDs; финальный текст существует только в обычном assistant message. Application history API возвращает messages и runs одним ответом; React восстанавливает timeline по `assistantMessageId`. `reasoning.completed` сохраняется ровно один раз; `reasoning.delta` остаётся stream-only.
- Web Host и CLI используют SQLite `store.sqlite`; завершение сохраняет assistant message и trace атомарно. JSON v1/v2/v3 импортируется один раз с exact-byte backup `store.json.vN.sqlite.bak`; legacy reasoning сохраняется, исторические traces не выдумываются. Файл SQLite создаётся с mode `0600`; reasoning и tool args/results хранятся локально без маскирования/шифрования и не попадают в логи. `sessionStorage` не используется.

## Известные ограничения и открытые задачи

- Completed reasoning и tool/model trajectory восстанавливаются после перезапуска Web Host и из независимого browser/API клиента. Незавершённый UI draft и active inference не восстанавливаются: закрытие SSE передаёт cancellation provider.
- Persisted traces есть только для успешно завершённых runs. Active run state, event replay/reconnect и inference resource lock не реализованы.
- Аудит ошибок: `ECONNRESET` из `fetch` попадает в общий catch `src/packages/providers/lm-studio-provider.ts` и преобразуется в `LmStudioProviderError("Could not connect to LM Studio.")` без исходной ошибки/cause; Web Host классифицирует её как `PROVIDER_ERROR`, поэтому код `ECONNRESET` теряется. Отдельный fallback Host `An unexpected error occurred.` в `toApiFailure()` применяется к нераспознанным исключениям и также не раскрывает тип/cause; это generic error path, а не сообщение нормализованного `ECONNRESET`. Улучшение диагностики оставлено отдельной задачей.

## Evidence

- Код пути событий: `src/packages/core/agent/model.ts`, `src/packages/core/agent/events.ts`, `src/packages/core/agent/runtime.ts`, `src/packages/providers/lm-studio-provider.ts`, `src/packages/providers/fake-provider.ts`, `src/apps/web-host/server.ts`, `src/apps/web/src/api.ts`, `src/apps/web-ui/turn-presentation.ts`, `src/apps/web/src/App.tsx`.
- Проверки: 76 root + 3 Web tests прошли; также прошли root build, typecheck, lint и Web production build. Suite проверяет SQLite reopen, импорт v1/v2/v3 и exact backups, атомарность completed-run записи, ordered tool/reasoning restore, Web Host restart и два независимых API clients.
- Ручная browser проверка: после завершённого run новый IAB tab открыл восстановленную Web Host сессию из SQLite и показал обе полные reasoning строки, `demo.add` между ними и один финальный assistant message. Это отдельный browser client, а не reload исходной вкладки.
- Ручной прогон в браузере с реальной LM Studio, `qwen3.8-9b-mlx`: upstream `reasoning_content` появился до assistant `content`; React показал reasoning при пустом assistant draft. DOM polling выполнялся с периодом 250 мс; timestamps одного прогона, UTC:

  | Участок | Событие | Timestamp |
  | --- | --- | --- |
  | LM Studio → provider | первый `reasoning_content` delta, 8 chars | `2026-11-02T07:32:11.346Z` |
  | Core → SSE | первый `reasoning.delta`, `callIndex=1` | `2026-11-02T07:32:11.347Z` |
  | React DOM | первый reasoning виден, assistant content = 0 | `2026-11-02T07:32:11.473Z` |
  | LM Studio → provider | первый `content` delta, 2 chars | `2026-11-02T07:32:26.876Z` |
  | Core → SSE | первый `assistant.delta` | `2026-11-02T07:32:26.885Z` |
  | React DOM | первый assistant content виден | `2026-11-02T07:32:27.180Z` |

  Между первыми DOM-наблюдениями reasoning и content — `15.707 s`; reasoning был виден до первого assistant content. Погрешность DOM timestamp ограничена интервалом polling до 250 мс. Раскрытый блок содержал 890 chars, `white-space: pre-wrap`, `overflow-y: auto`, высота содержимого была больше viewport блока.
- Ручной прогон UI в браузере на Fake Provider с задержками и текстом из трёх строк (`\r\n`, пустая строка, `\n`): preview постепенно показывал первую строку, затем начинал отображать вторую и третью с начала. Блок оставался свёрнутым по умолчанию; раскрытый текст содержал 334 chars и исходные `\r\n`/пустую строку. После окончания строка перешла в `Анализ завершён` и показывала последнюю непустую строку.
- Открытые направления и критерии: [`ROADMAP.md`](./ROADMAP.md), [`specs/001-unified-agent-execution.md`](./specs/001-unified-agent-execution.md), [`specs/002-live-inference-ui.md`](./specs/002-live-inference-ui.md).

## Следующий шаг

Спроектировать active run recovery и replay отдельным ADR до изменения lifecycle/transport. Диагностику ECONNRESET вести отдельной задачей.
