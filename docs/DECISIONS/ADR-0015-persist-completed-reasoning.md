# ADR-0015: Сохранение reasoning завершённых ходов

- Статус: Accepted
- Дата: 2026-11-02
- Утвердил: владелец проекта в чате

## Контекст

`reasoning.delta` и `reasoning.completed` отображаются во время inference, но история JSON store сохраняет только текст user/assistant messages. После reload Web получает финальные ответы без trajectory, поэтому reasoning завершённых ходов пропадает. Владелец утвердил backend-owned сохранение completed reasoning и отклонил `sessionStorage`.

До этого изменения store format v2 хранил сообщения в JSON. Active run lifecycle, восстановление inference, event replay, SQLite и resource locks в этот срез не входят.

## Варианты

1. Хранить reasoning в `sessionStorage` — отклонено: данные выполнения должны принадлежать backend и быть частью истории, а не вкладки.
2. Добавить отдельную таблицу/коллекцию trajectory — избыточно для сохранения завершённых reasoning блоков при текущем JSON store.
3. Добавить необязательные per-call reasoning записи к сохранённому assistant message и обновить JSON store до v3 — выбрано: ответ и относящиеся к нему блоки восстанавливаются одним существующим history запросом.

## Решение

- Assistant message получает необязательное поле `reasoning`, массив `{ callIndex, text }` в порядке вызовов модели. Поле отсутствует, если модель не вернула reasoning.
- Application собирает canonical `reasoning.completed` события существующего Core loop и сохраняет их вместе с финальным assistant message. Потоковые SSE события и `assistant.delta` не меняются.
- Существующий `GET /api/sessions/:id/history` возвращает это поле как часть assistant message. React строит завершённые reasoning блоки из истории; полный текст остаётся свёрнутым по умолчанию и доступен при раскрытии.
- JSON store v3 принимает assistant messages с optional per-call reasoning. Чтение v1/v2 остаётся без записи; первая последующая запись мигрирует v1 или v2 в v3 и сохраняет исходный файл в versioned backup.
- Сохраняются только reasoning завершённого успешного хода. Partial reasoning отменённых/ошибочных ходов, активный run, draft, runtime events и tool I/O не становятся durable.
- Не добавлять browser storage, endpoint, новый agent loop или run lifecycle.

## Последствия

- Reasoning завершённых ходов переживает reload на этом backend/store; старые сообщения без reasoning остаются совместимыми.
- Assistant message/history contract и JSON storage format меняются аддитивно; JSON store получает миграцию v3.
- Reasoning от провайдера сохраняется на диске вместе с ответом. Политика удаления и срок хранения совпадают с текущими сообщениями.
- Reload во время активного inference по-прежнему не восстанавливает ход и не replay-ит события; эта задача остаётся отдельным решением Persistent Runs / Trajectory.
- Откат к версии без поддержки v3 store требует ручного восстановления соответствующего versioned backup; старые клиенты могут игнорировать новое поле в history response.
