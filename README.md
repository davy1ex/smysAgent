# My Harness

Заявленная цель — локальный AI-harness для проектов, чатов, исследований и автоматизации. Это пока продуктовая гипотеза; текущая реализация и открытые границы MVP описаны в [PRODUCT.md](docs/PRODUCT.md).

## Состояние

Реализованы CLI и локальный React Web-клиент поверх одного Application API. Web host предоставляет список сессий, историю, создание сессии и выполнение хода через Fake или LM Studio; Web показывает текст по мере генерации и позволяет остановить запрос. Web SSE передаёт runtime/lifecycle events. SQLite-хранилище сохраняет сообщения и completed AgentRun traces; Web восстанавливает reasoning и tool steps после повторного открытия сессии. Активный run и его события после reload не восстанавливаются; projects пока не реализованы. CLI по умолчанию работает без инструментов; безопасный `demo.add` подключается и разрешается отдельными флагами.

## Документация

- [NOW.md](docs/NOW.md) — подтверждённое состояние и текущий фокус.
- [CHANGELOG.md](docs/CHANGELOG.md) — заметные изменения проекта.
- [ROADMAP.md](docs/ROADMAP.md) — утверждённые направления и фактический прогресс.
- [IDEAS.md](docs/IDEAS.md) — идеи без обязательства реализации.
- [PRODUCT.md](docs/PRODUCT.md) — пользователь, потребности и границы MVP.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — модули, зависимости и потоки данных.
- [CONTRACTS.md](docs/CONTRACTS.md) — реализованные API, CLI и формат хранения; далее — черновые контракты будущих возможностей.
- [specs/](docs/specs/) — требования ближайших работ; технические контракты задают принятые ADR.
- [DECISIONS/](docs/DECISIONS/README.md) — журнал технических решений и порядок утверждения ADR.
- [AGENTS.md](AGENTS.md) — обязательный протокол работы AI над кодом.

## Установка и проверки

Требуется Node.js 20 или новее и npm.

```sh
npm install
npm run typecheck
npm run lint
npm run build
npm test
```

`npm test` собирает TypeScript и запускает тесты application, storage, providers, CLI-процессов и Web HTTP API.

### Локальный Web

Web-приложение — отдельный Vite-пакет. Установите его зависимости. Затем запустите API и Vite в двух терминалах:

```sh
npm install --prefix src/apps/web
npm run web:host
```

Во втором терминале:

```sh
npm run --prefix src/apps/web dev
```

Откройте адрес, напечатанный Vite. Fake provider используется по умолчанию. Для LM Studio запустите host с `SMYS_PROVIDER=lm-studio` и `LM_STUDIO_MODEL=<MODEL_ID>`. `SMYS_DATA_DIR` меняет каталог JSON-хранилища; пока Web host работает, CLI не должен параллельно записывать в тот же каталог.

Проверка типов и production-сборка:

```sh
npm run --prefix src/apps/web typecheck
npm run --prefix src/apps/web build
```

Сессии показаны в группе «Без проекта». Вкладки «Чат» и «История» отображают сохранённые сообщения; во время генерации текст появляется постепенно, а ошибку или отмену UI привязывает к пользовательскому сообщению. Для изменения порта API можно задать `SMYS_WEB_PORT`, для Vite proxy — `SMYS_API_URL`.

## CLI

Каждая команда поддерживает `--json`. По умолчанию хранилище создаётся в `.smys-agent/` внутри папки запуска. Его можно переопределить через `SMYS_DATA_DIR` или `--data-dir`. Подробные приоритеты, JSON-формы, коды ошибок и формат файла зафиксированы в [контракте CLI и хранения](docs/CONTRACTS.md).

```sh
# Создать сессию и сохранить первое сообщение.
npm run --silent cli -- session create --json --initial-message "Привет"

# Добавить сообщение в существующую сессию.
npm run --silent cli -- message send --json --session-id <SESSION_ID> --text "Ещё одно сообщение"

# Прочитать историю.
npm run --silent cli -- history get --json --session-id <SESSION_ID>

# Выполнить один детерминированный ход через fake provider.
npm run --silent cli -- agent run --json --provider fake --session-id <SESSION_ID> --text "Ответь на это сообщение"

# Выполнить один текстовый запрос через LM Studio.
npm run --silent cli -- agent run --json --provider lm-studio --model <MODEL_ID> --session-id <SESSION_ID> --text "Ответь на это сообщение"

# Явно подключить demo.add и разрешить её исполнение через fake provider.
npm run --silent cli -- agent run --json --provider fake --session-id <SESSION_ID> --text "smoke demo.add" --tool demo.add --allow-tool demo.add

# Попросить LM Studio вызвать demo.add с разрешёнными аргументами.
npm run --silent cli -- agent run --json --provider lm-studio --model <MODEL_ID> --session-id <SESSION_ID> --text "Use demo.add with a=2 and b=3, then report the result." --tool demo.add --allow-tool demo.add
```

`agent run` требует явный `--provider fake` или `--provider lm-studio`; `--model` обязателен для LM Studio. Fake не обращается к сети. Без `--tool` CLI не передаёт инструменты. `--tool demo.add` подключает единственный встроенный инструмент, а `--allow-tool demo.add` отдельно разрешает его исполнение. Fake smoke детерминированно вызывает `demo.add(2, 3)`. Настройка endpoint и токена, формы JSON и коды завершения описаны в [CONTRACTS.md](docs/CONTRACTS.md).

Инструмент доступен в CLI только при явной передаче обоих флагов `--tool demo.add` и `--allow-tool demo.add`.

### Ручная проверка LM Studio

Загрузите модель в LM Studio и включите Local Server. В fish задайте её точный ID и запустите проверку:

```fish
set -x LM_STUDIO_MODEL liquid/lfm2.5-1.2b
npm run smoke:lm-studio
```

Endpoint по умолчанию — `http://localhost:1234/v1/chat/completions`; его можно переопределить через `LM_STUDIO_ENDPOINT`. Этот smoke test обращается к живому локальному серверу и не входит в `npm test`.

### Проверка сохранения между процессами

Команды запускаются отдельными процессами. Первый создаёт сессию и записывает сообщение, следующий выполняет ход, а последний читает историю из того же каталога:

```sh
set CREATED_JSON (npm run --silent cli -- session create --json --initial-message 'Сохрани это сообщение')
printf '%s\n' "$CREATED_JSON"
set SESSION_ID (printf '%s' "$CREATED_JSON" | node -e 'let data=""; process.stdin.on("data", chunk => data += chunk).on("end", () => process.stdout.write(JSON.parse(data).session.id))')
npm run --silent cli -- agent run --json --provider fake --session-id "$SESSION_ID" --text 'Проверь сохранение ответа'
npm run --silent cli -- history get --json --session-id "$SESSION_ID"
```

Это команды для fish. Данные этой проверки сохраняются в `.smys-agent/store.sqlite` в корне проекта.
