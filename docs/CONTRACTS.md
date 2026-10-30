# Contracts

**Статус:** разделы Application API, local Web HTTP API и CLI фиксируют реализованные контракты и формат JSON-хранилища. Ограниченный agent loop и tool-calling provider зафиксированы в ADR-0004; end-to-end text streaming — в ADR-0010; внутренний контракт событий Runtime/Application — в ADR-0011. HTTP-передача событий, record/replay и сохранённая trajectory остаются будущими сценариями.

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

CLI — ранний headless-вход для ручного запуска, скриптов, Codex и диагностики. Контракт покрывает создание сессии, отправку сообщения без модели, ход через явно выбранный fake или LM Studio provider и чтение истории. По умолчанию CLI не передаёт инструменты; для smoke-сценария можно явно подключить встроенный `demo.add` и отдельно разрешить его исполнение. Скриптовый режим поддерживает JSON в stdout и стабильные коды завершения; формы приведены ниже. Unit/integration тесты запускаются package scripts и могут вызывать application API напрямую.

CLI не содержит собственной реализации agent loop. Он передаёт подключённый инструмент и permission policy в application use case; runtime проверяет вызов и permission до исполнения. Scheduler/worker не реализован; правила расписания, повторы и восстановление потребуют отдельного контракта до появления такого входа.

Runtime/Application callback для событий хода реализован, но HTTP-передача agent events, сохранённая trajectory, projects и расширение схемы хранения остаются будущими задачами. Потоковый текст Web описан в отдельном HTTP-контракте ниже; он использует существующий SSE-контракт.

### Сигнатуры реализованных use cases

Текущий внутренний API предоставляет следующие use cases:

```ts
createSession(repository: SessionRepository): Promise<Session>
listSessions(repository: SessionRepository): Promise<SessionSummary[]>
sendMessage(repository: SessionRepository, input: { sessionId: string; text: string }): Promise<UserMessage>
runAgentTurn(repository: SessionRepository, provider: TextGenerationProvider, input: { sessionId: string; text: string; runId?: string }, options?: AgentExecutionOptions): Promise<{ runId: string; userMessage: UserMessage; assistantMessage: AssistantMessage; reasoning?: string }>
runAgentTurnStreaming(repository: SessionRepository, provider: TextGenerationProvider & StreamingTextGenerationProvider, input: { sessionId: string; text: string; runId?: string }, handlers: AgentTurnStreamHandlers, options?: AgentExecutionOptions): Promise<{ runId: string; userMessage: UserMessage; assistantMessage: AssistantMessage }>
getHistory(repository: SessionRepository, sessionId: string): Promise<SessionHistory>

interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
}

interface SessionRepository {
  createSession(session: Session): Promise<void>;
  listSessionHistories(): Promise<SessionHistory[]>;
  appendUserMessage(sessionId: string, draft: { id: string; createdAt: string; text: string }): Promise<UserMessage | null>;
  appendAssistantMessage(sessionId: string, draft: { id: string; createdAt: string; text: string }): Promise<AssistantMessage | null>;
  getHistory(sessionId: string): Promise<SessionHistory | null>;
}

interface AgentExecutionOptions {
  tools?: readonly AgentTool[];
  permissionPolicy?: ToolPermissionPolicy;
  onEvent?: AgentEventHandler;
}

type AgentRuntimeEvent =
  | { type: "model.started"; callIndex: number }
  | { type: "model.completed"; callIndex: number }
  | { type: "reasoning.completed"; callIndex: number; text: string }
  | { type: "tool.requested"; callId: string; name: string; arguments: unknown }
  | { type: "tool.started"; callId: string; name: string }
  | { type: "tool.completed"; callId: string; result: string }
  | { type: "assistant.delta"; text: string };

type AgentEvent = AgentRuntimeEvent
  | { type: "turn.started"; runId: string; userMessage: UserMessage }
  | { type: "turn.completed"; runId: string; assistantMessage: AssistantMessage }
  | { type: "turn.failed"; runId: string; code: string };

type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

interface TextGenerationProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}

interface StreamingTextGenerationProvider {
  streamText(request: ModelRequest, options?: { signal?: AbortSignal }): AsyncIterable<string>;
}

interface AgentTurnStreamHandlers {
  onStarted(runId: string, userMessage: UserMessage): void | Promise<void>;
  onTextDelta(text: string): void | Promise<void>;
  signal?: AbortSignal;
}
```

`listSessions` вычисляет заголовок по первому user message (или `Новый чат`) и `updatedAt` по последнему сообщению; в JSON store эти поля не добавляются. `sendMessage` сохраняет пользовательское текстовое сообщение и не вызывает модель или инструменты. `runAgentTurn` сохраняет пользователя, загружает историю, запускает ограниченный runtime и сохраняет финальный текст ассистента. Вызов получает или генерирует `runId`; это идентификатор хода без сохранённого execution trace. При наличии reasoning application API возвращает его отдельным необязательным полем; CLI показывает его вместе с финальным ответом, но store и история сессии содержат только финальный текст. Если reasoning вернулось в нескольких вызовах модели, runtime объединяет части через пустую строку. CLI по умолчанию не передаёт инструменты; при явном `--tool demo.add` передаёт один tool и policy, которая разрешает его только при `--allow-tool demo.add`. Другие application callers также могут передать максимум один инструмент и явную permission policy. При ошибке provider, инструмента или разрешения пользовательское сообщение остаётся в истории без ответа. Порт репозитория назначает следующий `sequence` среди всех сообщений сессии; application API преобразует отсутствие сессии в `SessionNotFoundError`.

Необязательный `onEvent` получает события последовательно. Runtime отправляет `model.started`, `model.completed`, непустые `reasoning.completed`, `tool.requested`, `tool.started` и `tool.completed`; потоковый Runtime также отправляет `assistant.delta`. `callIndex` начинается с 1. `tool.requested` описывает запрос модели до валидации и проверки разрешений; `tool.started` означает, что проверка пройдена и исполнение начинается. Lifecycle-события Application связаны с сохранением: `turn.started` идёт после записи user message, `turn.completed` — после записи assistant message, `turn.failed` содержит безопасный код ошибки, а исходная ошибка повторно выбрасывается. Callback не сохраняет события и не меняет HTTP-контракт Web.

### Local Web HTTP API

Host `src/apps/web-host` слушает только `127.0.0.1` (порт по умолчанию `3001`). В dev-режиме Vite проксирует `/api` к этому host. API не использует CORS или аутентификацию; потоковый endpoint отвечает `text/event-stream`, остальные endpoints — JSON.

| Метод и путь | Поведение |
| --- | --- |
| `GET /api/sessions` | Возвращает `{ ok, sessions }`; элемент содержит `id`, `createdAt`, `updatedAt`, `title`. |
| `POST /api/sessions` | Принимает `{}`; создаёт пустую сессию и возвращает `{ ok, session }` с HTTP 201. |
| `GET /api/sessions/:id/history` | Возвращает `{ ok, session, messages }` по `sequence`. |
| `POST /api/sessions/:id/messages` | Принимает `{ text }`, вызывает `runAgentTurn`, возвращает `runId`, `userMessage` и `assistantMessage`. Запрос ждёт завершения provider; streaming отсутствует. |
| `POST /api/sessions/:id/messages/stream` | Принимает `{ text }`, вызывает `runAgentTurnStreaming` и возвращает SSE события `turn.started`, `assistant.delta`, `turn.completed` или `turn.failed`. Браузер читает поток через `fetch()`; разрыв соединения передаёт `AbortSignal` provider. Поддерживаются только ходы без tools. |

Формат SSE события — `event: <type>` и одна JSON-строка `data:`. `turn.started` содержит `{ runId, userMessage }`; `assistant.delta` — `{ runId, text }`; `turn.completed` — `{ runId, assistantMessage }`; `turn.failed` — `{ runId, error: { code, message, turnId? } }`. Начальное событие отправляется после сохранения user message. Текстовые чанки временные и не записываются отдельно; Application сохраняет объединённый ответ один раз только после корректного завершения provider. `turn.completed` отправляется после успешной записи assistant message. Если поток прерывается или запись завершается ошибкой, Web host отправляет `turn.failed` и сохраняет user message без частичного assistant. После отправки SSE headers HTTP status уже `200`, поэтому ошибки хода передаются событием; ошибки разбора HTTP-запроса до начала потока используют JSON error contract.

Ошибки имеют форму `{ ok: false, error: { code, message, runId?, turnId? } }`. Неверный запрос возвращает 400, отсутствующая сессия — 404, сбой provider/runtime — 502, ошибка хранилища или неизвестная ошибка — 500. При сбое после сохранения user message host возвращает её `turnId`, чтобы UI показал ошибку на соответствующем ходе; безопасное сообщение ошибки не содержит токен или ответ сервера LM Studio.

Изменяющие API-запросы выполняются последовательно в процессе host. Запускать CLI или второй host с тем же `SMYS_DATA_DIR` для параллельной записи нельзя: JSON adapter не синхронизирует процессы.

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

Fake provider используется по умолчанию. Для LM Studio задать `SMYS_PROVIDER=lm-studio` и `LM_STUDIO_MODEL`; endpoint берётся из `LM_STUDIO_ENDPOINT` или `http://localhost:1234/v1/chat/completions`, токен — из необязательного `LM_API_TOKEN`. `SMYS_DATA_DIR` задаёт каталог JSON store, `SMYS_WEB_PORT` — порт API, `SMYS_API_URL` — target Vite proxy.

В текущей реализации `Message` — объединение `UserMessage` и `AssistantMessage`; оба типа имеют ровно одну текстовую часть. Более широкий набор ролей и content parts ниже остаётся черновой моделью для будущих сценариев.

Команды CLI:

```text
session create [--initial-message <text>] [--data-dir <path>] [--json]
message send --session-id <id> --text <text> [--data-dir <path>] [--json]
history get --session-id <id> [--data-dir <path>] [--json]
agent run --provider fake --session-id <id> --text <text> [--tool demo.add] [--allow-tool demo.add] [--data-dir <path>] [--json]
agent run --provider lm-studio --model <model-id> --session-id <id> --text <text> [--endpoint <url>] [--tool demo.add] [--allow-tool demo.add] [--data-dir <path>] [--json]
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

Каждый ответ занимает одну строку. При ошибке JSON-режима CLI пишет `{"ok":false,"error":{"code":"...","message":"..."}}` в stderr. Коды выхода стабильны: `0` успех, `1` внутренняя ошибка или ошибка provider, `2` неверная команда/аргументы, `3` сессия не найдена, `4` ошибка хранилища. Сбой LM Studio использует существующий `INTERNAL_ERROR` и код `1`; сообщение не раскрывает тело ответа сервера, токен или текст запроса. Без `--json` используются краткие текстовые сообщения.

Если provider возвращает непустой reasoning, JSON-ответ `agent run` содержит верхнеуровневое поле `reasoning`; текстовый вывод печатает его под заголовком `Reasoning:` перед финальным ответом. Это поле относится к текущему выполнению и не добавляется в сохранённый `assistantMessage` или историю.

`agent run` требует явный `--provider`. Для `fake` параметры `--model` и `--endpoint` запрещены. Для `lm-studio` обязателен непустой `--model`; он должен соответствовать идентификатору модели LM Studio. `--endpoint` — полный URL запроса, а не base URL: приоритет имеют `--endpoint`, переменная `LM_STUDIO_ENDPOINT`, затем `http://localhost:1234/v1/chat/completions`. Если сервер требует авторизацию, необязательная переменная `LM_API_TOKEN` передаётся в заголовке Bearer. Токен не сохраняется в сообщениях или хранилище и не выводится в ошибках. Без `--tool` provider получает обычный текстовый запрос без tool definitions. `--tool demo.add` подключает безопасную функцию сложения двух чисел; `--allow-tool demo.add` отдельно разрешает исполнение. Разрешающий флаг без подключения инструмента отклоняется как ошибка аргументов. Если инструмент подключён без разрешающего флага и модель запросит его, runtime отклонит вызов.

Ручной provider smoke test выполняется командой `npm run smoke:lm-studio`; она требует `LM_STUDIO_MODEL`, использует `LM_STUDIO_ENDPOINT` или стандартный endpoint и при наличии передаёт `LM_API_TOKEN`. Команда делает один non-streaming текстовый запрос и возвращает JSON в stdout/stderr. Она не входит в `npm test` и требует запущенный локальный LM Studio server.

Каталог хранилища выбирается по приоритету: `--data-dir`, переменная окружения `SMYS_DATA_DIR`, затем `.smys-agent` в папке запуска CLI. При запуске через npm используется исходная папка вызова npm (`INIT_CWD`). Пути относительно папки запуска разрешаются от неё. Текущий `store.json` содержит `formatVersion: 2`, массивы `sessions` и `messages`; сообщения имеют роль `user` или `assistant`, одну текстовую часть `content`, ISO-время и целый `sequence`, уникальный в пределах сессии. История читается по возрастанию `sequence`. Запись выполняется через временный файл с последующим rename.

Формат v1 принимается для чтения без записи на диск. При первой мутации валидный v1 переносится в v2; исходные bytes сохраняются в `store.json.v1.bak`. Существующий backup допускается только при точном совпадении с исходным файлом. Неизвестная версия и повреждённый документ отклоняются без изменения файла. После миграции старые версии приложения, которые понимают только v1, не могут читать основной файл; для возврата доступна сохранённая копия v1. Одновременные записи нескольких процессов и идемпотентность повторной команды этим срезом не гарантируются.

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

Fake provider по умолчанию возвращает детерминированный текстовый ответ; тест может задать сценарий ответов. `generate()` в LM Studio отправляет всю историю через OpenAI-compatible `POST /v1/chat/completions` с `stream: false` и читает reasoning из `reasoning_content`. Для Web text streaming `streamText()` отправляет `stream: true`, разбирает OpenAI-compatible SSE data и выдаёт только `delta.content`; reasoning не отображается как текст, а tool calls в этом режиме отклоняются. Если для обычного `generate()` переданы инструменты, adapter добавляет один `tools` элемент и `tool_choice: "auto"`; ответ должен содержать ровно один корректный вызов функции. Для следующего запроса adapter сериализует временные сообщения в assistant `tool_calls` и сообщение роли `tool`. Runtime возвращает reasoning всех вызовов модели за обычный ход в порядке получения, разделяя части пустой строкой. Ошибки соединения, HTTP, формата ответа, незавершённого потока и пустого текста превращаются в безопасную provider-ошибку; повторов и fallback нет. Capability discovery и дополнительные модельные настройки остаются вне текущего контракта.

## Ограниченный контракт инструментов и разрешений

```ts
interface AgentTool {
  definition: ToolDefinition;
  validateInput(input: unknown): boolean;
  execute(input: unknown, context: { sessionId: SessionId }): Promise<string>;
}

interface ToolPermissionPolicy {
  authorize(request: ToolPermissionRequest): Promise<"allow" | "deny">;
}
```

В одном ходе можно передать максимум один инструмент. `inputSchema` описывает аргументы provider, а локальный `validateInput` проверяет их перед выполнением; общий JSON Schema engine не добавлен, поэтому реализация инструмента должна поддерживать соответствие этих двух описаний. Runtime проверяет имя и `validateInput`, затем вызывает policy и выполняет инструмент только при ответе `allow`; отсутствие policy делает конфигурацию с инструментом недействительной. `ask-user` не поддерживается, поскольку application API пока не имеет host для подтверждения. Лимит — два вызова модели и один вызов инструмента за ход; повторный tool call отклоняется до выполнения. Ошибки имени, аргументов, разрешения, инструмента и лимита завершают ход без финального ответа.

Вызовы и результаты инструментов добавляются только во временный контекст provider. Формат store v2 не изменён: сохраняются пользовательское сообщение и финальный текст ассистента. При ошибке после записи пользователя ответ ассистента не добавляется.

Runtime ограничивает ход двумя запросами модели и одним вызовом инструмента. Итерация — один запрос provider и один ответ; само выполнение инструмента отдельной итерацией не считается. Инструменты передаются вызывающим application code; динамической загрузки, discovery, повторов и обработки `ask-user` нет. Ошибки runtime типизированы (`INVALID_CONFIGURATION`, `INVALID_MODEL_RESPONSE`, `UNKNOWN_TOOL`, `INVALID_TOOL_ARGUMENTS`, `PERMISSION_DENIED`, `PERMISSION_CHECK_FAILED`, `TOOL_EXECUTION_FAILED`, `LOOP_LIMIT`); CLI показывает их через существующий `INTERNAL_ERROR` и код выхода `1`.

При исключении из `AgentTool.execute()` ошибка `TOOL_EXECUTION_FAILED` сохраняет исходное значение в стандартном поле `cause`. Безопасные `code` и `message` остаются прежними; CLI не включает `cause` в текстовый или JSON-ответ.

## Черновик: будущие порты хранения и событий

Возможные будущие обязанности:

- загрузить сессию и её историю в стабильном порядке;
- сохранить пользовательское сообщение, события хода агента и финальный ответ;
- перечислить и открыть проект/сессию;
- экспортировать данные в собственном документированном формате;
- предоставить поток/подписку на изменения для обновления UI и восстановления после перезапуска.

Для текущего JSON-хранилища v2 определены атомарная замена файла, порядок сообщений и миграция конкретного формата v1 → v2 выше. Общая стратегия будущих миграций, конкурентная запись, идемпотентность повторной команды, события и экспорт остаются открытыми.

## Черновик: record/replay

Replay получает упорядоченный журнал AgentEvent, подменяет живой provider детерминированным fake provider и инструменты mock-реализациями. Для каждого шага можно сверить полученное событие и итоговое состояние. Точные правила фиксации входов/выходов, версия replay-формата, маскирование payload и совместимость между версиями остаются открытыми до ADR.
