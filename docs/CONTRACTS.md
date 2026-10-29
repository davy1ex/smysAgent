# Contracts

**Статус:** разделы Application API и CLI фиксируют реализованный внутренний контракт и формат JSON-хранилища. Ограниченный agent loop и tool-calling provider зафиксированы в ADR-0004. События и record/replay остаются черновиками будущих сценариев.

## Принципы проектирования

Это ориентиры для внутренних контрактов. Событийный журнал остаётся будущим сценарием; ограниченное выполнение инструмента реализовано и проходит проверку разрешений.

- Внутренние сообщения и события не повторяют формат конкретного API модели.
- Сохранённые данные имеют версионируемый собственный формат.
- Для каждого события важен стабильный порядок в пределах сессии.
- Вызов инструмента — запрос, который проходит проверку разрешений до выполнения.
- Внутренние ошибки нормализованы; адаптер может сохранять безопасную диагностическую причину, не протекая в core типами SDK.

## Реализованный Application API и CLI

Application API — внутренний интерфейс use cases, через который host просит приложение выполнить операцию. Реализованные use cases и их сигнатуры приведены ниже. `createProject` и `replaySession` не реализованы.

Сейчас эти use cases вызывает CLI; тесты могут вызывать их напрямую с подменёнными портами. Будущий web host должен использовать те же use cases. Если он окажется в отдельном процессе, HTTP adapter может преобразовать запросы в application commands; такого adapter сейчас нет.

CLI — ранний headless-вход для ручного запуска, скриптов, Codex и диагностики. Контракт покрывает создание сессии, отправку сообщения без модели, ход через явно выбранный fake или LM Studio provider и чтение истории. По умолчанию CLI не передаёт инструменты; для smoke-сценария можно явно подключить встроенный `demo.add` и отдельно разрешить его исполнение. Скриптовый режим поддерживает JSON в stdout и стабильные коды завершения; формы приведены ниже. Unit/integration тесты запускаются package scripts и могут вызывать application API напрямую.

CLI не содержит собственной реализации agent loop. Он передаёт подключённый инструмент и permission policy в application use case; runtime проверяет вызов и permission до исполнения. Scheduler/worker не реализован; правила расписания, повторы и восстановление потребуют отдельного контракта до появления такого входа.

Открытыми остаются форма streaming-событий, протокол HTTP (если понадобится), размещение web/backend по процессам и расширение сохранённой схемы.

### Сигнатуры реализованных use cases

Текущий внутренний API предоставляет следующие use cases:

```ts
createSession(repository: SessionRepository): Promise<Session>
sendMessage(repository: SessionRepository, input: { sessionId: string; text: string }): Promise<UserMessage>
runAgentTurn(repository: SessionRepository, provider: TextGenerationProvider, input: { sessionId: string; text: string }, options?: AgentExecutionOptions): Promise<{ userMessage: UserMessage; assistantMessage: AssistantMessage; reasoning?: string }>
getHistory(repository: SessionRepository, sessionId: string): Promise<SessionHistory>

interface SessionRepository {
  createSession(session: Session): Promise<void>;
  appendUserMessage(sessionId: string, draft: { id: string; createdAt: string; text: string }): Promise<UserMessage | null>;
  appendAssistantMessage(sessionId: string, draft: { id: string; createdAt: string; text: string }): Promise<AssistantMessage | null>;
  getHistory(sessionId: string): Promise<SessionHistory | null>;
}

interface AgentExecutionOptions {
  tools?: readonly AgentTool[];
  permissionPolicy?: ToolPermissionPolicy;
}

interface TextGenerationProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
```

`sendMessage` сохраняет пользовательское текстовое сообщение и не вызывает модель или инструменты. `runAgentTurn` сохраняет пользователя, загружает историю, запускает ограниченный runtime и сохраняет финальный текст ассистента. При наличии reasoning application API возвращает его отдельным необязательным полем; CLI показывает его вместе с финальным ответом, но store и история сессии содержат только финальный текст. Если reasoning вернулось в нескольких вызовах модели, runtime объединяет части через пустую строку. CLI по умолчанию не передаёт инструменты; при явном `--tool demo.add` передаёт один tool и policy, которая разрешает его только при `--allow-tool demo.add`. Другие application callers также могут передать максимум один инструмент и явную permission policy. При ошибке provider, инструмента или разрешения пользовательское сообщение остаётся в истории без ответа. Порт репозитория назначает следующий `sequence` среди всех сообщений сессии; application API преобразует отсутствие сессии в `SessionNotFoundError`.

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
{"ok":true,"userMessage":{"id":"...","sessionId":"...","sequence":1,"role":"user","content":[{"type":"text","text":"..."}],"createdAt":"..."},"assistantMessage":{"id":"...","sessionId":"...","sequence":2,"role":"assistant","content":[{"type":"text","text":"Fake response to: ..."}],"createdAt":"..."}}
```

Для provider, вернувшего reasoning, `agent run` добавляет его отдельным верхнеуровневым полем:

```json
{"ok":true,"userMessage":{"id":"..."},"assistantMessage":{"id":"...","role":"assistant","content":[{"type":"text","text":"..."}]},"reasoning":"..."}
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

Fake provider по умолчанию возвращает детерминированный текстовый ответ; тест может задать сценарий ответов. LM Studio отправляет всю историю через OpenAI-compatible `POST /v1/chat/completions` с `stream: false` и читает reasoning из `reasoning_content`. Если переданы инструменты, adapter добавляет один `tools` элемент и `tool_choice: "auto"`; ответ должен содержать ровно один корректный вызов функции. Для следующего запроса adapter сериализует временные сообщения в assistant `tool_calls` и сообщение роли `tool`. Runtime возвращает reasoning всех вызовов модели за ход в порядке получения, разделяя части пустой строкой. Ошибки соединения, HTTP, формата ответа и пустого текста превращаются в безопасную provider-ошибку; повторов и fallback нет. Streaming, capability discovery и дополнительные модельные настройки остаются вне текущего контракта.

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
