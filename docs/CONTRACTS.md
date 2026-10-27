# Contracts

**Статус:** будущие концептуальные границы остаются черновыми. Реализованные Application API, CLI и файловый формат описаны ниже; принятые изменения этого среза зафиксированы в ADR-0002.

## Принципы

- Внутренние сообщения и события не повторяют формат конкретного API модели.
- Сохранённые данные имеют версионируемый собственный формат.
- Для каждого события важен стабильный порядок в пределах сессии.
- Вызов инструмента — запрос, который проходит проверку разрешений до выполнения.
- Внутренние ошибки нормализованы; адаптер может сохранять безопасную диагностическую причину, не протекая в core типами SDK.

## Application API

Application API — внутренний интерфейс use cases, через который разные hosts просят приложение выполнить операцию. Первый реализованный срез и его точные сигнатуры приведены ниже. `createProject` и `replaySession` добавляются по мере реализации этих сценариев.

CLI и web host вызывают одни и те же use cases. Тесты могут вызывать их напрямую с подменёнными портами. Если web UI будет отделён от application layer процессом, HTTP adapter преобразует HTTP-запросы в application commands; HTTP-формат не становится внутренним форматом core или хранилища.

CLI — ранний headless-вход для ручного запуска, скриптов, Codex и диагностики. Контракт покрывает создание сессии, отправку сообщения без модели, один ход через явно выбранный fake provider и чтение истории. Скриптовый режим поддерживает JSON в stdout и стабильные коды завершения; формы приведены ниже. Unit/integration тесты запускаются package scripts и могут вызывать application API напрямую.

CLI не реализует agent loop самостоятельно и не предоставляет команду для обхода permission policy или прямого исполнения инструмента. Scheduler/worker — будущий вход для периодических запусков и heartbeats; его правила расписания, повторы и восстановление должны быть описаны отдельным контрактом до реализации.

Для будущих сценариев остаются открытыми форма streaming-событий, протокол HTTP (если понадобится), размещение web/backend по процессам и расширение сохранённой схемы.

### Реализованный application API и CLI-срез

Текущий внутренний API предоставляет следующие use cases:

```ts
createSession(repository: SessionRepository): Promise<Session>
sendMessage(repository: SessionRepository, input: { sessionId: string; text: string }): Promise<UserMessage>
runAgentTurn(repository: SessionRepository, provider: TextGenerationProvider, input: { sessionId: string; text: string }): Promise<{ userMessage: UserMessage; assistantMessage: AssistantMessage }>
getHistory(repository: SessionRepository, sessionId: string): Promise<SessionHistory>

interface SessionRepository {
  createSession(session: Session): Promise<void>;
  appendUserMessage(sessionId: string, draft: { id: string; createdAt: string; text: string }): Promise<UserMessage | null>;
  appendAssistantMessage(sessionId: string, draft: { id: string; createdAt: string; text: string }): Promise<AssistantMessage | null>;
  getHistory(sessionId: string): Promise<SessionHistory | null>;
}

interface TextGenerationProvider {
  generate(messages: readonly Message[]): Promise<string>;
}
```

`sendMessage` сохраняет пользовательское текстовое сообщение и не вызывает модель или инструменты. `runAgentTurn` сохраняет пользователя, загружает историю, делает один вызов provider и сохраняет текстовый ответ ассистента. Если provider завершается ошибкой, пользовательское сообщение остаётся в истории без ответа. В этом срезе инструменты не передаются. Порт репозитория назначает следующий `sequence` среди всех сообщений сессии; application API преобразует отсутствие сессии в `SessionNotFoundError`.

В текущей реализации `Message` — объединение `UserMessage` и `AssistantMessage`; оба типа имеют ровно одну текстовую часть. Более широкий набор ролей и content parts ниже остаётся черновой моделью для будущих сценариев.

Команды CLI:

```text
session create [--initial-message <text>] [--data-dir <path>] [--json]
message send --session-id <id> --text <text> [--data-dir <path>] [--json]
history get --session-id <id> [--data-dir <path>] [--json]
agent run --provider fake --session-id <id> --text <text> [--data-dir <path>] [--json]
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

Каждый ответ занимает одну строку. При ошибке JSON-режима CLI пишет `{"ok":false,"error":{"code":"...","message":"..."}}` в stderr. Коды выхода стабильны: `0` успех, `1` внутренняя ошибка, `2` неверная команда/аргументы, `3` сессия не найдена, `4` ошибка хранилища. Без `--json` используются краткие текстовые сообщения.

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
  inputSchema: unknown;
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

## Порт провайдера модели

Исполняемый срез использует `TextGenerationProvider.generate(messages)` для одного синхронного текстового ответа. `agent run` требует `--provider fake`; адаптер возвращает детерминированный ответ вида `Fake response to: <последнее сообщение пользователя>`. Это не включает живую модель, сеть, ключи или инструменты. Более широкий интерфейс ниже остаётся концептуальным и не реализован этим срезом.

```ts
interface ModelProvider {
  generate(input: ModelRequest, options?: { signal?: AbortSignal }): Promise<ModelResponse>;
}

type ModelRequest = {
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
};

type ModelResponse = {
  message?: Message;
  finishReason: "stop" | "tool-calls" | "length" | "error";
  usage?: { inputTokens?: number; outputTokens?: number };
};
```

Адаптер отвечает за преобразование запроса, вызов конкретного API, разбор ответа и нормализацию ошибок. Streaming, capability discovery, модельные настройки, лимиты и строгая обработка некорректных tool call нуждаются в уточнении перед фиксацией публичного интерфейса.

## Порт инструментов и разрешений

```ts
interface Tool {
  definition: ToolDefinition;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

interface PermissionPolicy {
  authorize(request: ToolPermissionRequest): Promise<"allow" | "deny" | "ask-user">;
}
```

Executor проверяет разрешение до передачи управления `execute`. Отказ, запрос подтверждения и результат инструмента становятся наблюдаемыми событиями. Runtime не исполняет tool call напрямую и не должен обходить permission policy.

## Порты хранения и событий

Начальные обязанности портов:

- загрузить сессию и её историю в стабильном порядке;
- сохранить пользовательское сообщение, события хода агента и финальный ответ;
- перечислить и открыть проект/сессию;
- экспортировать данные в собственном документированном формате;
- предоставить поток/подписку на изменения для обновления UI и восстановления после перезапуска.

Для JSON-файлового адаптера v1 определены атомарная замена файла и порядок сообщений. Конкурентная запись, идемпотентность повторной команды, миграции и экспорт остаются открытыми для будущих адаптеров и расширений.

## Record/replay

Replay получает упорядоченный журнал AgentEvent, подменяет живой provider детерминированным fake provider и инструменты mock-реализациями. Для каждого шага можно сверить полученное событие и итоговое состояние. Точные правила фиксации входов/выходов, версия replay-формата, маскирование payload и совместимость между версиями остаются открытыми до ADR.
