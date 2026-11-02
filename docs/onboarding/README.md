# Onboarding: приложение и архитектура

Карта текущего приложения: как запустить Web UI, как проходит запрос и где менять поведение. Описана реализованная система, а не целевая модель.

## Быстрый запуск Web UI

Установите зависимости отдельного Web-пакета и запустите API host:

```sh
npm install --prefix src/apps/web
npm run web:host
```

Во втором терминале запустите Vite:

```sh
npm run --prefix src/apps/web dev
```

Откройте адрес, который напечатает Vite. Fake provider используется по умолчанию. Чтобы подключить LM Studio, Ollama или другой OpenAI-compatible endpoint, в composer откройте **«Настроить провайдеры и модели»**, укажите имя и Base URL, проверьте соединение, затем найдите модель через `/models` или добавьте точный Model ID вручную. Выберите модель в composer или задайте её как global default. Изменение применяется к следующему ходу без перезапуска host; каталог providers/models и выбор сессии сохраняются в SQLite и доступны после reload.

`SMYS_DATA_DIR` задаёт общий каталог SQLite-конфигурации и истории для Web Host и CLI. Для старого сценария остаются `SMYS_PROVIDER`, `LM_STUDIO_MODEL`, `LM_STUDIO_ENDPOINT` и `LM_API_TOKEN`; они служат fallback, если сохранённая модель не выбрана. API keys хранятся в macOS Keychain; на других платформах доступны endpoints без ключа. Удалённый HTTP endpoint требует явного согласия.

Vite проксирует `/api` в `http://127.0.0.1:3001`. Адрес API можно переопределить через `SMYS_API_URL`, порт host — через `SMYS_WEB_PORT`. Host слушает только loopback-интерфейс. SQLite-транзакции защищают короткие операции записи между несколькими host/CLI процессами с одним каталогом данных; inference resource lock не реализован.

## Точки входа

| Host | Точка входа | Роль |
| --- | --- | --- |
| Web UI | `src/apps/web/src/main.tsx` | Монтирует React `App` в DOM-элемент `#root`. |
| Web HTTP host | `src/apps/web-host/main.ts` | Создаёт общий SQLite repository, OpenAI-compatible provider factory и credential vault, запускает локальный HTTP API. |
| CLI | `src/apps/cli/main.ts` | Разбирает CLI-команды, использует тот же SQLite config/resolver и напрямую вызывает Application use cases. |

Браузерный UI не импортирует Application или Core. Его выходная граница — HTTP API. Vite proxy соединяет браузер с отдельным Node host; host вызывает Application use cases.

## UI-компоненты и состояние

`App` владеет списком и выбором сессии, загруженной историей, состоянием отправки, временным ходом, ошибками и отметками об отмене. Компоненты получают состояние и callbacks через props.

```mermaid
flowchart TD
  Root["index.html · #root"] --> Main["web/src/main.tsx"]
  Main --> App["App · состояние и обработчики"]

  App --> Sidebar["Sidebar"]
  Sidebar --> Projects["ProjectSection · список сессий"]
  Sidebar --> NewChat["Создать чат"]

  App --> Panel["Панель чата"]
  Panel --> Header["Topbar и вкладки"]
  Panel --> Chat["ChatTimeline"]
  Panel --> Trajectory["Trajectory · сохранённая история"]
  Chat --> Message["MessageItem"]
  Trajectory --> Message
  Panel --> Composer["Composer · ввод, отправка, остановка"]
  App --> ProviderSettings["ProviderSettings · providers, models, defaults"]

  NewChat --> Handlers["Обработчики App"]
  Projects --> Handlers
  Composer --> Handlers
  ProviderSettings --> Handlers
  Handlers --> API["api.ts"]
  API --> HTTP["/api · Vite proxy → web-host"]
  HTTP --> API
  API --> State["Обновление состояния App"]
  State --> Sidebar
  State --> Panel
```

При загрузке `App` запрашивает список сессий и provider/model catalog, выбирает первую сессию, затем загружает её messages и completed runs через history API. Выбор модели для сессии приходит в Application session summary; он не добавлен в Core `Session`. Composer сохраняет session selection, а настройки открывают `ProviderSettings` для CRUD провайдеров, test/discovery и ручного Model ID. Создание чата и HTTP-вызовы идут через `api.ts`. Во время генерации текст и reasoning отображаются из временного состояния; после успеха UI обновляет history, и run snapshot показывает фактическую модель. При reload persisted trace загружается по ID assistant message, selection и provider catalog — из SQLite API.

## Поток сообщения через HTTP, Application и Core

```mermaid
sequenceDiagram
  participant UI as React UI
  participant Adapter as api.ts
  participant Host as web-host
  participant App as Application
  participant Repo as ApplicationRepository
  participant Config as Provider/model config + vault
  participant Core as Core Agent Runtime
  participant Model as Provider

  UI->>Adapter: отправить текст
  Adapter->>Host: POST /api/sessions/:id/messages/stream
  Host->>Host: проверить запрос, создать runId и AbortController
  Host->>App: resolveModelForRun(per-run → session → global)
  App->>Config: load provider/model config and credential
  Config-->>App: pinned endpoint, Model ID, credential
  App-->>Host: provider instance + run snapshot
  Host->>App: executeTurn(provider, snapshot, event callback)
  App->>Repo: сохранить user message
  App-->>Host: onStarted
  Host-->>Adapter: SSE turn.started
  App->>Repo: загрузить историю
  App->>Core: runAgentTurn(history, provider, tools, policy)
  loop Model / reasoning / tool events
    Core->>Model: generation request
    Model-->>Core: text / reasoning / tool-call events
    Core-->>App: AgentEvent
    App-->>Host: event callback
    Host-->>Adapter: SSE runtime event
    Adapter-->>UI: обновить временные шаги и preview
  end
  Core-->>App: финальный текст и собранный trace
  App->>Repo: completeRun(assistant message + trace)
  Repo->>Repo: SQLite transaction: message + run + ordered steps
  App-->>Host: завершённый ход
  Host-->>Adapter: SSE turn.completed
  Adapter-->>UI: завершить временное представление
  opt Открытие сессии после reload
    UI->>Adapter: GET /api/sessions/:id/history
    Adapter->>Host: history request
    Host->>App: getSessionTrajectory(sessionId)
    App->>Repo: getHistory() + listCompletedRuns()
    Repo-->>App: messages + ordered runs
    App-->>Host: SessionTrajectory
    Host-->>Adapter: JSON session, messages, runs
    Adapter-->>UI: восстановить шаги по assistantMessageId
  end
```

При ошибке хода host передаёт `turn.failed`. При остановке UI вызывает `AbortController.abort()`; разрыв запроса доходит до host, Application, Core и provider. Частичный текст/reasoning остаётся временным состоянием UI и в хранилище не записывается. Если генерация завершается ошибкой после сохранения user message, в истории остаётся это сообщение без ответа ассистента и completed trace.

## Ответственность слоёв

| Слой | Ответственность | Основные файлы |
| --- | --- | --- |
| Web UI | Отображение сессий и сообщений, выбор session model, управление providers/models, локальное состояние текущего хода | `src/apps/web/src/{main.tsx,App.tsx,ProviderSettings.tsx,api.ts,styles.css}` |
| Web host | HTTP/SSE transport, legacy env/data-dir config, same-host checks, сериализация изменяющих запросов | `src/apps/web-host/{main.ts,server.ts}` |
| CLI host | CLI-команды, конфигурация и скриптовый вывод | `src/apps/cli/` |
| Application | Use cases сессий и ходов, provider/model config, resolver per-run/session/global; связывает Core с repository/provider/credential ports | `src/packages/application/` |
| Core | Типы сообщений и provider-agnostic agent runtime, проверки tool calls и разрешений | `src/packages/core/` |
| Providers | Fake, общий OpenAI-compatible Chat Completions adapter и LM Studio compatibility wrapper; macOS Keychain adapter | `src/packages/providers/` |
| Storage | SQLite schema v2 с providers/models/selections и run snapshots, JSON import и формат сохранённых сессий/runs | `src/packages/storage/` |

```mermaid
flowchart LR
  Browser["React Web UI"] -->|HTTP / SSE| Proxy["Vite proxy"]
  Proxy --> Host["Web HTTP host"]
  Host -->|use cases| App["Application API"]
  CLI["CLI host"] -->|те же use cases напрямую| App
  App -->|запуск хода| Core["Core Agent Runtime"]
  App -->|сессии, сообщения, runs и конфигурация моделей| Repo["SQLite repository"]
  Core -->|TextGenerationProvider port| Provider["Модельный adapter"]
  Fake["Fake Provider"] -. "implements" .-> Provider
  OpenAI["Shared OpenAI-compatible adapter"] -. "implements" .-> Provider
  LMWrapper["LM Studio compatibility wrapper"] -. "implements" .-> Provider
  App -->|credential reference| Vault["macOS Keychain"]
  Repo --> Storage["SQLite schema v2"]
```

## Текущее поведение и ограничения

- Web host предоставляет `GET /api/sessions`, `POST /api/sessions`, `GET /api/sessions/:id/history`, `POST /api/sessions/:id/messages` и потоковый `POST /api/sessions/:id/messages/stream`.
- Provider/model management routes позволяют сохранить endpoint, протестировать его, открыть `/models`, добавить manual ID и выбрать session/global model. Они принимают только loopback Host/same-host Origin, CORS не включён; test/discovery используют provider ID из сохранённой конфигурации.
- `/models` показывает доступные IDs, но не доказывает поддержку reasoning, tools или streaming. Такие capabilities начинаются с `unknown`. Один Application resolver создаёт зафиксированный provider для каждого нового Run; completed snapshot остаётся в истории после редактирования catalog.
- SQLite schema v1 мигрирует транзакционно в v2. API key записывается в macOS Keychain; SQLite хранит только ссылку, Web API — только признак наличия. На других платформах plaintext fallback нет.
- Web UI использует streaming route для текста и reasoning deltas. После успешного завершения SQLite сохраняет отдельно assistant message и ordered AgentRun trace с model calls, полным reasoning и выполненными tool calls; вкладки «Чат» и «История» восстанавливают шаги из history API.
- Web host может подключить `demo.add`; UI передаёт его только при явном разрешении для текущего хода. CLI также требует отдельные флаги подключения и разрешения инструмента.
- Streaming ход сохраняет user message до генерации, а assistant message вместе с completed trace — одной транзакцией после успешного ответа. Отмена или ошибка не сохраняют частичный ответ или completed trace; active inference и event replay не восстанавливаются после reload.
- UI группирует сессии под «Без проекта». Проекты и отдельный Desktop UI не реализованы. Старые сессии без traces продолжают открываться; legacy assistant reasoning остаётся доступен.
- Web host сериализует изменяющие запросы в одном процессе. SQLite-транзакции защищают короткие записи нескольких host/CLI процессов с одним каталогом данных; inference resource lock не реализован.

## Куда идти за изменением

- Разметка, интерактивное состояние или responsive UI — `src/apps/web/src/App.tsx` и `styles.css`.
- HTTP-вызовы и обработка SSE в браузере — `src/apps/web/src/api.ts`.
- HTTP-маршруты, SSE-события и отмена запроса — `src/apps/web-host/server.ts`.
- Конфигурация host, provider и repository — `src/apps/web-host/main.ts`.
- Use cases provider/model catalog, discovery, credential resolution и выбора для нового хода — `src/packages/application/provider-configuration.ts`.
- Порядок действий при отправке сообщения и сохранении хода — `src/packages/application/use-cases.ts`.
- Агентный цикл, лимиты и исполнение tool calls — `src/packages/core/agent/runtime.ts`.
- Общий OpenAI-compatible inference/discovery contract и совместимость LM Studio — `src/packages/providers/lm-studio-provider.ts`; credential vault — `src/packages/providers/macos-credential-store.ts`.
- Чтение и запись сессий, provider/model configs и run snapshots — `src/packages/storage/sqlite-application-repository.ts` и `src/packages/application/ports.ts`.

Подробные границы модулей и контракты описаны в [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) и [`docs/CONTRACTS.md`](../CONTRACTS.md). Команды разработки и полный локальный запуск приведены в [`README.md`](../../README.md).
