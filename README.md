# My Harness

Локальный AI-harness для проектов, чатов, исследований и автоматизации. Цель — хранить важное в собственном формате, поддерживать разные модели через единый интерфейс и развивать понятный пользователю runtime.

## Состояние

Реализован первый сквозной сценарий через headless CLI: создание сессии, сохранение обычного текстового сообщения и чтение истории новым процессом из JSON-файлового хранилища. Сообщение сохраняется без вызова модели и инструментов.

## Документация

- [PRODUCT.md](docs/PRODUCT.md) — пользователь, потребности и границы MVP.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — модули, зависимости и потоки данных.
- [CONTRACTS.md](docs/CONTRACTS.md) — черновые границы сообщений, событий, провайдеров и инструментов.
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

`npm test` собирает TypeScript и запускает application, storage integration и CLI process-тесты.

## CLI

Каждая команда поддерживает `--json`. По умолчанию хранилище создаётся в `.smys-agent/` внутри папки, из которой запущен CLI. Каталог можно переопределить через `SMYS_DATA_DIR` или `--data-dir`; явный `--data-dir` имеет приоритет. При запуске через npm учитывается папка, из которой вызван npm.

```sh
# Создать сессию и сохранить первое сообщение.
npm run --silent cli -- session create --json --initial-message "Привет"

# Добавить сообщение в существующую сессию.
npm run --silent cli -- message send --json --session-id <SESSION_ID> --text "Ещё одно сообщение"

# Прочитать историю.
npm run --silent cli -- history get --json --session-id <SESSION_ID>
```

Успешный JSON имеет поле `ok: true`; ошибки в JSON-режиме выводятся в stderr с `ok: false`. Коды выхода: `0` — успех, `1` — внутренняя ошибка, `2` — неверная команда или аргументы, `3` — сессия не найдена, `4` — ошибка хранилища.

### Проверка сохранения между процессами

Команды запускаются отдельными процессами. Первый создаёт сессию и записывает сообщение; второй читает ту же историю из того же каталога:

```sh
set CREATED_JSON (npm run --silent cli -- session create --json --initial-message 'Сохрани это сообщение')
printf '%s\n' "$CREATED_JSON"
set SESSION_ID (printf '%s' "$CREATED_JSON" | node -e 'let data=""; process.stdin.on("data", chunk => data += chunk).on("end", () => process.stdout.write(JSON.parse(data).session.id))')
npm run --silent cli -- history get --json --session-id "$SESSION_ID"
```

Это команды для fish. Данные этой проверки сохраняются в `.smys-agent/store.json` в корне проекта.

## Предлагаемая структура

```text
apps/
  cli/src/      # ранний headless-вход: сессии, сообщения, история
  web/
  # worker/ для расписаний добавится позже, по необходимости
packages/
  application/  # внутренние use cases и порт хранилища
  core/         # внутренние типы сессии и сообщения
  providers/
  tools/
  storage/      # JSON-файловый адаптер текущего среза
  knowledge/
plugins/
  youtube/
tests/
  fixtures/
docs/
```

Подробности и границы модулей — в [архитектуре](docs/ARCHITECTURE.md). Структура является проектным предложением, а не утверждением о выбранных технологиях.
