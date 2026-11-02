# SMYS — ROADMAP

> Шесть направлений утверждены владельцем как стратегия развития. Статус направления не доказывает наличие кода; реализацию сверять по исходникам и тестам. Технический выбор фиксируется отдельно в принятом ADR.

## Статусы

- `Accepted` — владелец утвердил направление или техническое решение.
- `Implemented` — соответствующее поведение найдено в коде; указываются evidence и ограничения проверки.
- `Planned` — направление принято, но реализация ещё не подтверждена.
- `Proposed` — вариант или техническое решение ожидает утверждения владельца.
- `Unverified` — утверждение пока не сверено с кодом/проверками.
- `Validated` — критерии и применимые пользовательские сценарии проверены; один лишь зелёный typecheck или тестовый suite этого статуса не даёт.

## Шесть направлений

| Этап | Утверждённое направление | Статус реализации на 2026-11-02 |
| --- | --- | --- |
| **M1. Unified Agent Execution** | Один Core algorithm и Application lifecycle для CLI/Web; tools, permissions, streaming, reasoning/events и cancellation в общей модели исполнения. | `Accepted` · `Implemented`. ADR-0012—0015 приняты; Core/Application/CLI/Web host используют общий путь, live reasoning ранее подтверждён на LM Studio. `npm test`: 67 root + 3 Web tests прошли; typecheck/lint/Web build прошли. См. [spec 001](./specs/001-unified-agent-execution.md) и [spec 002](./specs/002-live-inference-ui.md). |
| **M2. Persistent Runs + SQLite** | Сохранённые runs, статусы, события/tool calls и восстановление траектории; безопасная координация записей. Это название направления из Planning Kit, не выбор БД. | `Accepted` · `Planned`. JSON v3 сохраняет completed per-call reasoning в assistant messages; durable active run state, event replay и межпроцессная координация не реализованы. SQLite — `Proposed` как технический выбор: ADR-README указывает, что он не утверждён. |
| **M3. Agent Profiles + System Prompts + Skills** | Управляемые профили, system prompts, разрешённые инструменты и статическая загрузка skills. | `Accepted` · `Planned`; реализации в текущем кодовом дереве не найдено. |
| **M4. Web Search + Fetch** | Проверяемые инструменты поиска и чтения внешних источников. | `Accepted` · `Planned`; реализации в текущем кодовом дереве не найдено. |
| **M5. Research Workflow** | Многоэтапное исследование с проверкой источников, evidence, бюджетами и условиями остановки. | `Accepted` · `Planned`; реализации в текущем кодовом дереве не найдено. |
| **M6. Desktop App + Extension API** | Desktop-клиент и выведенный из практики API расширений. | `Accepted` · `Planned`; Desktop host и extension API в текущем кодовом дереве не найдены. |

## Live-inference UX

Требования владельца собраны в [`specs/002-live-inference-ui.md`](./specs/002-live-inference-ui.md). Текстовый streaming, per-call progressive reasoning (`reasoning.delta`), безопасный Markdown и backend persistence completed reasoning реализованы; live streaming проверен на LM Studio/Fake Provider. Восстановление active run и координация inference остаются отдельными задачами.

## Сквозные ограничения

1. Все клиенты используют общий Application/Core путь; UI не реализует agent loop.
2. UI отображает реальные события и состояния backend, а не придуманные runtime events или reasoning.
3. Проверка permissions выполняется на стороне исполнения, не только в UI.
4. Новые технические контракты сначала оформляются в ADR и утверждаются владельцем.
5. Если roadmap/spec расходится с принятым ADR, работу остановить и запросить решение владельца; более новый документ сам по себе не supersede ADR.

## Порядок продвижения

Для ближайшего среза: утверждённые требования → сверка с действующими ADR → если нужен новый контракт, ADR с решением владельца → один небольшой вертикальный срез → тесты и применимый ручной сценарий → обновление [`NOW.md`](./NOW.md) с evidence. Идеи без утверждения остаются в [`IDEAS.md`](./IDEAS.md).
