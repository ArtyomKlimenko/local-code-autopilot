import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Activity, Archive, ArrowDown, ArrowLeft, ArrowUp, Check, CheckCircle2, ChevronRight, Circle, CirclePause, Cpu, FileText, Folder, FolderOpen, History, ListChecks, LoaderCircle, Menu, MessageSquare, Monitor, MoreHorizontal, Network, PanelRight, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, Square, Terminal, TriangleAlert, X } from "lucide-preact";
import { CopyButton, Markdown, MessageRow } from "./message-row";
import "./style.css";

let csrf = "";
async function api(path, data, method = "POST") {
  const response = await fetch("/api" + path, data === undefined ? {} : { method, headers: { "Content-Type": "application/json", "X-Local-Code-Token": csrf }, body: JSON.stringify(data) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "HTTP " + response.status);
  return value;
}
const statuses = { ready: "Готова к запуску", stopped: "Остановлена", running: "В работе", reviewing: "Проверка", planning: "Планирование", complete: "Завершена", blocked: "Нужен ваш ответ", "waiting-user": "Нужно разрешение", failed: "Ошибка агента", error: "Ошибка запуска", starting: "Загрузка модели", stopping: "Останавливается", interrupted: "Запуск прерван" };
const phases = { thinking: "Обдумывает", answering: "Пишет ответ", tool: "Выполняет команду", settled: "Завершает проход", idle: "Ожидает" };
const roles = { worker: "Исполнитель", reviewer: "Проверяющий", planner: "Планировщик" };
function age(iso, now) {
  if (!iso) return "ещё нет событий";
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "только что";
  if (seconds < 60) return seconds + " сек. назад";
  if (seconds < 3600) return Math.floor(seconds / 60) + " мин. назад";
  if (seconds < 86400) return Math.floor(seconds / 3600) + " ч. назад";
  return Math.floor(seconds / 86400) + " дн. назад";
}
function runLabel(name) {
  const m = name?.match(/Z-(.+)-(worker|reviewer|planner)-a(\d+)/);
  return m ? m[1] + " · " + roles[m[2]] + " · проход " + m[3] : name;
}
function Status({ status }) { return <span class={"status-pill " + status}><span class="status-dot" />{statuses[status] || status}</span>; }
function IconButton({ icon: Icon, title, onClick, className = "", disabled }) { return <button type="button" class={"icon-button " + className} title={title} aria-label={title} onClick={onClick} disabled={disabled}><Icon size={18} /></button>; }
function Empty({ icon: Icon = MessageSquare, title, text, children }) { return <div class="empty"><Icon size={30} strokeWidth={1.4} /><h2>{title}</h2>{text && <p>{text}</p>}{children}</div>; }

function App() {
  const [projects, setProjects] = useState([]);
  const [defaults, setDefaults] = useState(null);
  const [selected, setSelected] = useState(localStorage.getItem("local-code-project") || "");
  const [project, setProject] = useState(null);
  const [runtime, setRuntime] = useState({});
  const [feed, setFeed] = useState({ entries: [] });
  const [run, setRun] = useState("");
  const [tab, setTab] = useState("activity");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [thinking, setThinking] = useState(localStorage.getItem("local-code-thinking") === "true");
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [note, setNote] = useState("");
  const [now, setNow] = useState(Date.now());
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef(null);
  const endRef = useRef(null);
  const ready = useRef(false);

  async function refresh() {
    const value = await api("/bootstrap");
    csrf = value.token;
    setProjects(value.projects); setDefaults(value.defaults); setRuntime(value.runtime);
    if (!selected || !value.projects.some(item => item.id === selected)) setSelected(value.projects[0]?.id || "");
    ready.current = true;
  }
  useEffect(() => { refresh().catch(error => setNotice({ error: true, text: error.message })); }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      if (!ready.current) return;
      api("/projects").then(setProjects).catch(() => {});
      api("/runtime").then(setRuntime).catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setProject(null); setFeed({ entries: [] }); setRun(""); setAutoScroll(true); setSidebarOpen(false);
    if (!selected) return;
    localStorage.setItem("local-code-project", selected);
    setTab("activity"); setNote(localStorage.getItem("local-code-draft-" + selected) || "");
  }, [selected]);
  useEffect(() => {
    if (!selected) return;
    setConnected(false);
    const events = new EventSource("/api/projects/" + selected + "/events" + (run ? "?run=" + encodeURIComponent(run) : ""));
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.onmessage = event => {
      const value = JSON.parse(event.data);
      if (value.type === "project") setProject(value.project);
      if (value.type === "feed") setFeed(value);
      if (value.type === "patch") setFeed(previous => {
        const changed = new Map(value.entries.map(entry => [entry.id, entry]));
        const entries = previous.entries.map(entry => changed.get(entry.id) || entry);
        const ids = new Set(entries.map(entry => entry.id));
        entries.push(...value.entries.filter(entry => !ids.has(entry.id)));
        return { ...previous, ...value, entries: entries.slice(-180) };
      });
      if (value.type === "runtime") setRuntime(value.runtime);
      if (value.type === "error") setNotice({ error: true, text: value.message });
    };
    return () => events.close();
  }, [selected, run]);
  useEffect(() => {
    if (autoScroll && tab === "activity") endRef.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [feed.entries, tab, autoScroll]);
  useEffect(() => { if (!notice || notice.error) return; const id = setTimeout(() => setNotice(null), 5000); return () => clearTimeout(id); }, [notice]);
  useEffect(() => {
    const handler = event => { if (event.key === "Escape") { setModal(null); setSidebarOpen(false); setInspectorOpen(false); } };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, []);
  async function action(fn, success) {
    setBusy(true);
    try { const result = await fn(); if (success) setNotice({ text: success }); return result; }
    catch (error) { setNotice({ error: true, text: error.message }); return null; }
    finally { setBusy(false); }
  }
  const active = Boolean(project?.isRunning || project?.isLaunching);
  const visibleProjects = projects.filter(item => item.name.toLowerCase().includes(search.toLowerCase()) || item.projectRoot.toLowerCase().includes(search.toLowerCase()));
  const currentTask = project?.currentTask;
  const planning = project?.planning;
  const planTasks = planning ? planning.tasks : project?.tasks || [];
  const entries = feed.entries.filter(entry => filter === "all" || (filter === "tools" ? entry.kind === "tool" : entry.kind === "error" || entry.status === "error"));
  const latest = !run;
  const activityLabel = active ? project.isLaunching && !project.isRunning ? "Проверки GPU и загрузка модели" : phases[feed.phase] || "В работе" : statuses[project?.status] || "Ожидает запуска";

  return <div class="app-shell">
    {sidebarOpen && <button class="drawer-shade" aria-label="Закрыть навигацию" onClick={() => setSidebarOpen(false)} />}
    <aside class={"sidebar " + (sidebarOpen ? "is-open" : "")}>
      <div class="brand"><span class="brand-mark">π</span><div><strong>Local Code</strong><span>Рабочее пространство</span></div><span class="local-tag">LOCAL</span></div>
      <button class="new-task" onClick={() => setModal("new")}><Plus size={17} />Новая задача</button>
      <div class="search"><Search size={15} /><input aria-label="Поиск задач" placeholder="Найти задачу" value={search} onInput={event => setSearch(event.currentTarget.value)} /></div>
      <div class="section-label"><span>ЗАДАЧИ</span><span>{projects.length}</span><IconButton icon={FolderOpen} title="Открыть существующую задачу" onClick={() => setModal("import")} /></div>
      <nav class="project-list">
        {visibleProjects.map(item => <button key={item.id} class={"project-item " + (item.id === selected ? "selected" : "")} onClick={() => setSelected(item.id)}>
          <span class={"project-dot " + item.status}>{item.status === "complete" ? <CheckCircle2 size={16} /> : item.isRunning || item.isLaunching ? <LoaderCircle class="spin" size={16} /> : <MessageSquare size={16} />}</span>
          <span class="project-item-text"><strong>{item.name}</strong><small>{statuses[item.status] || item.status}{!item.planning && <span>{item.done}/{item.total}</span>}</small></span>
        </button>)}
        {!visibleProjects.length && <p class="sidebar-empty">Задачи не найдены</p>}
      </nav>
      <button class="archive-nav" onClick={() => setModal("archive")}><Archive size={15} />Архив задач</button>
      <div class="sidebar-footer"><span class={"connection-led " + (runtime.online ? "on" : "")} /><div><strong>{runtime.online ? "Модель загружена" : "Модель не запущена"}</strong><small>Только локальный endpoint</small></div><IconButton icon={Settings2} title="Диагностика системы" onClick={() => setModal("diagnostics")} /></div>
    </aside>
    <main class="workspace">
      <header class="topbar">
        <IconButton className="mobile-menu" icon={Menu} title="Задачи" onClick={() => setSidebarOpen(true)} />
        <div class="project-heading"><div class="breadcrumb"><Folder size={13} /><span>{project?.remoteCwd || "Локальные задачи"}</span></div><h1>{project?.name || "Local Code"}</h1></div>
        {project && <div class="top-actions"><Status status={project.status} /><IconButton icon={PanelRight} title="Параметры задачи" onClick={() => setInspectorOpen(!inspectorOpen)} />
          {active ? <button class="button stop" disabled={busy || project.status === "stopping"} onClick={() => action(() => api("/projects/" + selected + "/stop", {}), "Остановка запрошена. Текущий проход завершится.")}><Square size={14} />Остановить</button> :
            <button class="button primary" disabled={busy || project.status === "complete" || (project.status === "waiting-user" && currentTask?.requiresUserApproval)} onClick={() => action(() => api("/projects/" + selected + "/start", {}))}><Play size={15} />{project.status === "ready" ? "Запустить" : "Продолжить"}</button>}
        </div>}
      </header>
      {notice && <div role={notice.error ? "alert" : "status"} class={"notice " + (notice.error ? "error" : "")}><span>{notice.text}</span><IconButton icon={X} title="Закрыть сообщение" onClick={() => setNotice(null)} /></div>}
      {!selected ? <Empty icon={FolderOpen} title="Ваши задачи" text="Создайте задачу или откройте существующую локальную папку."><button class="button primary" onClick={() => setModal("new")}><Plus size={16} />Новая задача</button></Empty> :
        !project ? <Empty icon={LoaderCircle} title="Открываем задачу" /> :
        <div class="workspace-body">
          <section class="main-panel">
            <div class="tabs" role="tablist">{[
              ["activity", Activity, "Ход работы"], ["plan", ListChecks, planning ? "Подготовка плана" : "План", planning ? planTasks.length || undefined : project.total], ["goal", FileText, "Задача"], ["journal", History, "Журнал"]
            ].map(([id, Icon, label, count]) => <button role="tab" aria-selected={tab === id} class={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon size={15} />{label}{count !== undefined && <span>{count}</span>}</button>)}</div>
            {project.userAction && project.status === "blocked" && <div class="user-action"><TriangleAlert size={18} /><div><strong>Агенту нужно ваше действие</strong><Markdown text={project.userAction} /></div></div>}
            {project.status === "waiting-user" && currentTask?.requiresUserApproval && <div class="user-action"><TriangleAlert size={18} /><div><strong>Разрешить шаг {currentTask.id}?</strong><p>{currentTask.scope}</p><button class="button" disabled={busy} onClick={() => action(async () => { setProject(await api("/projects/" + selected + "/approve", { taskId: currentTask.id })); }, "Разрешение сохранено. Можно продолжить задачу.")}><Check size={15} />Разрешить этот шаг</button></div></div>}
            {tab === "activity" && <>
              <div class="activity-status"><span class={"activity-orbit " + (active && latest ? "active" : "")}><Activity size={15} /></span><div><strong>{latest ? activityLabel : "История прохода"}</strong><span>{currentTask ? "Шаг " + currentTask.id + " · " + currentTask.title : "План будет создан при первом запуске"}</span></div><span class={"live-label " + (connected ? "online" : "")}>{connected ? "Подключено" : "Переподключение…"}</span></div>
              <div class="feed-toolbar"><select aria-label="История проходов" value={run} onChange={event => { setRun(event.currentTarget.value); setAutoScroll(true); }}><option value="">Последний проход</option>{project.runs.map(item => <option value={item.name}>{runLabel(item.name)}</option>)}</select><div class="segmented">{[["all", "Всё"], ["tools", "Команды"], ["errors", "Ошибки"]].map(([key, title]) => <button class={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{title}</button>)}</div><label class="thinking-toggle"><input type="checkbox" checked={thinking} onChange={event => { setThinking(event.currentTarget.checked); localStorage.setItem("local-code-thinking", event.currentTarget.checked); }} />Размышления</label></div>
              <div class="feed-scroll" ref={scrollRef} onScroll={event => { const el = event.currentTarget; setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}>
                <div class="feed-inner">
                  {feed.run && <div class="run-divider"><span>{runLabel(feed.run)}</span><span>{age(feed.updatedAt, now)}</span></div>}
                  {feed.truncated && <p class="muted tail-hint">Показан последний фрагмент прохода.</p>}
                  {entries.map(entry => <MessageRow key={entry.id} entry={entry} active={active && latest} showThinking={thinking} />)}
                  {!entries.length && <Empty icon={active ? LoaderCircle : Terminal} title={active ? "Агент запускается" : filter === "errors" ? "Ошибок в этом проходе нет" : "Готово к работе"} text={active ? "Проверяем локальную модель. Вывод запуска появится ниже." : project.runs.length ? "Выберите другой фильтр или проход." : "План и результаты появятся после запуска."} />}
                  {latest && project.launchLog && <details class="launch-log" open={project.isLaunching || project.status === "error"}><summary><Terminal size={14} />Журнал запуска модели</summary><pre>{project.launchLog}</pre></details>}
                  {latest && active && <div class="waiting"><span class="pulse" /><span>Последнее событие: {age(feed.updatedAt, now)}</span></div>}
                  <div ref={endRef} />
                </div>
              </div>
              {!autoScroll && <button class="jump-bottom" title="К последним событиям" onClick={() => { setAutoScroll(true); endRef.current?.scrollIntoView({ behavior: "smooth" }); }}><ArrowDown size={16} />К последним событиям</button>}
              <form class="composer" onSubmit={event => { event.preventDefault(); action(async () => { await api("/projects/" + selected + "/notes", { message: note }); setNote(""); localStorage.removeItem("local-code-draft-" + selected); }, active ? "Уточнение сохранено и передано в очередь агента." : "Уточнение сохранено для продолжения задачи."); }}>
                <textarea aria-label="Уточнение агенту" placeholder={active ? "Уточнить задачу агенту…" : "Уточнение для следующего запуска…"} value={note} onInput={event => { setNote(event.currentTarget.value); localStorage.setItem("local-code-draft-" + selected, event.currentTarget.value); }} rows={2} />
                <div class="composer-footer"><span><Monitor size={13} />{project.model}<span class="divider">·</span>{project.thinking}<span class="divider">·</span>{project.contextWindow / 1024}K</span><button type="submit" class="send-button" disabled={busy || !note.trim()} aria-label="Отправить уточнение" title="Отправить уточнение"><ArrowUp size={18} /></button></div>
                {project.notes.length > 0 && <details class="notes-history"><summary>Уточнения · {project.notes.length}</summary>{project.notes.map(item => <div><span>{new Date(item.at).toLocaleString("ru-RU")} · {({ pending: "Ожидает", queued: "В очереди Pi", included: "Включено в контекст", delivered: "Получено агентом" })[item.status] || item.status}</span><p>{item.text}</p></div>)}</details>}
              </form>
            </>}
            {tab === "plan" && <div class="document-scroll">
              <div class="document-header"><div><h2>{planning ? "Подготовка плана" : "План выполнения"}</h2><p>{planning
                ? planning.phase === "empty" ? "Агент составляет план; этап 0.1 служебный" : (planning.phase === "review" ? "На проверке" : "Черновик, ещё не принят") + " · Шагов: " + planTasks.length
                : `${project.done} из ${project.total} шагов завершено`}</p></div>{!planning && <CopyButton text={project.plan} label="Копировать план" />}</div>
              {planning?.summary && <Markdown text={planning.summary} />}
              {!planning && <div class="progress-track"><span style={{ width: (project.total ? project.done / project.total * 100 : 0) + "%" }} /></div>}
              <div class="task-list">{planTasks.map(task => <details key={(planning ? "draft-" : "task-") + task.id} class={"task-step " + (planning ? "pending" : task.status)} open={!planning && task.id === project.currentTaskId}>
                <summary>{!planning && task.status === "done" ? <CheckCircle2 size={18} /> : !planning && task.status === "running" && active ? <LoaderCircle size={18} class="spin" /> : <Circle size={18} />}<span class="task-id">{task.id}</span><strong>{task.title}</strong><ChevronRight size={15} /></summary>
                <div><p>{task.scope}</p><h3>Критерии результата</h3><ul>{task.acceptance?.map(item => <li>{item}</li>)}</ul>{!planning && task.lastIssues?.length > 0 && <div class="task-issues"><h3>Последние замечания</h3>{task.lastIssues.map(item => <p>{item}</p>)}</div>}{planning
                  ? task.requiresUserApproval && <small>Потребуется разрешение пользователя</small>
                  : <small>Проходов: {task.attempts || 0}{task.requiresUserApproval ? " · Требуется действие пользователя" : ""}</small>}</div>
              </details>)}</div>
              {planning ? planning.revision && <details class="raw-plan"><summary>Данные локального плана</summary><div class="path-label">Ревизия</div><div class="path-value"><code>{planning.revision}</code><CopyButton text={planning.revision} /></div><div class="path-label">SHA-256 задачи</div><div class="path-value"><code>{planning.goalHash}</code><CopyButton text={planning.goalHash} /></div></details>
                : <details class="raw-plan"><summary>Полный текст плана</summary><Markdown text={project.plan} /></details>}
            </div>}
            {tab === "goal" && <div class="document-scroll"><div class="document-header"><div><h2>Исходная задача</h2><p>Локальная папка: {project.projectRoot}</p></div><button class="button" disabled={active || !project.tasks.some(task => task.id === "0.1" && task.canManagePlan)} onClick={() => setModal("goal")}><Settings2 size={15} />Редактировать</button></div><Markdown text={project.goal} /></div>}
            {tab === "journal" && <div class="document-scroll"><div class="document-header"><h2>Проверенные результаты</h2><CopyButton text={project.journal} /></div>{project.journal ? <Markdown text={project.journal} /> : <Empty icon={History} title="Результатов пока нет" text="Здесь появятся итоги шагов после проверки." />}</div>}
          </section>
          <aside class={"inspector " + (inspectorOpen ? "is-open" : "")}>
            <div class="inspector-title"><span>ПАРАМЕТРЫ ЗАДАЧИ</span><IconButton icon={X} className="inspector-close" title="Закрыть параметры" onClick={() => setInspectorOpen(false)} /></div>
            <div class="inspector-section"><div class="inspector-label"><Cpu size={15} />Модель<IconButton icon={Settings2} title="Изменить настройки" disabled={active} onClick={() => setModal("settings")} /></div><strong class="model-name">Ornith 1.5 <span>9B</span></strong><p class="muted">Abliterated · Q4_K_M</p><div class="key-value"><span>Вычисления</span><strong class={runtime.gpuVerified ? "green" : "muted"}>{runtime.gpuVerified ? "GPU · Vulkan" : runtime.online ? "Проверка GPU" : "Не запущены"}</strong></div><div class="key-value"><span>Размышления</span><strong>{project.thinking}</strong></div><div class="key-value"><span>Контекст</span><strong>{project.contextWindow / 1024}K</strong></div><div class="key-value"><span>Передача сессии</span><strong>{Math.round(project.contextHandoffTokens / project.contextWindow * 100)}%</strong></div>{runtime.promptTokens !== null && runtime.promptTokens !== undefined && active && <><div class="progress-track context"><span style={{ width: Math.min(100, runtime.promptTokens / project.contextWindow * 100) + "%" }} /></div><p class="muted small">{runtime.promptTokens.toLocaleString()} / {project.contextWindow.toLocaleString()} токенов</p></>}</div>
            <div class="inspector-section"><div class="inspector-label"><Network size={15} />Среда выполнения<IconButton icon={RefreshCw} title="Проверить SSH" disabled={busy} onClick={() => action(async () => { const result = await api("/projects/" + selected + "/ssh", {}); setNotice({ text: "SSH доступен: " + result.output.replace("\n", " · ") }); })} /></div><div class="remote-label"><span class="debian-dot" />Debian VM</div><div class="path-label">SSH</div><div class="path-value"><code>{project.remoteHost}</code><CopyButton text={project.remoteHost} /></div><div class="path-label">Код на VM</div><div class="path-value"><code>{project.remoteCwd}</code><CopyButton text={project.remoteCwd} /></div><div class="path-label">План и состояние на Windows</div><div class="path-value"><code>{project.projectRoot}</code><CopyButton text={project.projectRoot} /></div></div>
            <div class="inspector-section"><div class="inspector-label"><ListChecks size={15} />Текущий шаг</div>{currentTask ? <><strong class="current-title">{currentTask.id} · {currentTask.title}</strong><div class="key-value"><span>Проход</span><strong>{currentTask.attempts || 0}</strong></div><div class="key-value"><span>Роль</span><strong>{roles[project.checkpoint?.role] || "Исполнитель"}</strong></div>{currentTask.lastIssues?.length > 0 && <details class="issues"><summary>Последнее замечание</summary><p>{currentTask.lastIssues.join("\n")}</p></details>}</> : <p class="muted">Пока не выбран</p>}</div>
            <button class="archive-nav" disabled={active || busy} onClick={() => action(async () => { await api("/projects/" + selected + "/archive", {}); const items = await api("/projects"); setProjects(items); setSelected(items[0]?.id || ""); }, "Задача перенесена в архив. Файлы сохранены.")}><Archive size={14} />В архив</button>
            <div class="inspector-bottom"><ShieldCheck size={16} /><span>127.0.0.1 · локальная модель</span></div>
          </aside>
        </div>}
    </main>
    {modal && <Modal mode={modal} project={project} defaults={defaults} runtime={runtime} busy={busy} onClose={() => setModal(null)} onSubmit={data => action(async () => {
      let result;
      if (modal === "new") result = await api("/projects", data);
      if (modal === "import") result = await api("/import", data);
      if (modal === "archive") { await api("/projects/" + data.id + "/restore", {}); result = await api("/projects/" + data.id); }
      if (["settings", "goal"].includes(modal)) result = await api("/projects/" + selected, data, "PATCH");
      if (result) { setProjects(await api("/projects")); setSelected(result.id); setProject(result); setModal(null); }
    })} onDoctor={() => action(() => api("/doctor", {}))} />}
  </div>;
}

function Modal({ mode, project, defaults, runtime, busy, onClose, onSubmit, onDoctor }) {
  const initial = { ...(defaults || {}), ...(mode === "new" ? {} : project || {}), name: "", prompt: "", path: "" };
  if (mode === "new") initial.projectRoot = (defaults?.projectRoot || "C:\\work") + "\\new-task";
  const [form, setForm] = useState(initial);
  const [archived, setArchived] = useState([]);
  useEffect(() => { if (mode === "archive") api("/archive").then(setArchived); }, [mode]);
  const field = key => ({ value: form[key] ?? "", onInput: event => setForm({ ...form, [key]: event.currentTarget.value }) });
  const settings = mode === "new" || mode === "settings";
  const title = { new: "Новая задача", import: "Открыть задачу", settings: "Параметры запуска", goal: "Редактировать задачу", diagnostics: "Локальная система", archive: "Архив задач" }[mode];
  return <div class="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section class={"modal " + (["new", "goal"].includes(mode) ? "wide" : "")} role="dialog" aria-modal="true" aria-label={title}>
    <header><h2>{title}</h2><IconButton icon={X} title="Закрыть" onClick={onClose} /></header>
    {mode === "archive" ? <div class="modal-content">{archived.length ? archived.map(item => <div class="archive-row"><div><strong>{item.name}</strong><p>{item.projectRoot}</p></div><button class="button" disabled={busy} onClick={() => onSubmit({ id: item.id })}>Восстановить</button></div>) : <Empty icon={Archive} title="Архив пуст" />}</div> : mode === "diagnostics" ? <div class="modal-content"><div class="diagnostic-summary"><Cpu size={24} /><div><strong>{runtime.model}</strong><p>{runtime.backend}</p></div><Status status={runtime.online ? "running" : "stopped"} /></div>{runtime.hardware?.map(name => <p>{name}</p>)}<div class="key-value"><span>Полный offload</span><strong>{runtime.gpuVerified ? runtime.offload + " · подтверждён" : "Не подтверждён в активном процессе"}</strong></div><button class="button" disabled={busy || runtime.diagnostic?.status === "running"} onClick={onDoctor}><RefreshCw size={15} class={runtime.diagnostic?.status === "running" ? "spin" : ""} />Проверить систему</button>{runtime.diagnostic && <pre class="diagnostic-output">{runtime.diagnostic.output || "Диагностика выполняется…"}</pre>}</div> :
      <form onSubmit={event => { event.preventDefault(); onSubmit({ ...form, contextWindow: Number(form.contextWindow) }); }}>
        <div class="modal-content">
          {mode === "new" && <><label>Название<input required autoFocus placeholder="Например, новый модуль API" {...field("name")} /></label><label>Задача<textarea class="prompt-input" required rows={9} placeholder="Какой результат нужен, где работать и как проверить готовность…" {...field("prompt")} /></label><label>Локальная папка задачи<input required {...field("projectRoot")} /></label></>}
          {mode === "import" && <label>Локальная папка с .agent/autopilot.json<input required autoFocus placeholder="C:\work\my-project" {...field("path")} /></label>}
          {mode === "goal" && <label>GOAL.md<textarea class="goal-input" rows={18} {...field("goal")} /></label>}
          {settings && <><div class="form-section"><Network size={15} /><strong>Debian VM</strong></div><div class="form-grid"><label>SSH-адрес<input required placeholder="user@172.20.184.150" {...field("remoteHost")} /></label><label>Папка кода на VM<input required placeholder="/home/user/project" {...field("remoteCwd")} /></label></div><label>Путь к SSH-ключу<input required {...field("sshKeyPath")} /></label><div class="form-grid"><label>Контекст<select value={form.contextWindow} onChange={event => setForm({ ...form, contextWindow: Number(event.currentTarget.value) })}>{[8192, 16384, 24576, 32768, 49152, 65536].map(n => <option value={n}>{n / 1024}K{n === 24576 ? " · текущий профиль" : ""}</option>)}</select></label><label>Размышления<select {...field("thinking")}><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label></div></>}
        </div><footer><button type="button" class="button" onClick={onClose}>Отмена</button><button class="button primary" disabled={busy}>{busy ? <LoaderCircle size={16} class="spin" /> : mode === "new" ? <Plus size={16} /> : <Check size={16} />}{mode === "new" ? "Создать задачу" : mode === "import" ? "Открыть" : "Сохранить"}</button></footer>
      </form>}
  </section></div>;
}

render(<App />, document.getElementById("app"));
