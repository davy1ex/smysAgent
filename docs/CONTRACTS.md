# Contracts

**Статус:** разделы Application API и CLI фиксируют реализованный внутренний контракт и формат JSON-хранилища. Концептуальные сущности, расширенный provider, tools, события и record/replay ниже — черновики будущих сценариев, не реализованные или публичные API. Provider-срез зафиксирован в ADR-0002 и ADR-0003.

## Принципы проектирования

Это ориентиры для внутренних контрактов. Принципы про события и инструменты относятся к будущим черновым сценариям и не означают, что такие механизмы уже реализованы.

- Внутренние сообщения и события не повторяют формат конкретного API модели.
- Сохранённые данные имеют версионируемый собственный формат.
- Для каждого события важен стабильный порядок в пределах сессии.
- Вызов инструмента — запрос, который проходит проверку разрешений до выполнения.
- Внутренние ошибки нормализованы; адаптер может сохранять безопасную диагностическую причину, не протекая в core типами SDK.

## Реализованный Application API и CLI

Application API — внутренний интерфейс use cases, через который host просит приложение выполнить операцию. Реализованные use cases и их сигнатуры приведены ниже. `createProject` и `replaySession` не реализованы.

Сейчас эти use cases вызывает CLI; тесты могут вызывать их напрямую с подменёнными портами. Будущий web host должен использовать те же use cases. Если он окажется в отдельном процессе, HTTP adapter может преобразовать запросы в application commands; такого adapter сейчас нет.

CLI — ранний headless-вход для ручного запуска, скриптов, Codex и диагностики. Контракт покрывает создание сессии, отправку сообщения без модели, один ход через явно выбранный fake или LM Studio provider и чтение истории. Скриптовый режим поддерживает JSON в stdout и стабильные коды завершения; формы приведены ниже. Unit/integration тесты запускаются package scripts и могут вызывать application API напрямую.

CLI не реализует agent loop и не исполняет инструменты. Scheduler/worker не реализован; правила расписания, повторы и восстановление потребуют отдельного контракта до появления такого входа.

Открытыми остаются форма streaming-событий, протокол HTTP (если понадобится), размещение web/backend по процессам и расширение сохранённой схемы.

### Сигнатуры реализованных use cases

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
agent run --provider lm-studio --model <model-id> --session-id <id> --text <text> [--endpoint <url>] [--data-dir <path>] [--json]
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

Каждый ответ занимает одну строку. При ошибке JSON-режима CLI пишет `{"ok":false,"error":{"code":"...","message":"..."}}` в stderr. Коды выхода стабильны: `0` успех, `1` внутренняя ошибка или ошибка provider, `2` неверная команда/аргументы, `3` сессия не найдена, `4` ошибка хранилища. Сбой LM Studio использует существующий `INTERNAL_ERROR` и код `1`; сообщение не раскрывает тело ответа сервера, токен или текст запроса. Без `--json` используются краткие текстовые сообщения.

`agent run` требует явный `--provider`. Для `fake` параметры `--model` и `--endpoint` запрещены. Для `lm-studio` обязателен непустой `--model`; он должен соответствовать идентификатору модели LM Studio. `--endpoint` — полный URL запроса, а не base URL: приоритет имеют `--endpoint`, переменная `LM_STUDIO_ENDPOINT`, затем `http://localhost:1234/v1/chat/completions`. Если сервер требует авторизацию, необязательная переменная `LM_API_TOKEN` передаётся в заголовке Bearer. Токен не сохраняется в сообщениях или хранилище и не выводится в ошибках.

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

## Provider: реализованный порт и черновик расширения

Текущий порт — `TextGenerationProvider.generate(messages): Promise<string>` для одного синхронного текстового ответа. Fake provider возвращает детерминированный ответ и не обращается к сети. LM Studio отправляет всю упорядоченную текстовую историю через OpenAI-compatible `POST /v1/chat/completions` с `stream: false`, без инструментов. Ошибки соединения, HTTP, формата ответа и пустого текста превращаются в безопасную provider-ошибку; повторов и fallback нет. Конкретные параметры CLI и обработка ошибок описаны выше.

Расширенная форма ниже — концептуальный вариант; она не является текущим типом или утверждённым публичным интерфейсом.

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

## Черновик: инструменты и разрешения

Этот порт не реализован. Если agent loop будет исполнять инструмент, разрешение должно проверяться до побочного эффекта.

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
