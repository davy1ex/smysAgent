# My Harness

Заявленная цель — локальный AI-harness для проектов, чатов, исследований и автоматизации. Это пока продуктовая гипотеза; текущая реализация и открытые границы MVP описаны в [PRODUCT.md](docs/PRODUCT.md).

## Состояние

Реализован headless CLI-срез: создание сессии, сохранение сообщения без вызова модели, один текстовый ход через явно выбранный fake или LM Studio provider и чтение истории из JSON-файлового хранилища новым процессом. Это не полноценный agent loop: инструменты, UI, проекты, worker и knowledge-функции пока не реализованы.

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
```

`agent run` требует явный `--provider fake` или `--provider lm-studio`; `--model` обязателен для LM Studio. Fake не обращается к сети. LM Studio выполняет один обычный запрос без streaming и инструментов. Настройка endpoint и токена, формы JSON и коды завершения описаны в [CONTRACTS.md](docs/CONTRACTS.md).

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
