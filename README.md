# My Harness

Заявленная цель — локальный AI-harness для проектов, чатов, исследований и автоматизации. Это пока продуктовая гипотеза; текущая реализация и открытые границы MVP описаны в [PRODUCT.md](docs/PRODUCT.md).

## Состояние

Реализован headless CLI-срез: создание сессии, сохранение сообщения без вызова модели, текстовый ход через явно выбранный fake или LM Studio provider и чтение истории из JSON-файлового хранилища новым процессом. Application API и core также поддерживают ограниченный agent loop с одним переданным инструментом, проверкой разрешений и максимум двумя вызовами модели. CLI по умолчанию работает без инструментов; безопасный `demo.add` подключается и разрешается отдельными флагами. Для оценки интерфейса есть статический React-макет с проектами, демо-сессиями, вкладками «Чат» и «Траектория» и компактным потоком действий. Он не подключён к Application API или backend; маркировка `DEMO` остаётся видимой.

## Документация

- [PRODUCT.md](docs/PRODUCT.md) — пользователь, потребности и границы MVP.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — модули, зависимости и потоки данных.
- [CONTRACTS.md](docs/CONTRACTS.md) — реализованные API, CLI и формат хранения; далее — черновые контракты будущих возможностей.
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

`npm test` собирает TypeScript и запускает тесты application, storage, providers и CLI-процессов.

### Статический web-макет

Web-приложение — отдельный пакет с собственными зависимостями. Установите их и запустите локальный макет:

```sh
npm install --prefix src/apps/web
npm run --prefix src/apps/web dev
```

Проверка типов и production-сборка:

```sh
npm run --prefix src/apps/web typecheck
npm run --prefix src/apps/web build
```

Фикстуры проектов, сессий, reasoning и состояний инструментов принадлежат только UI и не являются контрактами Core или Application. Вкладка «Чат» показывает компактные строки действий, а «Траектория» — раскрываемые подробности шагов. Модель указана рядом с нижней областью ввода; отправка сообщений отключена. Статусы относятся к отдельным вызовам инструментов, а не к сессии.

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

Это команды для fish. Данные этой проверки сохраняются в `.smys-agent/store.json` в корне проекта.
