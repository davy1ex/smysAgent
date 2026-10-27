# Contracts

**Статус:** будущие концептуальные границы остаются черновыми. Application API и CLI v1 ниже реализованы и согласованы для первого сценария; последующие изменения утверждённых контрактов проходят через владельца проекта и ADR.

## Принципы

- Внутренние сообщения и события не повторяют формат конкретного API модели.
- Сохранённые данные имеют версионируемый собственный формат.
- Для каждого события важен стабильный порядок в пределах сессии.
- Вызов инструмента — запрос, который проходит проверку разрешений до выполнения.
- Внутренние ошибки нормализованы; адаптер может сохранять безопасную диагностическую причину, не протекая в core типами SDK.

## Application API

Application API — внутренний интерфейс use cases, через который разные hosts просят приложение выполнить операцию. Первый реализованный срез и его точные сигнатуры приведены ниже. `createProject` и `replaySession` добавляются по мере реализации этих сценариев.

CLI и web host вызывают одни и те же use cases. Тесты могут вызывать их напрямую с подменёнными портами. Если web UI будет отделён от application layer процессом, HTTP adapter преобразует HTTP-запросы в application commands; HTTP-формат не становится внутренним форматом core или хранилища.

CLI — ранний headless-вход для ручного запуска, скриптов, Codex и диагностики. Первый CLI-контракт покрывает создание сессии, отправку сообщения и чтение истории. Скриптовый режим поддерживает JSON в stdout и стабильные коды завершения; формы v1 зафиксированы ниже. Unit/integration тесты запускаются package scripts и могут вызывать application API напрямую.

CLI не реализует agent loop самостоятельно и не предоставляет команду для обхода permission policy или прямого исполнения инструмента. Scheduler/worker — будущий вход для периодических запусков и heartbeats; его правила расписания, повторы и восстановление должны быть описаны отдельным контрактом до реализации.

Для будущих сценариев остаются открытыми форма streaming-событий, протокол HTTP (если понадобится), размещение web/backend по процессам и расширение сохранённой схемы.

### Реализованный application API и CLI-срез v1

Текущий внутренний API предоставляет следующие use cases:

```ts
createSession(repository: SessionRepository): Promise<Session>
sendMessage(repository: SessionRepository, input: { sessionId: string; text: string }): Promise<UserMessage>
getHistory(repository: SessionRepository, sessionId: string): Promise<SessionHistory>

interface SessionRepository {
  createSession(session: Session): Promise<void>;
  appendUserMessage(sessionId: string, draft: { id: string; createdAt: string; text: string }): Promise<UserMessage | null>;
  getHistory(sessionId: string): Promise<SessionHistory | null>;
}
```

`sendMessage` сохраняет пользовательское текстовое сообщение и не вызывает модель или инструменты. Порт репозитория назначает следующее порядковое значение `sequence`; application API преобразует отсутствие сессии в `SessionNotFoundError`.

Команды CLI:

```text
session create [--initial-message <text>] [--data-dir <path>] [--json]
message send --session-id <id> --text <text> [--data-dir <path>] [--json]
history get --session-id <id> [--data-dir <path>] [--json]
```

`session create --initial-message <text>` вызывает application use case создания сессии и затем use case сохранения сообщения. Эта форма нужна в том числе для процессной проверки: один запуск CLI создаёт сессию и сохраняет сообщение, следующий отдельный запуск читает историю.

Успешные JSON-ответы в режиме `--json`:

```json
{"ok":true,"session":{"id":"...","createdAt":"..."}}
{"ok":true,"session":{"id":"...","createdAt":"..."},"message":{"id":"...","sessionId":"...","sequence":1,"role":"user","content":[{"type":"text","text":"..."}],"createdAt":"..."}}
{"ok":true,"message":{"id":"...","sessionId":"...","sequence":1,"role":"user","content":[{"type":"text","text":"..."}],"createdAt":"..."}}
{"ok":true,"sessionId":"...","messages":[{"id":"...","sessionId":"...","sequence":1,"role":"user","content":[{"type":"text","text":"..."}],"createdAt":"..."}]}
```

Каждый ответ занимает одну строку. При ошибке JSON-режима CLI пишет `{"ok":false,"error":{"code":"...","message":"..."}}` в stderr. Коды выхода стабильны: `0` успех, `1` внутренняя ошибка, `2` неверная команда/аргументы, `3` сессия не найдена, `4` ошибка хранилища. Без `--json` используются краткие текстовые сообщения.

Каталог хранилища выбирается по приоритету: `--data-dir`, переменная окружения `SMYS_DATA_DIR`, затем `.smys-agent` в папке запуска CLI. При запуске через npm используется исходная папка вызова npm (`INIT_CWD`). Пути относительно папки запуска разрешаются от неё. Файл `store.json` содержит `formatVersion: 1`, массивы `sessions` и `messages`. Сообщение v1 имеет роль `user`, одну текстовую часть `content`, ISO-время и целый `sequence`, начинающийся с 1 в каждой сессии. История читается по возрастанию `sequence`. Запись выполняется через временный файл с последующим rename. Одновременные записи нескольких процессов и идемпотентность повторной команды этим срезом не гарантируются.

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
