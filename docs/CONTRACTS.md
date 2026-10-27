# Contracts

**Статус:** черновые концептуальные границы. Типы ниже помогают обсуждать модули; перед реализацией публичного контракта их нужно уточнить и утвердить. Изменение утверждённого контракта проходит через владельца проекта и ADR.

## Принципы

- Внутренние сообщения и события не повторяют формат конкретного API модели.
- Сохранённые данные имеют версионируемый собственный формат.
- Для каждого события важен стабильный порядок в пределах сессии.
- Вызов инструмента — запрос, который проходит проверку разрешений до выполнения.
- Внутренние ошибки нормализованы; адаптер может сохранять безопасную диагностическую причину, не протекая в core типами SDK.

## Application API

Application API — внутренний интерфейс use cases, через который разные hosts просят приложение выполнить операцию. Начальные операции: `createSession`, `sendMessage`, `getHistory`; `createProject` и `replaySession` добавляются по мере реализации этих сценариев. Имена приведены для обсуждения; точные входные и выходные типы фиксируются при проектировании первой реализации.

CLI и web host вызывают одни и те же use cases. Тесты могут вызывать их напрямую с подменёнными портами. Если web UI будет отделён от application layer процессом, HTTP adapter преобразует HTTP-запросы в application commands; HTTP-формат не становится внутренним форматом core или хранилища.

CLI — ранний headless-вход для ручного запуска, скриптов, Codex и диагностики. Первый CLI-контракт покрывает создание сессии, отправку сообщения и чтение истории. Скриптовый режим предусматривает JSON в stdout и стабильные коды завершения; точная форма JSON-объектов фиксируется вместе с командами. Unit/integration тесты запускаются package scripts и могут вызывать application API напрямую.

CLI не реализует agent loop самостоятельно и не предоставляет команду для обхода permission policy или прямого исполнения инструмента. Scheduler/worker — будущий вход для периодических запусков и heartbeats; его правила расписания, повторы и восстановление должны быть описаны отдельным контрактом до реализации.

Неопределёнными остаются точные подписи методов, форма доставки streaming-событий, протокол HTTP (если понадобится), размещение web/backend по процессам и точные JSON-схемы команд CLI.

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

Операционная семантика (атомарность, повторная отправка, идемпотентные ключи, миграции и формат экспорта) должна быть определена до контракта storage adapter и схемы БД.

## Record/replay

Replay получает упорядоченный журнал AgentEvent, подменяет живой provider детерминированным fake provider и инструменты mock-реализациями. Для каждого шага можно сверить полученное событие и итоговое состояние. Точные правила фиксации входов/выходов, версия replay-формата, маскирование payload и совместимость между версиями остаются открытыми до ADR.
