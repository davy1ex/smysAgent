# SPEC 002 — Live Inference UI

**UX-требования:** `Accepted` владельцем 2026-11-02.

**Текущее поведение:** Stage A, Live Reasoning Streaming (Stage B), backend persistence reasoning завершённых ходов и безопасный Web Markdown `Implemented` по тестам; live streaming ранее проверен на LM Studio.

**Технические решения:** контракты `reasoning.delta`, Web Markdown и persistence completed reasoning приняты в [ADR-0013](../DECISIONS/ADR-0013-live-reasoning-deltas.md), [ADR-0014](../DECISIONS/ADR-0014-safe-markdown-web.md) и [ADR-0015](../DECISIONS/ADR-0015-persist-completed-reasoning.md). Active run recovery, replay, resource locks и SQLite в этой задаче не входят.

## Цель

Web показывает фактическое развитие agent turn во время исполнения. Клиент отображает события backend и не придумывает reasoning или статус завершения.

## Реализовано

- LM Studio adapter вызывает необязательный provider callback `onReasoningDelta` для каждого непустого `reasoning_content` chunk при его поступлении. В том же frame reasoning передаётся раньше content; итоговый `ModelResponse.reasoning` сохраняется.
- Core выдаёт `{ type: "reasoning.delta", callIndex, text }` через существующий `AgentEvent` handler в активном streaming model call. После успешного ответа сохраняется `reasoning.completed` с полным canonical text. Если reasoning уже streamed, UI обновляет существующий блок значением completion и не дописывает его повторно.
- Web Host передаёт новое событие общим SSE callback; Web API его принимает. React создаёт свернутый reasoning block при первом реальном chunk, без потерь добавляет chunks в нужный `callIndex` и показывает текущую последнюю логическую строку в однострочном preview. Строка переключается после `\n`/`\r\n`; пустая активная строка показывает нейтральный `…`, а длинная обрезается слева с сохранением хвоста. Полный текст и исходные переносы доступны с начала при раскрытии.
- Provider, возвращающий reasoning только итоговым полем, создаёт block при получении этого поля. При отсутствии reasoning UI показывает только фактический нейтральный статус model call.
- Fake Provider выдаёт delayed reasoning chunks до assistant content. Первый фактический `assistant.delta` помечает reasoning активного model call завершённым и переключает строку на `Анализ завершён`; последующие assistant deltas не меняют текст reasoning. `reasoning.completed` остаётся canonical источником полного текста и сверяет накопленные chunks без дублей. Draft постепенно заменяется одним финальным сообщением после `turn.completed`.
- Финальный и потоковый assistant text рендерятся `react-markdown` + `remark-gfm`. Raw HTML выключен, небезопасные URL schemes не становятся активными ссылками; безопасная обработка не использует `dangerouslySetInnerHTML` или raw HTML plugin.
- При успешном завершении Application сохраняет per-call записи reasoning на assistant message. JSON store v3 мигрирует v1/v2 на первой записи с сохранением исходного файла в versioned backup; history API возвращает поле, а React восстанавливает свёрнутые блоки после reload. sessionStorage не используется.
- Runtime events, partial reasoning ошибочных/отменённых ходов, UI draft и active inference не сохраняются и не восстанавливаются.

## Evidence и проверки

Изменения проверены в Core/Application, provider adapters, JSON storage, Web Host/API, `src/apps/web-ui/turn-presentation.ts` и Web UI; решение о completed reasoning persistence описано в ADR-0015.

- `npm test`: 71 root tests passed; Web Markdown suite: 3 passed.
- `npm run typecheck`, `npm run lint` и `src/apps/web` `npm run build` прошли.
- Тесты проверяют delayed provider chunks, upstream порядок reasoning/content, SSE per-call events, постепенное состояние UI, длинный текст, несколько model calls, reconciliation без дублей, whole-text reasoning fallback, отсутствие reasoning, persistence после повторного открытия JSON store, миграции v1/v2 → v3 и сохранение backup, history API, восстановление UI из истории, cancellation/error state, Markdown/GFM, incremental streaming, raw HTML и небезопасные ссылки.
- Browser reload после этой persistence-правки вручную не проверен: канал управления браузером завершился с `Transport closed`. Повторное открытие JSON store и восстановление UI state отдельно покрыты storage, Web API и presentation тестами.
- Ручной браузерный прогон с `qwen3.8-9b-mlx` подтвердил в одном ходе: `reasoning_content` `2026-11-02T07:32:11.346Z`; `reasoning.delta` SSE `07:32:11.347Z`; первый DOM render reasoning при пустом content `07:32:11.473Z`; первый upstream content `07:32:26.876Z`; `assistant.delta` SSE `07:32:26.885Z`; первый DOM render assistant content `07:32:27.180Z`. DOM polling interval — до 250 мс.
- UI tests проверяют preview после каждого заданного `reasoning.delta`, рост текущей строки, reset на переносе, пустые строки, несколько переносов в одном чанке, CRLF, длинную строку, полный source text, completed preview и независимость model calls. Ручной браузерный прогон на delayed Fake Provider с настоящими `\r\n` и `\n` подтвердил переключение между строками, свёрнутое состояние во время стрима, раскрытие полного текста с исходными переносами и последнюю непустую строку после завершения.

## Границы и открытые задачи

- Completed reasoning сохраняется backend и доступен после Cmd+R. Reload во время active inference по-прежнему отменяет provider request при закрытии SSE; draft и активный ход не восстанавливаются. Для этого нужны отдельные backend status/snapshot/replay и reconnect contracts.
- SQLite, durable trajectory, cross-process inference resource locks и второй agent loop не реализуются этим spec/патчем.
- Аудит диагностических ошибок записан в [`NOW.md`](../NOW.md): `ECONNRESET` теряет исходную причину в provider catch и приходит в Web как generic `PROVIDER_ERROR`. Улучшение диагностики — отдельная задача.

## Принятые критерии Live Inference UX

1. Assistant content отображается по фактическим `assistant.delta` и сохраняется в истории один раз — `Implemented`.
2. Если upstream отдаёт reasoning раньше content, первый chunk виден в UI до первого assistant content — `Implemented` и проверено на LM Studio.
3. Все reasoning chunks доступны в раскрытом блоке, с переносами и прокруткой; отдельные model calls не смешиваются — `Implemented`.
4. `reasoning.completed` завершает/сверяет тот же per-call block без дублей; отсутствие reasoning не создаёт вымышленный текст — `Implemented`.
5. Финальный Markdown поддерживает GFM и потоковое обновление; raw HTML и unsafe URL не исполняются — `Implemented`.
6. Ошибка/отмена не переводит ход в success и сохраняет уже полученный partial reasoning в состоянии завершения ошибки — `Implemented` по тестам.
7. После завершённого хода history восстанавливает per-call reasoning после reload — `Implemented`, storage/Application/Web API/UI tests passed. Восстановление активного inference и replay/reconnect без дублей — `Planned`.
8. Свёрнутый preview постепенно показывает текущую логическую строку и начинает с начала после переноса; пустая активная строка показывает `…`, длинная строка сохраняет хвост с обрезанием слева, полный текст не меняется — `Implemented`, UI test и browser проверены.
9. Первый assistant content event завершает статус reasoning текущего model call без ожидания `turn.completed`; streaming ответа не меняет уже завершённый reasoning — `Implemented`, UI test и Fake Provider browser прогон проверены.
