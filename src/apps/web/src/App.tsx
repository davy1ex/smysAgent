import { useEffect, useRef, useState } from "react";
import { Icon } from "./components/Icon";
import {
  createSession,
  fetchHistory,
  fetchSessions,
  sendMessageStream,
  WebApiError,
  type SessionHistory,
  type SessionMessage,
  type SessionRecord,
  type SessionSummary,
} from "./api";

const mobileBreakpoint = "(max-width: 760px)";

type TurnStatus = "pending" | "completed" | "error" | "cancelled";
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
  turnStatus,
  turnError,
  streaming = false,
  compact = false,
  stepNumber,
}: {
  message: SessionMessage;
  turnStatus?: TurnStatus | undefined;
  turnError?: string | undefined;
  streaming?: boolean;
  compact?: boolean;
  stepNumber?: number;
}) {
  const isUser = message.role === "user";
  const statusIcon = turnStatus === "pending" ? "loader" : turnStatus === "error" || turnStatus === "cancelled" ? "alert" : "check";
  const statusLabel = turnStatus === "pending"
    ? "Генерируется ответ…"
    : turnStatus === "error"
      ? turnError ?? "Ошибка ответа"
      : turnStatus === "cancelled"
        ? "Генерация остановлена"
      : "Ответ получен";

  return (
    <article className={`message-item ${isUser ? "message-user" : "message-assistant"}${compact ? " message-compact" : ""}`}>
      {stepNumber !== undefined && <span className="trajectory-number">{String(stepNumber).padStart(2, "0")}</span>}
      {!isUser && <span className="assistant-avatar"><Icon name="brand" size={16} /></span>}
      <div className="message-content">
        <div className="message-meta">
          <strong>{isUser ? "Вы" : "smys"}</strong>
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        </div>
        <p className={streaming && message.content[0]?.text.length === 0 ? "streaming-placeholder" : undefined}>
          {message.content[0]?.text || (streaming ? "Генерируется ответ…" : "")}
          {streaming && message.content[0]?.text.length > 0 && <span className="streaming-cursor" aria-hidden="true">▍</span>}
        </p>
        {isUser && turnStatus && (
          <div className={`turn-status turn-${turnStatus}`} role={turnStatus === "error" ? "alert" : "status"}>
            <Icon name={statusIcon} size={12} />
            <span>{statusLabel}</span>
          </div>
        )}
      </div>
      {isUser && <span className="user-avatar">D</span>}
    </article>
  );
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
  failedTurns,
  stoppedTurns,
}: {
  session: SessionSummary;
  history: SessionHistory | undefined;
  pending: PendingTurn | null;
  failedTurns: ReadonlyMap<string, string>;
  stoppedTurns: ReadonlySet<string>;
}) {
  const messages = history?.messages ?? [];
  const visibleMessages = pending?.sessionId === session.id ? appendPendingMessage(messages, pending) : messages;

  return (
    <div className="chat-timeline">
      <div className="timeline-date"><span />{formatSessionDate(session.updatedAt)}<span /></div>
      {visibleMessages.map((message, index) => {
        const next = visibleMessages[index + 1];
        const isPending = message.id === pending?.id;
        const status: TurnStatus | undefined = message.role !== "user"
          ? undefined
          : isPending
            ? "pending"
            : next?.role === "assistant"
              ? "completed"
              : stoppedTurns.has(message.id)
                ? "cancelled"
              : failedTurns.has(message.id)
                ? "error"
                : undefined;
        return (
          <MessageItem
            key={message.id}
            message={message}
            turnStatus={status}
            turnError={failedTurns.get(message.id)}
            streaming={message.id === `${pending?.id}-assistant`}
          />
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
  failedTurns,
  stoppedTurns,
}: {
  history: SessionHistory | undefined;
  pending: PendingTurn | null;
  sessionId: string;
  failedTurns: ReadonlyMap<string, string>;
  stoppedTurns: ReadonlySet<string>;
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
            const next = visibleMessages[index + 1];
            const isPending = message.id === pending?.id;
            const status: TurnStatus | undefined = message.role !== "user"
              ? undefined
              : isPending
                ? "pending"
                : next?.role === "assistant"
                  ? "completed"
                  : stoppedTurns.has(message.id)
                    ? "cancelled"
                  : failedTurns.has(message.id)
                    ? "error"
                    : undefined;
            return (
              <div className="trajectory-row" key={message.id}>
                <MessageItem
                  message={message}
                  compact
                  stepNumber={index + 1}
                  turnStatus={status}
                  turnError={failedTurns.get(message.id)}
                  streaming={message.id === `${pending?.id}-assistant`}
                />
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
  onSend,
  onCancel,
}: {
  disabled: boolean;
  sending: boolean;
  error: string;
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");

  const submit = () => {
    const value = text.trim();
    if (!value || disabled || sending) return;
    setText("");
    void onSend(value);
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
        <div className="composer-toolbar">
          <span className="composer-note">Enter — отправить · Shift+Enter — новая строка</span>
          <div className="composer-controls">
            <span className="composer-model">Локальная модель</span>
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
  const [activeTab, setActiveTab] = useState<"chat" | "trajectory">("chat");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(mobileBreakpoint).matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(mobileBreakpoint).matches);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [failedTurns, setFailedTurns] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [stoppedTurns, setStoppedTurns] = useState<ReadonlySet<string>>(() => new Set());
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);
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
      setHistoryBySession((current) => ({ ...current, [session.id]: { session, messages: [] } }));
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

  const submitMessage = async (text: string) => {
    if (!activeSessionId || sending) return;
    const sessionId = activeSessionId;
    const previousMessageCount = historyBySession[sessionId]?.messages.length ?? 0;
    const optimisticId = `pending-${crypto.randomUUID()}`;
    const controller = new AbortController();
    streamController.current = controller;
    setPending({ sessionId, id: optimisticId, text, assistantText: "", createdAt: new Date().toISOString() });
    setSending(true);
    setError("");
    try {
      const turn = await sendMessageStream(sessionId, text, {
        onStarted: (_runId, userMessage) => {
          setPending((current) => current?.sessionId === sessionId
            ? { ...current, id: userMessage.id }
            : current);
        },
        onTextDelta: (delta) => {
          setPending((current) => current?.sessionId === sessionId
            ? { ...current, assistantText: current.assistantText + delta }
            : current);
        },
      }, controller.signal);
      setHistoryBySession((current) => {
        const previous = current[sessionId] ?? { session: { id: sessionId, createdAt: turn.userMessage.createdAt }, messages: [] };
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
      setFailedTurns((current) => {
        const next = new Map(current);
        next.delete(turn.userMessage.id);
        return next;
      });
      setStoppedTurns((current) => {
        if (!current.has(turn.userMessage.id)) return current;
        const next = new Set(current);
        next.delete(turn.userMessage.id);
        return next;
      });
      setPending(null);
      setSessions(await fetchSessions());
    } catch (cause) {
      const message = errorMessage(cause);
      if (cause instanceof WebApiError && cause.turnId) {
        if (cause.code === "ABORTED") {
          setStoppedTurns((current) => new Set(current).add(cause.turnId!));
        } else {
          setFailedTurns((current) => new Map(current).set(cause.turnId!, message));
        }
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
              setStoppedTurns((current) => new Set(current).add(newUserMessage.id));
              setError("");
              setSessions(await fetchSessions());
            } else {
              setError(message);
            }
          } catch {
            setError(message);
          }
          setPending(null);
        } else {
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
                ? <ChatTimeline session={selected} history={selectedHistory} pending={pending} failedTurns={failedTurns} stoppedTurns={stoppedTurns} />
                : <Trajectory history={selectedHistory} pending={pending} sessionId={selected.id} failedTurns={failedTurns} stoppedTurns={stoppedTurns} />
              : <div className="empty-state"><Icon name="chat" size={20} /><strong>Начните новый диалог</strong><span>Создайте сессию, чтобы отправить запрос агенту.</span><button type="button" onClick={() => { void createNewSession(); }}>Создать чат</button></div>}
        </section>

        <Composer disabled={!selected} sending={sending} error={error} onSend={submitMessage} onCancel={cancelCurrentTurn} />
      </main>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Произошла непредвиденная ошибка.";
}
