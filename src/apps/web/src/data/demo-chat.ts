export type RunStatus = "running" | "success" | "error";

export type DemoTimelineStep =
  | {
      id: string;
      kind: "message";
      role: "user" | "assistant";
      text: string;
      time: string;
    }
  | {
      id: string;
      kind: "reasoning";
      summary: string;
      details: readonly string[];
      duration: string;
    }
  | {
      id: string;
      kind: "tool-call";
      toolName: string;
      toolIcon: "calculator" | "terminal" | "folder";
      summary: string;
      status: RunStatus;
      duration: string;
      input: Readonly<Record<string, unknown>>;
      result?: string;
      error?: { code: string; message: string };
      progress?: string;
    };

export interface DemoSession {
  id: string;
  title: string;
  updatedAt: string;
  model: string;
  steps: readonly DemoTimelineStep[];
}

export interface DemoProject {
  id: string;
  name: string;
  sessions: readonly DemoSession[];
}

export const demoWorkspace: { projects: readonly DemoProject[] } = {
  projects: [
    {
      id: "smys-agent",
      name: "smysAgent",
      sessions: [
        {
          id: "agent-runtime",
          title: "Обзор работы агента",
          updatedAt: "10:42",
          model: "Демо-модель",
          steps: [
            {
              id: "runtime-user",
              kind: "message",
              role: "user",
              text: "Сложи 2 и 3 и покажи, как отработал инструмент.",
              time: "10:42",
            },
            {
              id: "runtime-reasoning-before",
              kind: "reasoning",
              summary: "Подготовить вызов demo.add",
              details: [
                "Запрос требует простого вычисления, для него доступен demo.add.",
                "Передам инструменту два числовых аргумента: 2 и 3.",
              ],
              duration: "0,4 с",
            },
            {
              id: "runtime-add",
              kind: "tool-call",
              toolName: "demo.add",
              toolIcon: "calculator",
              summary: "Сложение двух чисел",
              status: "success",
              duration: "52 мс",
              input: { a: 2, b: 3 },
              result: "5",
            },
            {
              id: "runtime-reasoning-after",
              kind: "reasoning",
              summary: "Сверить результат и ответить",
              details: ["Результат инструмента — 5. Можно дать короткий ответ с проверяемым итогом."],
              duration: "0,2 с",
            },
            {
              id: "runtime-assistant",
              kind: "message",
              role: "assistant",
              text: "2 + 3 = 5.",
              time: "10:42",
            },
          ],
        },
        {
          id: "web-build",
          title: "Сборка web-макета",
          updatedAt: "10:37",
          model: "Демо-модель",
          steps: [
            {
              id: "build-user",
              kind: "message",
              role: "user",
              text: "Собери web-макет и покажи состояние процесса.",
              time: "10:37",
            },
            {
              id: "build-reasoning",
              kind: "reasoning",
              summary: "Запустить production-сборку",
              details: ["Для проверки достаточно typecheck и сборки локального web-пакета."],
              duration: "0,3 с",
            },
            {
              id: "build-tool",
              kind: "tool-call",
              toolName: "npm.run.build",
              toolIcon: "terminal",
              summary: "Выполняется production build",
              status: "running",
              duration: "12 с",
              input: { command: "npm run build", package: "src/apps/web" },
              progress: "Vite собирает клиентский пакет…",
            },
          ],
        },
        {
          id: "storage-check",
          title: "Проверка JSON-хранилища",
          updatedAt: "Вчера",
          model: "Демо-модель",
          steps: [
            {
              id: "storage-user",
              kind: "message",
              role: "user",
              text: "Проверь историю сессии в локальном хранилище.",
              time: "Вчера",
            },
            {
              id: "storage-reasoning",
              kind: "reasoning",
              summary: "Открыть файл истории",
              details: ["Попробую прочитать демонстрационный файл и показать безопасную причину сбоя."],
              duration: "0,1 с",
            },
            {
              id: "storage-tool",
              kind: "tool-call",
              toolName: "storage.read",
              toolIcon: "folder",
              summary: "Чтение файла истории",
              status: "error",
              duration: "8 мс",
              input: { file: "store.json", sessionId: "demo-session-17" },
              error: {
                code: "ENOENT",
                message: "Демонстрационный файл store.json не найден.",
              },
            },
            {
              id: "storage-assistant",
              kind: "message",
              role: "assistant",
              text: "Не удалось прочитать историю: демонстрационный файл отсутствует.",
              time: "Вчера",
            },
          ],
        },
      ],
    },
    {
      id: "personal-notes",
      name: "Личные заметки",
      sessions: [
        {
          id: "ui-ideas",
          title: "Идеи для интерфейса",
          updatedAt: "Вчера",
          model: "Демо-модель",
          steps: [
            {
              id: "ideas-user",
              kind: "message",
              role: "user",
              text: "Какие детали стоит показать в ленте агента?",
              time: "Вчера",
            },
            {
              id: "ideas-reasoning",
              kind: "reasoning",
              summary: "Сохранить сканируемость ленты",
              details: [
                "Короткая строка должна сообщать тип шага, краткий итог и статус.",
                "Аргументы, результат и причина ошибки уместны внутри раскрываемой области.",
              ],
              duration: "0,3 с",
            },
            {
              id: "ideas-assistant",
              kind: "message",
              role: "assistant",
              text: "Оставить в строке тип шага, итог и статус. Подробности входа и результата раскрывать по запросу.",
              time: "Вчера",
            },
          ],
        },
      ],
    },
  ],
};
