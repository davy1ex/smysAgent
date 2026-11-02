import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "./components/Icon";
import { AssistantMarkdown } from "../markdown-renderer.mjs";
import {
  applyTurnRuntimeEvent,
  completeTurn,
  createTurnPresentation,
  failTurn,
  getReasoningPreview,
  markAssistantDelta,
  restoreCompletedRun,
  restoreCompletedReasoning,
  type TurnPresentation,
  type TurnStep,
} from "../../web-ui/turn-presentation";
import {
  createSession,
  fetchProviderCatalog,
  fetchHistory,
  fetchSessions,
  setSessionModel,
  sendMessageStream,
  WebApiError,
  type ModelConfiguration,
  type ProviderCatalog,
  type SessionHistory,
  type SessionMessage,
  type SessionRecord,
  type SessionSummary,
} from "./api";
import { ProviderSettings } from "./ProviderSettings";

const mobileBreakpoint = "(max-width: 760px)";

type PendingTurn = { sessionId: string; id: string; text: string; assistantText: string; createdAt: string };

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatSessionDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function MessageItem({
  message,
  streaming = false,
  compact = false,
  stepNumber,
  presentation,
  detailedTimeline = false,
  modelSelection,
}: {
  message: SessionMessage;
  streaming?: boolean;
  compact?: boolean;
  stepNumber?: number;
  presentation?: TurnPresentation | undefined;
  detailedTimeline?: boolean;
  modelSelection?: { providerName: string; modelName: string };
}) {
  const isUser = message.role === "user";
  const timelinePresentation = presentation ?? (isUser ? undefined : restoreCompletedReasoning(message.reasoning));

  return (
    <article className={`message-item ${isUser ? "message-user" : "message-assistant"}${compact ? " message-compact" : ""}`}>
      {stepNumber !== undefined && <span className="trajectory-number">{String(stepNumber).padStart(2, "0")}</span>}
      {!isUser && <span className="assistant-avatar"><Icon name="brand" size={16} /></span>}
      <div className="message-content">
        <div className="message-meta">
          <strong>{isUser ? "Вы" : "smys"}</strong>
          {!isUser && modelSelection && <span className="message-model-label">{modelSelection.providerName} · {modelSelection.modelName}</span>}
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        </div>
        {!isUser && timelinePresentation && <TurnTimeline presentation={timelinePresentation} detailed={detailedTimeline} />}
        {isUser
          ? <p>{message.content[0]?.text}</p>
          : <div className={`assistant-markdown${streaming && message.content[0]?.text.length === 0 ? " streaming-placeholder" : ""}`}>
            {message.content[0]?.text
              ? <AssistantMarkdown content={message.content[0].text} />
              : streaming && <p className="streaming-placeholder">Генерируется ответ…</p>}
            {streaming && message.content[0]?.text.length > 0 && <span className="streaming-cursor" aria-hidden="true">▍</span>}
          </div>}
      </div>
      {isUser && <span className="user-avatar">D</span>}
    </article>
  );
}

function presentationForAssistant(
  message: SessionMessage,
  previous: SessionMessage | undefined,
  history: SessionHistory | undefined,
  turnsByUserMessage: Readonly<Record<string, TurnPresentation>>,
): TurnPresentation | undefined {
  if (message.role !== "assistant") return undefined;
  const run = history?.runs.find((candidate) => candidate.assistantMessageId === message.id);
  if (run !== undefined) {
    return turnsByUserMessage[run.userMessageId] ?? restoreCompletedRun(run.steps, run.startedAt, run.completedAt);
  }
  return previous?.role === "user" ? turnsByUserMessage[previous.id] : undefined;
}

function TurnTimeline({
  presentation,
  detailed = false,
}: {
  presentation: TurnPresentation;
  detailed?: boolean;
}) {
  const icon = presentation.status === "completed"
    ? "check"
    : presentation.status === "failed" || presentation.status === "cancelled"
      ? "alert"
      : "loader";
  const statusLabel = turnStatusLabel(presentation);

  return (
    <section className={`turn-timeline${detailed ? " turn-timeline-detailed" : " turn-timeline-compact"}`} aria-label="Ход агента">
      <div className={`turn-status turn-${presentation.status}`} role={presentation.status === "failed" ? "alert" : "status"}>
        <Icon name={icon} size={12} />
        <span>{statusLabel}</span>
      </div>
      {presentation.steps.length > 0 && (
        <ol className="turn-steps">
          {presentation.steps
            .filter((step) => detailed || step.type !== "model")
            .map((step, index) => (
            <li className={`turn-step-row turn-step-${step.type}`} key={turnStepKey(step, index)}>
              <TurnStepView step={step} presentation={presentation} detailed={detailed} />
            </li>
            ))}
        </ol>
      )}
    </section>
  );
}

function TurnStepView({
  step,
  presentation,
  detailed,
}: {
  step: TurnStep;
  presentation: TurnPresentation;
  detailed: boolean;
}) {
  if (step.type === "model") {
    const label = step.status === "running"
      ? step.phase === "generating" ? "Генерирует ответ…" : "Модель выполняет запрос…"
      : step.status === "completed"
        ? "Вызов модели завершён"
        : step.status === "cancelled"
          ? "Вызов модели отменён"
          : step.status === "failed"
            ? "Ошибка вызова модели"
            : "Ожидание модели…";
    const modelStepContent = (
      <>
        <Icon name={step.status === "running" ? "loader" : step.status === "completed" ? "check" : "alert"} size={12} />
        <span>{label}</span>
        <small>#{step.callIndex}</small>
      </>
    );
    return detailed
      ? <details className={`turn-model-step turn-step-state-${step.status}`}>
        <summary>{modelStepContent}</summary>
        <div className="turn-model-details">
          <span>Вызов модели #{step.callIndex}</span>
          <span>Состояние: {label}</span>
          <span>Фаза: {step.phase === "generating" ? "генерация текста" : "ожидание ответа"}</span>
        </div>
      </details>
      : <div className={`turn-model-step turn-step-state-${step.status}`}>{modelStepContent}</div>;
  }

  if (step.type === "reasoning") {
    return <ReasoningStepView step={step} detailed={detailed} />;
  }

  const toolStatus = step.status === "completed"
    ? "Завершён"
    : step.status === "running"
      ? "Выполняется"
      : step.status === "failed"
        ? "Ошибка"
        : step.status === "cancelled"
          ? "Отменён"
          : "Запрошен";
  return (
    <details className={`turn-tool-step turn-step-state-${step.status}`}>
      <summary>
        <span>{step.name}</span>
        <small>{toolStatus}</small>
      </summary>
      <div className="turn-tool-details">
        {detailed && <>
          <strong>Аргументы</strong>
          <pre>{formatJson(step.arguments)}</pre>
        </>}
        {step.result !== undefined && <>
          <strong>Результат</strong>
          <pre>{step.result}</pre>
        </>}
        {step.status === "failed" && presentation.error && <p role="alert">{presentation.error}</p>}
        {step.status === "cancelled" && presentation.error && <p>{presentation.error}</p>}
      </div>
    </details>
  );
}

function ReasoningStepView({ step, detailed }: { step: Extract<TurnStep, { type: "reasoning" }>; detailed: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const label = step.status === "completed" ? "Анализ завершён"
    : step.status === "failed" ? "Анализ прерван из-за ошибки"
      : step.status === "cancelled" ? "Анализ остановлен"
        : "Анализирует…";

  return (
    <details
      className={`turn-reasoning turn-reasoning-${step.status}`}
      open={expanded}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setExpanded((current) => current === next ? current : next);
      }}
    >
      <summary>
        <strong>{detailed ? `Размышление модели · вызов #${step.callIndex}` : label}</strong>
        {!detailed && <span className="turn-reasoning-preview"><b>Think ·</b><span className="turn-reasoning-preview-text">{getReasoningPreview(step.text, { status: step.status })}</span></span>}
      </summary>
      <p className="turn-reasoning-text">{step.text}</p>
    </details>
  );
}

function turnStatusLabel(presentation: TurnPresentation): string {
  switch (presentation.status) {
    case "connecting": return "Отправляем запрос…";
    case "running": {
      const active = [...presentation.steps].reverse().find((step) =>
        (step.type === "model" || step.type === "tool") && (step.status === "pending" || step.status === "running"),
      );
      if (active?.type === "tool") return `Выполняется ${active.name}…`;
      if (active?.type === "model") {
        return active.phase === "generating" ? "Генерирует ответ…" : "Модель выполняет запрос…";
      }
      return "Модель выполняет запрос…";
    }
    case "completed":
      return presentation.durationMs === undefined
        ? "Завершено"
        : `Завершено · ${formatDuration(presentation.durationMs)}`;
    case "failed": return presentation.error ?? "Ошибка выполнения";
    case "cancelled": return "Ход отменён";
  }
}

function formatDuration(durationMs: number): string {
  const seconds = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    .format(durationMs / 1000);
  return `${seconds} с`;
}

function turnStepKey(step: TurnStep, index: number): string {
  return step.type === "model"
    ? `model-${step.callIndex}`
    : step.type === "tool"
      ? `tool-${step.callId}`
      : `reasoning-${step.callIndex}-${index}`;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function withoutTurn(
  turns: Readonly<Record<string, TurnPresentation>>,
  userMessageId: string,
): Readonly<Record<string, TurnPresentation>> {
  const next = { ...turns };
  delete next[userMessageId];
  return next;
}

function appendPendingMessage(messages: SessionMessage[], pending: PendingTurn): SessionMessage[] {
  return [
    ...messages,
    {
      id: pending.id,
      sessionId: pending.sessionId,
      sequence: messages.length + 1,
      role: "user",
      content: [{ type: "text", text: pending.text }],
      createdAt: pending.createdAt,
    },
    {
      id: `${pending.id}-assistant`,
      sessionId: pending.sessionId,
      sequence: messages.length + 2,
      role: "assistant",
      content: [{ type: "text", text: pending.assistantText }],
      createdAt: pending.createdAt,
    },
  ];
}

function ChatTimeline({
  session,
  history,
  pending,
  turnsByUserMessage,
}: {
  session: SessionSummary;
  history: SessionHistory | undefined;
  pending: PendingTurn | null;
  turnsByUserMessage: Readonly<Record<string, TurnPresentation>>;
}) {
  const messages = history?.messages ?? [];
  const visibleMessages = pending?.sessionId === session.id ? appendPendingMessage(messages, pending) : messages;

  return (
    <div className="chat-timeline">
      <div className="timeline-date"><span />{formatSessionDate(session.updatedAt)}<span /></div>
      {visibleMessages.map((message, index) => {
        const previous = index > 0 ? visibleMessages[index - 1] : undefined;
        const next = visibleMessages[index + 1];
        const presentation = presentationForAssistant(message, previous, history, turnsByUserMessage);
      const modelSelection = history?.runs.find((run) => run.assistantMessageId === message.id)?.modelSelection;
        const standalonePresentation = message.role === "user" && next?.role !== "assistant"
          ? turnsByUserMessage[message.id]
          : undefined;
        return (
          <Fragment key={message.id}>
            <MessageItem
              message={message}
              streaming={message.id === `${pending?.id}-assistant`}
              presentation={presentation}
              {...(modelSelection === undefined ? {} : { modelSelection })}
            />
            {standalonePresentation && <TurnTimeline presentation={standalonePresentation} />}
          </Fragment>
        );
      })}
      {messages.length === 0 && !pending && (
        <div className="empty-conversation">Напишите первое сообщение, чтобы начать диалог.</div>
      )}
    </div>
  );
}

function Trajectory({
  history,
  pending,
  sessionId,
  turnsByUserMessage,
}: {
  history: SessionHistory | undefined;
  pending: PendingTurn | null;
  sessionId: string;
  turnsByUserMessage: Readonly<Record<string, TurnPresentation>>;
}) {
  const messages = history?.messages ?? [];
  const visibleMessages = pending?.sessionId === sessionId ? appendPendingMessage(messages, pending) : messages;

  return (
    <div className="trajectory-view">
      <div className="trajectory-intro">
        <div>
          <strong>Сообщения сессии</strong>
          <span>Сохранённая история · {messages.length} сообщений</span>
        </div>
      </div>
      {visibleMessages.length === 0
        ? <div className="empty-conversation">В этой сессии пока нет сообщений.</div>
        : <div className="trajectory-list">
          {visibleMessages.map((message, index) => {
            const previous = index > 0 ? visibleMessages[index - 1] : undefined;
            const next = visibleMessages[index + 1];
            const presentation = presentationForAssistant(message, previous, history, turnsByUserMessage);
            const modelSelection = history?.runs.find((run) => run.assistantMessageId === message.id)?.modelSelection;
            const standalonePresentation = message.role === "user" && next?.role !== "assistant"
              ? turnsByUserMessage[message.id]
              : undefined;
            return (
              <div className="trajectory-row" key={message.id}>
                <MessageItem
                  message={message}
                  compact
                  stepNumber={index + 1}
                  streaming={message.id === `${pending?.id}-assistant`}
                  presentation={presentation}
                  detailedTimeline
                  {...(modelSelection === undefined ? {} : { modelSelection })}
                />
                {standalonePresentation && <TurnTimeline presentation={standalonePresentation} detailed />}
              </div>
            );
          })}
        </div>}
    </div>
  );
}

function ProjectSection({
  sessions,
  activeSessionId,
  expanded,
  onToggle,
  onSelectSession,
}: {
  sessions: readonly SessionSummary[];
  activeSessionId: string;
  expanded: boolean;
  onToggle: () => void;
  onSelectSession: (sessionId: string) => void;
}) {
  return (
    <section className="project-section">
      <button className="project-heading" type="button" aria-expanded={expanded} onClick={onToggle}>
        <Icon className="project-chevron" name="chevron" size={14} />
        <Icon name="folder" size={15} />
        <span>Без проекта</span>
        <span className="project-count">{sessions.length}</span>
      </button>
      {expanded && (
        <div className="project-sessions">
          {sessions.map((session) => (
            <button
              className={`session-link${activeSessionId === session.id ? " session-active" : ""}`}
              key={session.id}
              type="button"
              aria-current={activeSessionId === session.id ? "page" : undefined}
              onClick={() => onSelectSession(session.id)}
            >
              <Icon name="chat" size={14} />
              <span className="session-link-title">{session.title}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Sidebar({
  sessions,
  activeSessionId,
  expanded,
  onToggle,
  onSelectSession,
  onCreateSession,
}: {
  sessions: readonly SessionSummary[];
  activeSessionId: string;
  expanded: boolean;
  onToggle: () => void;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
}) {
  return (
    <aside className="sidebar" aria-label="Сессии">
      <div className="brand-lockup">
        <div className="brand-mark"><Icon name="brand" size={20} /></div>
        <span>smys<span className="brand-period">.</span></span>
        <span className="brand-edition">АГЕНТ</span>
      </div>

      <button className="workspace-select" type="button" disabled>
        <span className="workspace-avatar">S</span>
        <span className="workspace-copy"><strong>Локальное пространство</strong><small>Данные на этом компьютере</small></span>
        <span className="workspace-caret">⌄</span>
      </button>

      <div className="sidebar-toolbar">
        <span className="sidebar-label">РАБОЧЕЕ ПРОСТРАНСТВО</span>
        <button className="new-chat-button" type="button" onClick={onCreateSession}>
          <Icon name="plus" size={15} /><span>Новый чат</span>
        </button>
      </div>

      <div className="projects-heading"><span>СЕССИИ</span></div>
      <nav className="project-list" aria-label="Список сессий">
        <ProjectSection
          sessions={sessions}
          activeSessionId={activeSessionId}
          expanded={expanded}
          onToggle={onToggle}
          onSelectSession={onSelectSession}
        />
      </nav>

      <div className="sidebar-footer">
        <div className="profile-avatar">S</div>
        <div className="profile-copy"><strong>SMYS</strong><small>Локальный агент</small></div>
        <span className="footer-local"><span />ЛОКАЛЬНО</span>
      </div>
    </aside>
  );
}

function Composer({
  disabled,
  sending,
  error,
  allowDemoAdd,
  onAllowDemoAddChange,
  onSend,
  onCancel,
  models,
  selectedModelConfigId,
  onSelectModel,
  onOpenProviderSettings,
}: {
  disabled: boolean;
  sending: boolean;
  error: string;
  allowDemoAdd: boolean;
  onAllowDemoAddChange: (allow: boolean) => void;
  onSend: (text: string, allowDemoAdd: boolean) => Promise<void>;
  onCancel: () => void;
  models: readonly ModelConfiguration[];
  selectedModelConfigId: string;
  onSelectModel: (modelConfigId: string) => void;
  onOpenProviderSettings: () => void;
}) {
  const [text, setText] = useState("");

  const submit = () => {
    const value = text.trim();
    if (!value || disabled || sending) return;
    setText("");
    void onSend(value, allowDemoAdd);
  };

  return (
    <footer className="composer-dock">
      <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea
          aria-label="Поле ввода сообщения"
          placeholder={disabled ? "Создайте чат, чтобы написать сообщение" : "Напишите сообщение…"}
          value={text}
          disabled={disabled || sending}
          rows={2}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <label className="composer-tool-permission">
          <input
            type="checkbox"
            checked={allowDemoAdd}
            disabled={disabled || sending}
            onChange={(event) => onAllowDemoAddChange(event.target.checked)}
          />
          <span>Разрешить demo.add только для этого хода</span>
        </label>
        <div className="composer-toolbar">
          <span className="composer-note">Enter — отправить · Shift+Enter — новая строка</span>
          <div className="composer-controls">
            <select className="composer-model-select" aria-label="Модель для этой сессии" value={selectedModelConfigId} disabled={sending} onChange={(event) => onSelectModel(event.target.value)}>
              <option value="">Модель по умолчанию</option>
              {models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
            </select>
            <button className="composer-settings-button" type="button" onClick={onOpenProviderSettings} aria-label="Настроить провайдеры и модели">Модели</button>
            {sending
              ? <button className="stop-button" type="button" onClick={onCancel}>Остановить</button>
              : <button className="send-button" type="submit" aria-label="Отправить сообщение" disabled={disabled || text.trim().length === 0}>
                <Icon name="send" size={15} />
              </button>}
          </div>
        </div>
      </form>
      {error && <p className="composer-error" role="alert">{error}</p>}
    </footer>
  );
}

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [historyBySession, setHistoryBySession] = useState<Readonly<Record<string, SessionHistory>>>({});
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalog | null>(null);
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "trajectory">("chat");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(mobileBreakpoint).matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(mobileBreakpoint).matches);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [turnsByUserMessage, setTurnsByUserMessage] = useState<Readonly<Record<string, TurnPresentation>>>({});
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [allowDemoAdd, setAllowDemoAdd] = useState(false);
  const [error, setError] = useState("");
  const streamController = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchSessions().then((found) => {
      if (cancelled) return;
      setSessions(found);
      setActiveSessionId(found[0]?.id ?? "");
    }).catch((cause: unknown) => {
      if (!cancelled) setError(errorMessage(cause));
    }).finally(() => {
      if (!cancelled) setLoadingSessions(false);
    });
    return () => { cancelled = true; };
  }, []);

  const refreshProviderCatalog = async () => {
    const catalog = await fetchProviderCatalog();
    setProviderCatalog(catalog);
    setSessions(await fetchSessions());
  };

  const openProviderSettings = async () => {
    try {
      if (providerCatalog === null) await refreshProviderCatalog();
      setProviderSettingsOpen(true);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  useEffect(() => {
    let cancelled = false;
    void fetchProviderCatalog().then((catalog) => {
      if (!cancelled) setProviderCatalog(catalog);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(errorMessage(cause));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      setLoadingHistory(false);
      return undefined;
    }
    let cancelled = false;
    setLoadingHistory(true);
    void fetchHistory(activeSessionId).then((history) => {
      if (cancelled) return;
      setHistoryBySession((current) => ({ ...current, [activeSessionId]: history }));
      setError("");
    }).catch((cause: unknown) => {
      if (!cancelled) setError(errorMessage(cause));
    }).finally(() => {
      if (!cancelled) setLoadingHistory(false);
    });
    return () => { cancelled = true; };
  }, [activeSessionId]);

  useEffect(() => {
    const query = window.matchMedia(mobileBreakpoint);
    const updateViewport = () => {
      setIsMobile(query.matches);
      setSidebarOpen(!query.matches);
    };
    query.addEventListener("change", updateViewport);
    return () => query.removeEventListener("change", updateViewport);
  }, []);

  useEffect(() => {
    if (!isMobile || !sidebarOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isMobile, sidebarOpen]);

  const selected = sessions.find((session) => session.id === activeSessionId);
  const selectedHistory = activeSessionId ? historyBySession[activeSessionId] : undefined;
  const effectiveModelConfigId = selected?.selectedModelConfigId ?? providerCatalog?.defaultModelConfigId ?? "";

  const selectSessionModel = async (modelConfigId: string) => {
    if (!selected || sending) return;
    const selection = modelConfigId || null;
    setError("");
    try {
      await setSessionModel(selected.id, selection);
      setSessions((current) => current.map((session) => {
        if (session.id !== selected.id) return session;
        const updated = { ...session };
        if (selection === null) delete updated.selectedModelConfigId;
        else updated.selectedModelConfigId = selection;
        return updated;
      }));
      setHistoryBySession((current) => {
        const history = current[selected.id];
        return history === undefined ? current : {
          ...current,
          [selected.id]: {
            ...history,
            session: (() => {
              const updated = { ...history.session };
              if (selection === null) delete updated.selectedModelConfigId;
              else updated.selectedModelConfigId = selection;
              return updated;
            })(),
          },
        };
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const createNewSession = async () => {
    setError("");
    try {
      const session: SessionRecord = await createSession();
      const summary: SessionSummary = {
        ...session,
        updatedAt: session.createdAt,
        title: "Новый чат",
      };
      setSessions((current) => [summary, ...current]);
      setHistoryBySession((current) => ({ ...current, [session.id]: { session, messages: [], runs: [] } }));
      setActiveSessionId(session.id);
      if (isMobile) setSidebarOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const selectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setError("");
    if (isMobile) setSidebarOpen(false);
  };

  const submitMessage = async (text: string, allowDemoAdd: boolean) => {
    if (!activeSessionId || sending) return;
    const sessionId = activeSessionId;
    const previousMessageCount = historyBySession[sessionId]?.messages.length ?? 0;
    const optimisticId = `pending-${crypto.randomUUID()}`;
    const controller = new AbortController();
    let userMessageId = optimisticId;
    let startedAt: number | undefined;
    let turnCompleted = false;
    setAllowDemoAdd(false);
    streamController.current = controller;
    setPending({ sessionId, id: optimisticId, text, assistantText: "", createdAt: new Date().toISOString() });
    setTurnsByUserMessage((current) => ({ ...current, [optimisticId]: createTurnPresentation() }));
    setSending(true);
    setError("");
    try {
      const turn = await sendMessageStream(sessionId, text, {
        onStarted: (_runId, userMessage) => {
          userMessageId = userMessage.id;
          startedAt = performance.now();
          setPending((current) => current?.sessionId === sessionId
            ? { ...current, id: userMessage.id }
            : current);
          setTurnsByUserMessage((current) => {
            const { [optimisticId]: optimistic, ...rest } = current;
            return {
              ...rest,
              [userMessage.id]: { ...(optimistic ?? createTurnPresentation()), status: "running" },
            };
          });
        },
        onTextDelta: (delta) => {
          setPending((current) => current?.sessionId === sessionId
            ? { ...current, assistantText: current.assistantText + delta }
            : current);
          setTurnsByUserMessage((current) => ({
            ...current,
            [userMessageId]: markAssistantDelta(current[userMessageId] ?? createTurnPresentation()),
          }));
        },
        onRuntimeEvent: (event, payload) => {
          setTurnsByUserMessage((current) => ({
            ...current,
            [userMessageId]: applyTurnRuntimeEvent(current[userMessageId] ?? createTurnPresentation(), event, payload),
          }));
        },
      }, controller.signal, allowDemoAdd ? ["demo.add"] : []);
      turnCompleted = true;
      const durationMs = startedAt === undefined ? 0 : performance.now() - startedAt;
      setTurnsByUserMessage((current) => ({
        ...current,
        [turn.userMessage.id]: completeTurn(current[turn.userMessage.id] ?? createTurnPresentation(), durationMs),
      }));
      setHistoryBySession((current) => {
        const previous = current[sessionId] ?? { session: { id: sessionId, createdAt: turn.userMessage.createdAt }, messages: [], runs: [] };
        const existing = new Set(previous.messages.map((message) => message.id));
        return {
          ...current,
          [sessionId]: {
            ...previous,
            messages: [
              ...previous.messages,
              ...(existing.has(turn.userMessage.id) ? [] : [turn.userMessage]),
              ...(existing.has(turn.assistantMessage.id) ? [] : [turn.assistantMessage]),
            ],
          },
        };
      });
      setPending(null);
      const refreshedHistory = await fetchHistory(sessionId);
      setHistoryBySession((current) => ({ ...current, [sessionId]: refreshedHistory }));
      setSessions(await fetchSessions());
    } catch (cause) {
      const message = errorMessage(cause);
      if (turnCompleted) {
        setError(message);
      } else if (cause instanceof WebApiError && cause.turnId) {
        const status = cause.code === "ABORTED" ? "cancelled" : "failed";
        setTurnsByUserMessage((current) => ({
          ...current,
          [cause.turnId!]: failTurn(current[cause.turnId!] ?? createTurnPresentation(), status, message),
        }));
        try {
          const history = await fetchHistory(sessionId);
          setHistoryBySession((current) => ({ ...current, [sessionId]: history }));
          setPending(null);
          setSessions(await fetchSessions());
        } catch {
          setError(message);
        }
      } else {
        if (cause instanceof WebApiError && cause.code === "ABORTED") {
          try {
            const history = await fetchHistory(sessionId);
            setHistoryBySession((current) => ({ ...current, [sessionId]: history }));
            const newUserMessage = history.messages.slice(previousMessageCount).find((entry) =>
              entry.role === "user" && entry.content[0]?.text === text,
            );
            if (newUserMessage !== undefined) {
              setTurnsByUserMessage((current) => ({
                ...current,
                [newUserMessage.id]: failTurn(
                  current[newUserMessage.id] ?? createTurnPresentation(),
                  "cancelled",
                  message,
                ),
              }));
              setError("");
              setSessions(await fetchSessions());
            } else {
              setTurnsByUserMessage((current) => withoutTurn(current, optimisticId));
              setError(message);
            }
          } catch {
            setError(message);
          }
          setPending(null);
        } else {
          if (startedAt !== undefined) {
            setTurnsByUserMessage((current) => ({
              ...current,
              [userMessageId]: failTurn(current[userMessageId] ?? createTurnPresentation(), "failed", message),
            }));
          } else {
            setTurnsByUserMessage((current) => withoutTurn(current, optimisticId));
          }
          setError(message);
        }
      }
    } finally {
      if (streamController.current === controller) streamController.current = null;
      setPending(null);
      setSending(false);
    }
  };

  const cancelCurrentTurn = () => streamController.current?.abort();

  const className = `app-shell ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}${isMobile ? " app-mobile" : ""}`;

  return (
    <div className={className}>
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        expanded={sidebarExpanded}
        onToggle={() => setSidebarExpanded((expanded) => !expanded)}
        onSelectSession={selectSession}
        onCreateSession={() => { void createNewSession(); }}
      />
      {isMobile && sidebarOpen && <button className="sidebar-backdrop" type="button" aria-label="Закрыть панель навигации" onClick={() => setSidebarOpen(false)} />}

      <main className="chat-panel">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="sidebar-toggle"
              type="button"
              aria-label={sidebarOpen ? "Скрыть панель" : "Показать панель"}
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              <Icon name="menu" size={18} />
            </button>
            <div className="breadcrumbs"><span>Без проекта</span><span className="breadcrumb-slash">/</span><strong>{selected?.title ?? "Новый чат"}</strong></div>
          </div>
          <span className="demo-indicator"><span />LOCAL</span>
        </header>

        <section className="session-header">
          <div className="view-tabs" role="tablist" aria-label="Представление сессии">
            <button id="tab-chat" role="tab" aria-selected={activeTab === "chat"} aria-controls="session-panel" type="button" onClick={() => setActiveTab("chat")}>
              <Icon name="chat" size={15} />Чат
            </button>
            <button id="tab-trajectory" role="tab" aria-selected={activeTab === "trajectory"} aria-controls="session-panel" type="button" onClick={() => setActiveTab("trajectory")}>
              <Icon name="spark" size={15} />История
            </button>
          </div>
        </section>

        <section
          className="timeline-viewport"
          id="session-panel"
          role="tabpanel"
          aria-labelledby={activeTab === "chat" ? "tab-chat" : "tab-trajectory"}
        >
          {loadingSessions || loadingHistory
            ? <div className="empty-state"><Icon name="loader" size={18} />Загружаются сессии…</div>
            : selected
              ? activeTab === "chat"
                ? <ChatTimeline session={selected} history={selectedHistory} pending={pending} turnsByUserMessage={turnsByUserMessage} />
                : <Trajectory history={selectedHistory} pending={pending} sessionId={selected.id} turnsByUserMessage={turnsByUserMessage} />
              : <div className="empty-state"><Icon name="chat" size={20} /><strong>Начните новый диалог</strong><span>Создайте сессию, чтобы отправить запрос агенту.</span><button type="button" onClick={() => { void createNewSession(); }}>Создать чат</button></div>}
        </section>

        <Composer disabled={!selected} sending={sending} error={error} allowDemoAdd={allowDemoAdd} onAllowDemoAddChange={setAllowDemoAdd} onSend={submitMessage} onCancel={cancelCurrentTurn} models={providerCatalog?.models ?? []} selectedModelConfigId={effectiveModelConfigId} onSelectModel={(modelConfigId) => { void selectSessionModel(modelConfigId); }} onOpenProviderSettings={() => { void openProviderSettings(); }} />
      </main>
      {providerSettingsOpen && providerCatalog && <ProviderSettings catalog={providerCatalog} onClose={() => setProviderSettingsOpen(false)} onRefresh={refreshProviderCatalog} />}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Произошла непредвиденная ошибка.";
}
