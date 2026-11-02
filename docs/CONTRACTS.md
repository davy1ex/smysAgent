# Contracts

**Статус:** разделы Application API, local Web HTTP API, CLI и SQLite storage описывают реализованные контракты. Ограниченный agent loop и tool-calling provider зафиксированы в ADR-0004; единое исполнение, event streaming, completed reasoning, AgentRun persistence и provider/model configuration — в ADR-0012—0017. Active run replay остаётся будущим сценарием.

## Принципы проектирования

Это ориентиры для внутренних контрактов. Событийный журнал остаётся будущим сценарием; ограниченное выполнение инструмента реализовано и проходит проверку разрешений.

- Внутренние сообщения и события не повторяют формат конкретного API модели.
- Сохранённые данные имеют версионируемый собственный формат.
- Для каждого события важен стабильный порядок в пределах сессии.
- Вызов инструмента — запрос, который проходит проверку разрешений до выполнения.
- Внутренние ошибки нормализованы; адаптер может сохранять безопасную диагностическую причину, не протекая в core типами SDK.

## Реализованный Application API и CLI

Application API — внутренний интерфейс use cases, через который host просит приложение выполнить операцию. CLI вызывает его in-process, локальный Web HTTP host вызывает тот же API из отдельного Node-процесса. `createProject` и `replaySession` не реализованы.

Тесты могут вызывать use cases напрямую с подменёнными портами. React-клиент вызывает HTTP transport и не импортирует Application, Core или providers.

CLI — headless-вход для ручного запуска, скриптов, Codex и диагностики. Контракт покрывает создание сессии, отправку сообщения без модели, ход по сохранённому provider/model selection или через legacy fake/LM Studio flags/env, а также чтение истории. `--model-config-id` задаёт одноразовый override; без него действует session selection, global default и затем legacy env. По умолчанию CLI не передаёт инструменты; для smoke-сценария можно явно подключить встроенный `demo.add` и отдельно разрешить его исполнение. Скриптовый режим поддерживает JSON в stdout и стабильные коды завершения; формы приведены ниже. Unit/integration тесты запускаются package scripts и могут вызывать application API напрямую.

CLI не содержит собственной реализации agent loop. Он передаёт подключённый инструмент и permission policy в application use case; runtime проверяет вызов и permission до исполнения. Scheduler/worker не реализован; правила расписания, повторы и восстановление потребуют отдельного контракта до появления такого входа.

`executeTurn` и один Core runtime loop обслуживают hosts с текстовым и потоковым выводом. Application events передаются через callback; Web host переносит runtime events в SSE. После успеха Application отдельно сохраняет completed AgentRun trace, связанный с user и assistant messages. Полный журнал событий, active-run replay и reconnect остаются будущими задачами.

### Сигнатуры реализованных use cases

Текущий внутренний API предоставляет следующие use cases:

```ts
createSession(repository: SessionRepository): Promise<Session>
listSessions(repository: SessionRepository, modelSelections?: Pick<ProviderConfigurationRepository, "getSessionModelConfigId">): Promise<SessionSummary[]>
sendMessage(repository: SessionRepository, input: { sessionId: string; text: string }): Promise<UserMessage>
executeTurn(repository: ApplicationRepository, provider: TextGenerationProvider, input: { sessionId: string; text: string; runId?: string; modelSelection?: ModelSelectionSnapshot }, options?: AgentExecutionOptions): Promise<{ runId: string; userMessage: UserMessage; assistantMessage: AssistantMessage; reasoning?: string }>
runAgentTurn(...): Promise<{ runId: string; userMessage: UserMessage; assistantMessage: AssistantMessage; reasoning?: string }> // compatibility delegate
runAgentTurnStreaming(...): Promise<{ runId: string; userMessage: UserMessage; assistantMessage: AssistantMessage }> // compatibility delegate
getHistory(repository: SessionRepository, sessionId: string): Promise<SessionHistory>
getSessionTrajectory(repository: ApplicationRepository, sessionId: string): Promise<SessionTrajectory>

interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  selectedModelConfigId?: string;
}

interface SessionRepository {
  createSession(session: Session): Promise<void>;
  listSessionHistories(): Promise<SessionHistory[]>;
  appendUserMessage(sessionId: string, draft: { id: string; createdAt: string; text: string }): Promise<UserMessage | null>;
  appendAssistantMessage(sessionId: string, draft: { id: string; createdAt: string; text: string; reasoning?: { callIndex: number; text: string }[] }): Promise<AssistantMessage | null>;
  getHistory(sessionId: string): Promise<SessionHistory | null>;
}

type AgentRunStep =
  | { type: "model"; callIndex: number; phase: "waiting" | "generating" }
  | { type: "reasoning"; callIndex: number; text: string }
  | { type: "tool"; callIndex: number; callId: string; name: string; arguments: unknown; result: string };

interface CompletedAgentRun {
  id: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: "completed";
  startedAt: string;
  completedAt: string;
  steps: AgentRunStep[];
  modelSelection?: ModelSelectionSnapshot;
}

interface ModelSelectionSnapshot {
  providerId: string;
  providerName: string;
  modelConfigId: string;
  modelId: string;
  modelName: string;
}

interface AgentRunRepository {
  /** Atomically appends the assistant message and the completed run trace. */
  completeRun(input: { run: CompletedAgentRun; assistantMessage: AssistantMessageDraft }): Promise<AssistantMessage | null>;
  listCompletedRuns(sessionId: string): Promise<CompletedAgentRun[]>;
}

type ApplicationRepository = SessionRepository & AgentRunRepository;

interface SessionTrajectory extends SessionHistory {
  runs: CompletedAgentRun[];
}

interface AgentExecutionOptions {
  tools?: readonly AgentTool[];
  permissionPolicy?: ToolPermissionPolicy;
  onEvent?: AgentEventHandler;
  onTextDelta?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}

type AgentRuntimeEvent =
  | { type: "model.started"; callIndex: number }
  | { type: "model.completed"; callIndex: number }
  | { type: "reasoning.delta"; callIndex: number; text: string }
  | { type: "reasoning.completed"; callIndex: number; text: string }
  | { type: "tool.requested"; callId: string; name: string; arguments: unknown }
  | { type: "tool.started"; callId: string; name: string }
  | { type: "tool.completed"; callId: string; result: string }
  | { type: "assistant.delta"; text: string };

type AgentEvent = AgentRuntimeEvent
  | { type: "turn.started"; runId: string; userMessage: UserMessage }
  | { type: "turn.completed"; runId: string; assistantMessage: AssistantMessage; reasoning?: string }
  | { type: "turn.failed"; runId: string; code: string };

type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

interface TextGenerationProvider {
  generate(request: ModelRequest, options?: {
    signal?: AbortSignal;
    onTextDelta?: (text: string) => void | Promise<void>;
    onReasoningDelta?: (text: string) => void | Promise<void>;
  }): Promise<ModelResponse>;
}

interface AgentTurnStreamHandlers {
  onStarted(runId: string, userMessage: UserMessage): void | Promise<void>;
  onTextDelta(text: string): void | Promise<void>;
  signal?: AbortSignal;
}
```

`listSessions` вычисляет заголовок по первому user message (или `Новый чат`) и `updatedAt` по последнему сообщению. `sendMessage` сохраняет пользовательское текстовое сообщение и не вызывает модель или инструменты. `executeTurn` сохраняет пользователя, загружает историю и запускает единый runtime. После успеха он вызывает `completeRun()`, который одной транзакцией сохраняет финальный assistant message и ordered trace с `runId`, `sessionId`, `userMessageId` и `assistantMessageId`. Assistant text не копируется в trace. `reasoning.completed` сохраняется по одному разу на вызов модели; стриминговые deltas не записываются. При наличии reasoning API также возвращает его агрегированную строку. `getSessionTrajectory` собирает историю сообщений и завершённые runs; старые сообщения без run допустимы. CLI по умолчанию не передаёт инструменты; `--tool demo.add` подключает его, а отдельный `--allow-tool demo.add` разрешает исполнение. Web передаёт `allowTools` только после явного выбора для текущего хода. При ошибке или отмене после записи пользователя ответ и trace не сохраняются. Порт репозитория назначает следующий `sequence` среди всех сообщений сессии; application API преобразует отсутствие сессии в `SessionNotFoundError`.

Application provider/model use cases находятся в `provider-configuration.ts`: `getProviderCatalog`, `saveProviderConfiguration`, `deleteProviderConfiguration`, `testConfiguredProviderConnection`, `discoverConfiguredProviderModels`, `saveModelConfiguration`, `deleteModelConfiguration`, `setDefaultModelConfiguration`, `setSessionModelConfiguration` и `resolveModelForRun`. Разделённые `ProviderConfigurationRepository`, `CredentialStore` и `OpenAICompatibleProviderFactory` передаются host-ом; Core не знает о них. Resolver применяет явный per-run ID, затем сохранённый session selection, затем global default. В Web выбор композера сохраняется на сессию; CLI `--model-config-id` не изменяет selection. Перед новым ходом resolver создаёт provider с фиксированными endpoint, Model ID и credential; завершённый `AgentRun` получает неизменяемый snapshot. Уже выполняемый Run не переключается при последующем редактировании конфигурации.

Provider record хранит имя, protocol, Base URL, ссылку на credential и HTTP-разрешение; model record отдельно хранит provider ID, exact Model ID, display name, source и tri-state capabilities `unknown | supported | unsupported` для streaming, tool calling и reasoning. Обнаружение через `/models` оставляет каждую capability `unknown`. Возможности считаются подтверждёнными только при достоверном источнике или явной проверке.

Необязательный `onEvent` получает события последовательно при обоих режимах provider. Runtime отправляет `model.started`, `model.completed`, reasoning deltas/completions, `tool.requested`, `tool.started`, `tool.completed` и, если задан `onTextDelta`, `assistant.delta`. `callIndex` начинается с 1. `tool.requested` описывает запрос модели до валидации и проверки разрешений; `tool.started` означает, что проверка пройдена и исполнение начинается. Lifecycle-события Application связаны с persistence: `turn.started` идёт после записи user message, `turn.completed` — после атомарного сохранения assistant message и completed run и может содержать агрегированное `reasoning`; `turn.failed` содержит безопасный код ошибки, а исходная ошибка повторно выбрасывается. Полный event journal не записывается; Application формирует trace steps из model/reasoning/tool events, игнорируя reasoning deltas для persistence.

### Local Web HTTP API

Host `src/apps/web-host` слушает только `127.0.0.1` (порт по умолчанию `3001`). В dev-режиме Vite проксирует `/api` к этому host. API не использует CORS или аутентификацию; потоковый endpoint отвечает `text/event-stream`, остальные endpoints — JSON.

Изменяющие provider/model routes проверяют loopback Host и, если заголовок задан, exact same-host loopback Origin; CORS не включён. Это local UI API, не произвольный сетевой management API. Base URL валидируется как абсолютный HTTP(S) без userinfo/query/fragment. Remote HTTP требует явного подтверждения. Проверка и discovery принимают provider ID и используют сохранённую конфигурацию; тело не может подменить endpoint или credentials. Запросы с Bearer key используют `redirect: manual`. `/models` проверяет только доступность endpoint; наличие модели не доказывает поддержку streaming, tools или reasoning. Capabilities получают `unknown`, пока достоверный источник или проверка не подтвердят состояние.

Web UI сохраняет выбранную в composer модель как selection сессии; API и CLI могут передать `modelConfigId` как override конкретного запуска. Приоритет: явный per-run ID → session selection → global default. CLI и Web используют один SQLite store и Application resolver. Provider/model разрешаются перед каждым ходом, а completed AgentRun хранит фактический snapshot; уже созданный provider активного Run не меняется.

| Метод и путь | Поведение |
| --- | --- |
| `GET /api/sessions` | Возвращает `{ ok, sessions }`; элемент содержит `id`, `createdAt`, `updatedAt`, `title` и optional `selectedModelConfigId` из Application config repository. |
| `POST /api/sessions` | Принимает `{}`; создаёт пустую сессию без закрепления global default и возвращает `{ ok, session }` с HTTP 201. |
| `GET /api/sessions/:id/history` | Возвращает `{ ok, session, messages, runs }`: Core session и сообщения по `sequence`, completed run traces в порядке user messages. Legacy assistant messages могут содержать per-call `reasoning`; новые reasoning blocks находятся в `runs[].steps`. Model selection — отдельная Application metadata в `GET /api/sessions`. |
| `POST /api/sessions/:id/messages` | Принимает `{ text, allowTools?, modelConfigId? }`, вызывает `executeTurn` и возвращает `runId`, `userMessage`, `assistantMessage` и необязательный `reasoning`. Запрос ждёт завершения provider. |
| `POST /api/sessions/:id/messages/stream` | Принимает `{ text, allowTools?, modelConfigId? }`, вызывает тот же `executeTurn` и возвращает SSE lifecycle, model, reasoning, tool и text-delta events. Браузер читает поток через `fetch()`; разрыв соединения передаёт `AbortSignal` provider. |
| `GET /api/provider-config` | Возвращает providers без credential references, models с capabilities, global default и признак поддержки credential vault текущей платформой. API keys не возвращает. |
| `POST /api/providers`, `PUT /api/providers/:id` | Принимает `{ name, baseUrl, apiKey?, clearApiKey?, allowInsecureHttp? }`; создаёт или обновляет OpenAI-compatible provider, а API key при наличии передаётся только в системный vault. Ответ содержит provider без secret/reference и `hasCredential`. |
| `DELETE /api/providers/:id` | Удаляет provider и связанные model configs/credential entry. |
| `POST /api/providers/:id/test` | Проверяет сохранённый provider по ID через `/models`; возвращает `connected` либо `discovery-unavailable`, body не задаёт endpoint или credentials. |
| `POST /api/providers/:id/models/discover` | Читает `/models` сохранённого provider и сохраняет model IDs с capabilities `unknown`; лимиты 10 секунд, 1 MiB и 500 IDs. |
| `POST /api/models`, `DELETE /api/models/:id` | `POST` принимает `{ providerId, modelId, displayName? }`, добавляет точный Model ID вручную; DELETE удаляет model config. |
| `PUT /api/settings/default-model` | Устанавливает global default model config или `null`. |
| `PATCH /api/sessions/:id/model` | Сохраняет модель сессии или `null` для использования global default. |

Формат SSE события — `event: <type>` и одна JSON-строка `data:`. В payload каждого события есть `runId`. Lifecycle-события содержат `{ userMessage }`, `{ assistantMessage, reasoning? }` или `{ error: { code, message, turnId? } }`; aggregate `reasoning` остаётся совместимым полем события, а новый `assistantMessage` не дублирует его. Остальные используют поля соответствующего `AgentRuntimeEvent`. Начальное событие отправляется после сохранения user message. Дельты текста и reasoning во время исполнения остаются временными; Application сохраняет финальный ответ и full completed trace одной транзакцией только после успешного завершения provider. `turn.completed` отправляется после успешной транзакции. Если поток прерывается или запись завершается ошибкой, Web host отправляет `turn.failed` и сохраняет user message без частичного assistant или completed run. После отправки SSE headers HTTP status уже `200`, поэтому ошибки хода передаются событием; ошибки разбора HTTP-запроса до начала потока используют JSON error contract.

`allowTools` — необязательный массив уникальных имён инструментов. Web host отклоняет неизвестные имена; пустой или отсутствующий массив оставляет Runtime без tools. Каждый выбранный инструмент передаётся с policy, которая разрешает только grant текущего запроса. Встроенный UI запрашивает grant `demo.add` отдельным checkbox и сбрасывает его после отправки.

Ошибки имеют форму `{ ok: false, error: { code, message, runId?, turnId? } }`. Неверный запрос возвращает 400, отсутствующая сессия — 404, сбой provider/runtime — 502, ошибка хранилища или неизвестная ошибка — 500. При сбое после сохранения user message host возвращает её `turnId`, чтобы UI показал ошибку на соответствующем ходе; безопасное сообщение ошибки не содержит токен или ответ сервера LM Studio.

Изменяющие запросы одного Web Host по-прежнему сериализуются в процессе. SQLite transaction защищает короткие операции записи и поддерживает несколько host/CLI процессов с одним `SMYS_DATA_DIR`; отдельный inference resource lock не реализован.

Запуск из корня репозитория в двух терминалах:

Терминал 1:

```sh
npm run web:host
```

Терминал 2:

```sh
cd src/apps/web && npm run dev
```

Для LM Studio в первом терминале задать `SMYS_PROVIDER=lm-studio` и `LM_STUDIO_MODEL=<model-id>` перед `npm run web:host`.

Fake provider используется по умолчанию как legacy fallback. Настройки из UI имеют приоритет и применяются без перезапуска host. Переменные SMYS_PROVIDER, LM_STUDIO_MODEL, LM_STUDIO_ENDPOINT и необязательный LM_API_TOKEN остаются для старого сценария. SMYS_DATA_DIR задаёт общий SQLite store Web и CLI; SMYS_WEB_PORT задаёт API port, SMYS_API_URL — Vite proxy. API keys хранятся в macOS Keychain; на других платформах операция завершается ошибкой без plaintext fallback.

В текущей реализации `Message` — объединение `UserMessage` и `AssistantMessage`; оба типа имеют ровно одну текстовую часть. Более широкий набор ролей и content parts ниже остаётся черновой моделью для будущих сценариев.

Команды CLI:

```text
session create [--initial-message <text>] [--data-dir <path>] [--json]
message send --session-id <id> --text <text> [--data-dir <path>] [--json]
history get --session-id <id> [--data-dir <path>] [--json]
agent run [--model-config-id <id>] --session-id <id> --text <text> [--tool demo.add] [--allow-tool demo.add] [--data-dir <path>] [--json] [--stream [--output ndjson]]
agent run --provider fake --session-id <id> --text <text> [--tool demo.add] [--allow-tool demo.add] [--data-dir <path>] [--json] [--stream [--output ndjson]]
agent run --provider lm-studio --model <model-id> --session-id <id> --text <text> [--endpoint <url>] [--tool demo.add] [--allow-tool demo.add] [--data-dir <path>] [--json] [--stream [--output ndjson]]
```

`session create --initial-message <text>` вызывает application use case создания сессии и затем use case сохранения сообщения. Эта форма нужна в том числе для процессной проверки: один запуск CLI создаёт сессию и сохраняет сообщение, следующий отдельный запуск читает историю.

Успешные JSON-ответы в режиме `--json`:

```json
{"ok":true,"session":{"id":"...","createdAt":"..."}}
{"ok":true,"session":{"id":"...","createdAt":"..."},"message":{"id":"...","sessionId":"...","sequence":1,"role":"user","content":[{"type":"text","text":"..."}],"createdAt":"..."}}
{"ok":true,"message":{"id":"...","sessionId":"...","sequence":1,"role":"user","content":[{"type":"text","text":"..."}],"createdAt":"..."}}
{"ok":true,"sessionId":"...","messages":[{"id":"...","sessionId":"...","sequence":1,"role":"user","content":[{"type":"text","text":"..."}],"createdAt":"..."}]}
{"ok":true,"runId":"...","userMessage":{"id":"...","sessionId":"...","sequence":1,"role":"user","content":[{"type":"text","text":"..."}],"createdAt":"..."},"assistantMessage":{"id":"...","sessionId":"...","sequence":2,"role":"assistant","content":[{"type":"text","text":"Fake response to: ..."}],"createdAt":"..."}}
```

Для provider, вернувшего reasoning, `agent run` добавляет его отдельным верхнеуровневым полем:

```json
{"ok":true,"runId":"...","userMessage":{"id":"..."},"assistantMessage":{"id":"...","role":"assistant","content":[{"type":"text","text":"..."}]},"reasoning":"..."}
```

Каждый обычный JSON-ответ занимает одну строку. При ошибке JSON-режима CLI пишет `{"ok":false,"error":{"code":"...","message":"..."}}` в stderr. Коды выхода стабильны: `0` успех, `1` внутренняя ошибка или ошибка provider, `2` неверная команда/аргументы, `3` сессия не найдена, `4` ошибка хранилища, `130` отмена по SIGINT (`ABORTED`). Сбой LM Studio использует существующий `INTERNAL_ERROR` и код `1`; сообщение не раскрывает тело ответа сервера, токен или текст запроса. `--stream` печатает текстовые дельты и завершает строку после успешного ответа; `--stream --output ndjson` печатает по одному JSON событию на строку, включая `turn.completed`. Потоковый режим несовместим с `--json`; прежний `--json` вывод не меняется.

Если provider возвращает непустой reasoning, JSON-ответ `agent run` содержит верхнеуровневое поле `reasoning`; обычный текстовый вывод печатает его перед финальным ответом, а `--stream` направляет reasoning в stderr. Per-call blocks сохраняются в completed AgentRun trace; верхнеуровневая агрегированная строка остаётся совместимым результатом текущего вызова.

`agent run` может использовать сохранённую конфигурацию: явный `--model-config-id`, затем session selection и global default. В этом режиме `--provider`, `--model` и `--endpoint` несовместимы с `--model-config-id`. Если сохранённый выбор отсутствует, legacy путь поддерживает `--provider fake|lm-studio` либо `SMYS_PROVIDER`; для `lm-studio` обязателен непустой `--model` или `LM_STUDIO_MODEL`. Для legacy LM Studio `--endpoint` — полный URL запроса, а не base URL: приоритет имеют `--endpoint`, переменная `LM_STUDIO_ENDPOINT`, затем `http://localhost:1234/v1/chat/completions`. При наличии `LM_API_TOKEN` токен передаётся в Bearer заголовке и не сохраняется в сообщениях/SQLite. Без `--tool` provider получает обычный текстовый запрос без tool definitions. `--tool demo.add` подключает безопасную функцию сложения двух чисел; `--allow-tool demo.add` отдельно разрешает исполнение. Разрешающий флаг без подключения инструмента отклоняется как ошибка аргументов. Если инструмент подключён без разрешающего флага и модель запросит его, runtime отклонит вызов.

Ручной provider smoke test выполняется командой `npm run smoke:lm-studio`; она требует `LM_STUDIO_MODEL`, использует `LM_STUDIO_ENDPOINT` или стандартный endpoint и при наличии передаёт `LM_API_TOKEN`. Команда делает один non-streaming текстовый запрос и возвращает JSON в stdout/stderr. Она не входит в `npm test` и требует запущенный локальный LM Studio server.

Каталог хранилища выбирается по приоритету: `--data-dir`, переменная окружения `SMYS_DATA_DIR`, затем `.smys-agent` в папке запуска CLI. При запуске через npm используется исходная папка вызова npm (`INIT_CWD`). Пути относительно папки запуска разрешаются от неё. Активная БД — `store.sqlite` с `user_version: 2`; она хранит sessions, messages, completed runs, ordered steps, provider/model configs и model selections. SQLite содержит только credential reference; secret хранится в macOS Keychain. На неподдерживаемых платформах сохранение credentials завершается ошибкой без plaintext fallback. Schema v1 мигрирует транзакционно в v2. Completed AgentRun хранит фактически выбранный provider/model snapshot. Сообщения имеют роль `user` или `assistant`, одну текстовую часть `content`, ISO-время и целый `sequence`, уникальный в пределах сессии. Только импортированное legacy assistant message может содержать `reasoning` массив `{ callIndex, text }`; новые reasoning блоки живут в trace.

При первой инициализации новой SQLite БД существующий валидный JSON v1/v2/v3 импортируется один раз транзакционно; исходные bytes сохраняются в `store.json.vN.sqlite.bak`. Импорт переносит sessions/messages, IDs, sequence, timestamps, legacy reasoning и дополнительные JSON поля; old runs не реконструируются, поэтому их traces пусты. При существующей SQLite БД JSON не читается повторно и не используется для записи. Неизвестная версия и повреждённый JSON отклоняются без изменения исходника. Если импорт не завершается, новая БД удаляется, а JSON остаётся источником для следующего запуска. После импорта downgrade на старый JSON-only host без экспорта теряет новые данные; SQLite БД следует сохранить для отката.

## Внутренние сущности

Черновая форма, не финальная схема БД:

```ts
type SessionId = string;
type MessageId = string;
type EventId = string;

type Message = {
  id: MessageId;
  role: "system" | "user" | "assistant" | "tool";
  content: ContentPart[];
  createdAt: string;
};

type ContentPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; callId: string; name: string; input: unknown }
  | { type: "tool-result"; callId: string; output: unknown; isError: boolean };

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ToolContext = { sessionId: SessionId; signal?: AbortSignal };
type ToolResult = { output: unknown; isError: boolean };
type ToolPermissionRequest = {
  sessionId: SessionId;
  toolName: string;
  input: unknown;
  signal?: AbortSignal;
};

type AgentEvent = {
  id: EventId;
  sessionId: SessionId;
  sequence: number;
  occurredAt: string;
  type: string;
  data: unknown;
};
```

До утверждения нужно определить допустимые части мультимодального контента, сериализацию `unknown`, поведение при несовместимой версии и набор событий. Секреты провайдера не являются частью Message или AgentEvent.

## Provider: реализованный порт

Provider принимает внутренний `ModelRequest` и возвращает `ModelResponse`. Обычный текст возвращается как `{ kind: "final", text, reasoning? }`; вызов инструмента — как `{ kind: "tool-call", callId, name, arguments, reasoning? }`. `reasoning` — необязательный внутренний текстовый фрагмент, нормализованный provider из доступного поля ответа модели. Контекст может содержать обычные user/assistant сообщения, временное сообщение assistant с tool call и временный tool result. Эти типы не зависят от wire-формата провайдера.

```ts
type ModelMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; toolCall: { callId: string; name: string; arguments: unknown } }
  | { role: "tool"; callId: string; name: string; content: string };

interface ModelRequest {
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
}

type ModelResponse =
  | { kind: "final"; text: string; reasoning?: string }
  | { kind: "tool-call"; callId: string; name: string; arguments: unknown; reasoning?: string };

interface AgentTurnResult {
  text: string;
  reasoning?: string;
}
```

Fake provider по умолчанию возвращает детерминированный текстовый ответ; тест может задать сценарий ответов. `TextGenerationProvider.generate(request, options?)` всегда возвращает нормализованный `ModelResponse`. Если передан `onTextDelta`, provider выдаёт текстовые чанки последовательно и затем возвращает итоговый ответ; tool-call fragments собираются до возврата. `signal` поддерживает отмену обоих режимов.

LM Studio отправляет всю историю через OpenAI-compatible `POST /v1/chat/completions`: без `onTextDelta` использует `stream: false`; с callback — `stream: true`. В streaming режиме adapter передаёт `delta.content`, собирает `reasoning_content` и один tool call из `delta.tool_calls`; имя, ID и JSON аргументы валидируются до передачи runtime. Ответы с несколькими вызовами инструмента, некорректными fragments, смешанным текстом и tool call, пустым текстом или незавершённым потоком отклоняются. Для следующего model call adapter сериализует временные сообщения в assistant `tool_calls` и сообщение роли `tool`. Runtime возвращает reasoning всех вызовов модели в порядке получения, разделяя части пустой строкой. Ошибки соединения, HTTP и формата превращаются в безопасную provider-ошибку; повторов и fallback нет. Capability discovery и дополнительные модельные настройки остаются вне текущего контракта.

## Ограниченный контракт инструментов и разрешений

```ts
interface AgentTool {
  definition: ToolDefinition;
  validateInput(input: unknown): boolean;
  execute(input: unknown, context: { sessionId: SessionId; signal?: AbortSignal }): Promise<string>;
}

interface ToolPermissionPolicy {
  authorize(request: ToolPermissionRequest): Promise<"allow" | "deny">;
}
```

В одном ходе можно передать максимум один инструмент. `inputSchema` описывает аргументы provider, а локальный `validateInput` проверяет их перед выполнением; общий JSON Schema engine не добавлен, поэтому реализация инструмента должна поддерживать соответствие этих двух описаний. Runtime проверяет имя и `validateInput`, затем вызывает policy и выполняет инструмент только при ответе `allow`; отсутствие policy делает конфигурацию с инструментом недействительной. CLI требует отдельные `--tool` и `--allow-tool`; Web передаёт выбранный пользователем `allowTools` список только на текущий ход, а host формирует policy исключительно по этому списку. `ask-user` в середине хода не поддерживается; Web grant даётся перед отправкой запроса. Лимит — два вызова модели и один вызов инструмента за ход; повторный tool call отклоняется до выполнения. Ошибки имени, аргументов, разрешения, инструмента и лимита завершают ход без финального ответа.

Вызовы и результаты инструментов добавляются во временный контекст provider. После успешного хода SQLite сохраняет полный reasoning и tool arguments/results как упорядоченные шаги completed run, отдельно от пользовательского и финального assistant messages. Ошибочные и отменённые runs не сохраняются. БД создаётся с правами файла `0600`; tool payload и reasoning не маскируются и не шифруются, не выводятся в логи и имеют тот же срок хранения, что и история сессии. Provider credentials не попадают в trace.

Runtime ограничивает ход двумя запросами модели и одним вызовом инструмента. Итерация — один запрос provider и один ответ; само выполнение инструмента отдельной итерацией не считается. Инструменты передаются вызывающим application code; динамической загрузки, discovery, повторов и интерактивного `ask-user` нет. Ошибки runtime типизированы (`INVALID_CONFIGURATION`, `INVALID_MODEL_RESPONSE`, `UNKNOWN_TOOL`, `INVALID_TOOL_ARGUMENTS`, `PERMISSION_DENIED`, `PERMISSION_CHECK_FAILED`, `TOOL_EXECUTION_FAILED`, `LOOP_LIMIT`); CLI показывает их через существующий `INTERNAL_ERROR` и код выхода `1`. Отмена provider или tool operation распространяет `AbortSignal`; CLI выводит `ABORTED` с кодом `130` по SIGINT.

При исключении из `AgentTool.execute()` ошибка `TOOL_EXECUTION_FAILED` сохраняет исходное значение в стандартном поле `cause`. Безопасные `code` и `message` остаются прежними; CLI не включает `cause` в текстовый или JSON-ответ.

## Черновик: будущие порты хранения и событий

Возможные будущие обязанности:

- загрузить сессию и её историю в стабильном порядке;
- сохранить пользовательское сообщение, события хода агента и финальный ответ;
- перечислить и открыть проект/сессию;
- экспортировать данные в собственном документированном формате;
- предоставить поток/подписку на изменения для обновления UI и восстановления после перезапуска.

Для активной SQLite schema v2 versioning выполняется через `PRAGMA user_version`; JSON v1/v2/v3 importer описан выше. SQLite завершение run атомарно фиксирует assistant message, trace и model snapshot, а `busy_timeout` ждёт короткие конкурирующие записи. Idempotency повторной команды, active event journal, replay и общий экспорт всех run payload остаются открытыми.

## Черновик: record/replay

Replay получает упорядоченный журнал AgentEvent, подменяет живой provider детерминированным fake provider и инструменты mock-реализациями. Для каждого шага можно сверить полученное событие и итоговое состояние. Точные правила фиксации входов/выходов, версия replay-формата, маскирование payload и совместимость между версиями остаются открытыми до ADR.
