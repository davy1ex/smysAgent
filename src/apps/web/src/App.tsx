import { useEffect, useState } from "react";
import { Icon } from "./components/Icon";
import type { DemoProject, DemoSession, DemoTimelineStep, RunStatus } from "./data/demo-chat";
import { demoWorkspace } from "./data/demo-chat";

const mobileBreakpoint = "(max-width: 760px)";

const statusLabels: Record<RunStatus, string> = {
  running: "Выполняется",
  success: "Успешно",
  error: "Ошибка",
};

const statusIcons = {
  running: "loader",
  success: "check",
  error: "alert",
} as const;

function StatusIndicator({ status, compact = false }: { status: RunStatus; compact?: boolean }) {
  return (
    <span className={`status-indicator status-${status}${compact ? " status-compact" : ""}`}>
      <Icon name={statusIcons[status]} size={13} />
      <span>{statusLabels[status]}</span>
    </span>
  );
}

function MessageItem({ step, compact = false, stepNumber }: {
  step: Extract<DemoTimelineStep, { kind: "message" }>;
  compact?: boolean;
  stepNumber: number | undefined;
}) {
  const isUser = step.role === "user";

  return (
    <article className={`message-item ${isUser ? "message-user" : "message-assistant"}${compact ? " message-compact" : ""}`}>
      {stepNumber !== undefined && <span className="trajectory-number">{String(stepNumber).padStart(2, "0")}</span>}
      {!isUser && <span className="assistant-avatar"><Icon name="brand" size={16} /></span>}
      <div className="message-content">
        <div className="message-meta">
          <strong>{isUser ? "Вы" : "smys"}</strong>
          <time>{step.time}</time>
        </div>
        <p>{step.text}</p>
      </div>
      {isUser && <span className="user-avatar">D</span>}
    </article>
  );
}

function StepDetails({ step }: { step: Exclude<DemoTimelineStep, { kind: "message" }> }) {
  if (step.kind === "reasoning") {
    return (
      <div className="reasoning-detail">
        {step.details.length > 0
          ? step.details.map((detail) => <p key={detail}>{detail}</p>)
          : <p className="detail-empty">Подробности не предоставлены.</p>}
      </div>
    );
  }

  return (
    <div className="tool-details">
      <div className="tool-detail-meta"><strong>{step.toolName}</strong><StatusIndicator status={step.status} /></div>
      <div className="detail-card">
        <div className="detail-heading"><span>ВХОД</span><span>JSON</span></div>
        <pre>{JSON.stringify(step.input, null, 2)}</pre>
      </div>
      {step.result !== undefined && (
        <div className="detail-card">
          <div className="detail-heading"><span>РЕЗУЛЬТАТ</span><span>ТЕКСТ</span></div>
          <pre>{step.result}</pre>
        </div>
      )}
      {step.status === "running" && step.progress && (
        <div className="tool-outcome outcome-running">
          <p>{step.progress}</p>
        </div>
      )}
      {step.status === "error" && step.error && (
        <div className="tool-outcome outcome-error">
          <div className="detail-heading"><span>ОШИБКА</span><code>{step.error.code}</code></div>
          <p>{step.error.message}</p>
        </div>
      )}
    </div>
  );
}

function TimelineStep({ step, stepNumber }: {
  step: Exclude<DemoTimelineStep, { kind: "message" }>;
  stepNumber: number | undefined;
}) {
  const isTool = step.kind === "tool-call";
  const iconName = isTool ? step.toolIcon : "spark";
  const title = isTool ? step.toolName : "Размышление";

  return (
    <details className={`timeline-step step-${step.kind} step-trajectory`}>
      <summary>
        {stepNumber !== undefined && <span className="trajectory-number">{String(stepNumber).padStart(2, "0")}</span>}
        <span className={`step-icon${isTool ? " tool-step-icon" : " reasoning-step-icon"}`}><Icon name={iconName} size={15} /></span>
        <span className="step-copy">
          <span className="step-title-line"><strong>{title}</strong>{isTool && <span className="step-kind-label">ИНСТРУМЕНТ</span>}</span>
          <span className="step-summary">{step.summary}</span>
        </span>
        {isTool && <StatusIndicator status={step.status} compact />}
        <span className="step-duration">{step.duration}</span>
        <Icon className="step-chevron" name="chevron" size={15} />
      </summary>
      <StepDetails step={step} />
    </details>
  );
}

type ChatActivityStep = Exclude<DemoTimelineStep, { kind: "message" }>;

function ChatActivity({ steps }: { steps: readonly ChatActivityStep[] }) {
  const [expandedStepIds, setExpandedStepIds] = useState<ReadonlySet<string>>(() => new Set());

  const toggleStep = (stepId: string) => {
    setExpandedStepIds((current) => {
      const next = new Set(current);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  return (
    <div className="chat-activity" role="group" aria-label="Действия агента">
      {steps.map((step) => {
        const isTool = step.kind === "tool-call";
        const iconName = isTool ? step.toolIcon : "spark";
        const label = isTool ? step.toolName : "Размышление";
        const expanded = expandedStepIds.has(step.id);
        const detailsId = `chat-step-details-${step.id}`;
        const accessibleLabel = `${label}, ${step.duration}${isTool ? `, ${statusLabels[step.status]}` : ""}`;

        return (
          <div className="chat-activity-item" key={step.id}>
            <button
              className="chat-activity-step"
              id={`chat-step-toggle-${step.id}`}
              type="button"
              aria-label={accessibleLabel}
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => toggleStep(step.id)}
            >
              <Icon className="chat-activity-icon" name={iconName} size={13} />
              <span className="chat-activity-label">{label}</span>
              {isTool && <span className={`activity-status status-${step.status}`} aria-hidden="true"><Icon name={statusIcons[step.status]} size={12} /></span>}
              <time>{step.duration}</time>
              <Icon className="activity-chevron" name="chevron" size={12} aria-hidden="true" />
            </button>
            <div
              className="chat-activity-details"
              id={detailsId}
              role="region"
              aria-labelledby={`chat-step-toggle-${step.id}`}
              hidden={!expanded}
            >
              <StepDetails step={step} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChatTimeline({ session }: { session: DemoSession }) {
  const entries: Array<{ kind: "message"; step: Extract<DemoTimelineStep, { kind: "message" }> } | { kind: "activity"; steps: ChatActivityStep[] }> = [];
  let activity: ChatActivityStep[] = [];

  const flushActivity = () => {
    if (activity.length > 0) entries.push({ kind: "activity", steps: activity });
    activity = [];
  };

  for (const step of session.steps) {
    if (step.kind === "message") {
      flushActivity();
      entries.push({ kind: "message", step });
    } else {
      activity.push(step);
    }
  }
  flushActivity();

  return (
    <div className="chat-timeline">
      <div className="timeline-date"><span />{session.updatedAt === "Вчера" ? "Вчера" : `Сегодня, ${session.updatedAt}`}<span /></div>
      {entries.map((entry) => entry.kind === "message"
        ? <MessageItem key={entry.step.id} step={entry.step} stepNumber={undefined} />
        : <ChatActivity key={entry.steps[0]?.id} steps={entry.steps} />)}
    </div>
  );
}

function Trajectory({ session }: { session: DemoSession }) {
  return (
    <div className="trajectory-view">
      <div className="trajectory-intro">
        <div>
          <strong>Траектория выполнения</strong>
          <span>{session.steps.length} шагов</span>
        </div>
      </div>
      <div className="trajectory-list">
        {session.steps.map((step, index) => (
          <div className="trajectory-row" key={step.id}>
            {step.kind === "message"
              ? <MessageItem step={step} compact stepNumber={index + 1} />
              : <TimelineStep step={step} stepNumber={index + 1} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectSection({
  project,
  activeSessionId,
  expanded,
  onToggle,
  onSelectSession,
}: {
  project: DemoProject;
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
        <span>{project.name}</span>
        <span className="project-count">{project.sessions.length}</span>
      </button>
      {expanded && (
        <div className="project-sessions">
          {project.sessions.map((session) => (
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
  activeSessionId,
  expandedProjects,
  onToggleProject,
  onSelectSession,
}: {
  activeSessionId: string;
  expandedProjects: ReadonlySet<string>;
  onToggleProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
}) {
  return (
    <aside className="sidebar" aria-label="Проекты и сессии">
      <div className="brand-lockup">
        <div className="brand-mark"><Icon name="brand" size={20} /></div>
        <span>smys<span className="brand-period">.</span></span>
        <span className="brand-edition">АГЕНТ</span>
      </div>

      <button className="workspace-select" type="button" disabled>
        <span className="workspace-avatar">S</span>
        <span className="workspace-copy"><strong>Личное пространство</strong><small>Локальная среда</small></span>
        <span className="workspace-caret">⌄</span>
      </button>

      <div className="sidebar-toolbar">
        <span className="sidebar-label">РАБОЧЕЕ ПРОСТРАНСТВО</span>
        <button type="button" className="new-chat-button" disabled><Icon name="plus" size={15} /><span>Новый чат</span><kbd>⌘ K</kbd></button>
      </div>

      <div className="projects-heading"><span>ПРОЕКТЫ</span><button type="button" aria-label="Добавить проект" disabled><Icon name="plus" size={14} /></button></div>
      <nav className="project-list" aria-label="Список проектов">
        {demoWorkspace.projects.map((project) => (
          <ProjectSection
            key={project.id}
            project={project}
            activeSessionId={activeSessionId}
            expanded={expandedProjects.has(project.id)}
            onToggle={() => onToggleProject(project.id)}
            onSelectSession={onSelectSession}
          />
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="profile-avatar">D</div>
        <div className="profile-copy"><strong>Davy</strong><small>Демо-профиль</small></div>
        <span className="footer-local"><span />ЛОКАЛЬНО</span>
      </div>
    </aside>
  );
}

function Composer({ model }: { model: string }) {
  return (
    <footer className="composer-dock">
      <div className="composer">
        <textarea aria-label="Поле ввода сообщения" placeholder="Напишите сообщение…" readOnly rows={1} />
        <div className="composer-toolbar">
          <button className="composer-icon-button" type="button" aria-label="Прикрепить файл" disabled><Icon name="paperclip" size={16} /></button>
          <div className="composer-controls"><span className="composer-model">{model}</span><span>Только просмотр</span><button className="send-button" type="button" aria-label="Отправить сообщение" disabled><Icon name="send" size={15} /></button></div>
        </div>
      </div>
        <p className="composer-note">Статический макет · отправка сообщений недоступна</p>
    </footer>
  );
}

function findSession(sessionId: string): { project: DemoProject; session: DemoSession } | undefined {
  for (const project of demoWorkspace.projects) {
    const session = project.sessions.find((candidate) => candidate.id === sessionId);
    if (session) return { project, session };
  }
  return undefined;
}

export function App() {
  const firstSessionId = demoWorkspace.projects[0]?.sessions[0]?.id ?? "";
  const [activeSessionId, setActiveSessionId] = useState(firstSessionId);
  const [activeTab, setActiveTab] = useState<"chat" | "trajectory">("chat");
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(
    () => new Set(demoWorkspace.projects.map((project) => project.id)),
  );
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(mobileBreakpoint).matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(mobileBreakpoint).matches);
  const selected = findSession(activeSessionId) ?? findSession(firstSessionId);

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

  if (!selected) return null;

  const toggleProject = (projectId: string) => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const selectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    if (isMobile) setSidebarOpen(false);
  };

  const className = `app-shell ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}${isMobile ? " app-mobile" : ""}`;

  return (
    <div className={className}>
      <Sidebar
        activeSessionId={activeSessionId}
        expandedProjects={expandedProjects}
        onToggleProject={toggleProject}
        onSelectSession={selectSession}
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
            <div className="breadcrumbs"><span>{selected.project.name}</span><span className="breadcrumb-slash">/</span><strong>{selected.session.title}</strong></div>
          </div>
          <span className="demo-indicator"><span />DEMO</span>
        </header>

        <section className="session-header">
          <div className="view-tabs" role="tablist" aria-label="Представление сессии">
            <button id="tab-chat" role="tab" aria-selected={activeTab === "chat"} aria-controls="session-panel" type="button" onClick={() => setActiveTab("chat")}>
              <Icon name="chat" size={15} />Чат
            </button>
            <button id="tab-trajectory" role="tab" aria-selected={activeTab === "trajectory"} aria-controls="session-panel" type="button" onClick={() => setActiveTab("trajectory")}>
              <Icon name="spark" size={15} />Траектория
            </button>
          </div>
        </section>

        <section
          className="timeline-viewport"
          id="session-panel"
          role="tabpanel"
          aria-labelledby={activeTab === "chat" ? "tab-chat" : "tab-trajectory"}
        >
          {activeTab === "chat" ? <ChatTimeline session={selected.session} /> : <Trajectory session={selected.session} />}
        </section>

        <Composer model={selected.session.model} />
      </main>
    </div>
  );
}
