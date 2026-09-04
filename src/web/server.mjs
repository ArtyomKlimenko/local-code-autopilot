import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RunFeed } from "./feed.mjs";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const aiRoot = resolve(process.env.LOCAL_AI_ROOT || "C:\\LocalAI");
const stateRoot = resolve(process.env.LOCAL_CODE_WEB_STATE || join(aiRoot, "state", "web"));
const scanRoot = resolve(process.env.LOCAL_CODE_PROJECTS_ROOT || process.cwd());
const port = Number(process.env.LOCAL_CODE_WEB_PORT || 8766);
const token = randomBytes(24).toString("hex");
const registryPath = join(stateRoot, "projects.json");
const launcher = join(aiRoot, "launcher", "local-code.ps1");
const wrapper = join(aiRoot, "autopilot", "local-autopilot.ps1");
const supervisor = join(aiRoot, "autopilot", "supervisor.mjs");
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const ssh = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
mkdirSync(stateRoot, { recursive: true });
const registry = json(registryPath, []);
const feeds = new Map();
let mutationBusy = false;
let diagnostic = null;
let hardware = [];
let runtime = { online: false, gpuVerified: false, context: null, updatedAt: null };
let runtimeBusy = false;
const psPrefix = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];

function text(path, maxBytes = 256000) {
  try {
    const size = statSync(path).size;
    if (size > maxBytes) return readTail(path, maxBytes);
    return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch { return ""; }
}
function json(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; }
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(temp, path);
}
function readTail(path, limit = 48000) {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    const bytes = Buffer.alloc(Math.min(size, limit));
    try { readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); } finally { closeSync(fd); }
    return bytes.toString("utf8");
  } catch { return ""; }
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function failure(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function projectFile(config, key, fallback) {
  const path = resolve(config.projectRoot, config[key] || fallback);
  const rel = relative(resolve(config.projectRoot), path);
  if (rel.startsWith("..") || isAbsolute(rel)) failure("Control file is outside the local project: " + key);
  return path;
}
function register(path) {
  if (!isAbsolute(path)) failure("Укажите полный путь к локальной папке.");
  const configPath = path.endsWith(".json") ? resolve(path) : join(resolve(path), ".agent", "autopilot.json");
  const config = json(configPath);
  if (!config?.projectRoot || !config.remoteHost || !config.runDirectory) failure("В папке нет корректного .agent/autopilot.json");
  for (const [key, fallback] of Object.entries({ goalFile: ".agent/GOAL.md", planFile: "PLAN.md", tasksFile: ".agent/tasks.json", stateFile: ".agent/state.json" })) projectFile(config, key, fallback);
  const id = createHash("sha256").update(configPath.toLowerCase()).digest("hex").slice(0, 16);
  if (!registry.some(item => item.id === id)) {
    registry.push({ id, configPath });
    atomic(registryPath, registry);
  }
  return id;
}
function lookup(id) {
  const record = registry.find(item => item.id === id);
  if (!record) failure("Задача не найдена.", 404);
  const config = json(record.configPath);
  if (!config) failure("Файл конфигурации недоступен.", 404);
  return { ...record, config };
}
function runsFor(config) {
  try {
    return readdirSync(config.runDirectory).filter(name => name.endsWith(".rpc.jsonl")).sort().reverse().map(name => {
      const stat = statSync(join(config.runDirectory, name));
      return { name, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
    });
  } catch { return []; }
}
function projectPlanning(config, definitions) {
  if (!definitions.tasks.some(task => task.canManagePlan === true || task.kind === "planner")) return null;
  const empty = { phase: "empty", tasks: [], summary: "", revision: null, goalHash: null };
  let goalHash;
  try {
    // Preserve BOM and newlines to match plan-store's raw UTF-8 goal digest.
    goalHash = createHash("sha256").update(readFileSync(projectFile(config, "goalFile", ".agent/GOAL.md"), "utf8")).digest("hex");
  } catch { return empty; }
  const directory = join(config.projectRoot, ".agent", "planning");
  const current = value => value?.goalHash === goalHash && Array.isArray(value.tasks)
    && typeof value.summary === "string" && typeof value.revision === "string" ? value : null;
  const draft = current(json(join(directory, "draft.json")));
  const proposal = current(json(join(directory, "proposal.json")));
  const plan = draft || proposal;
  if (!plan) return { ...empty, goalHash };
  return {
    phase: proposal?.revision === plan.revision ? "review" : "draft",
    tasks: plan.tasks, summary: plan.summary, revision: plan.revision, goalHash,
  };
}
function projectSummary(id) {
  const { config } = lookup(id);
  const state = json(projectFile(config, "stateFile", ".agent/state.json"), { status: "ready", tasks: [] });
  const launch = json(join(config.projectRoot, ".agent", "web-launch.json"));
  const isRunning = alive(state.pid);
  const isLaunching = launch?.status === "starting" && alive(launch.pid);
  let status = state.status || "ready";
  if (["running", "reviewing", "planning", "starting"].includes(status) && !isRunning) status = "interrupted";
  if (isLaunching && !isRunning) status = launch.stopRequested ? "stopping" : "starting";
  if (isRunning && existsSync(join(config.runDirectory, "stop.request"))) status = "stopping";
  if (launch?.status === "error" && !isRunning) status = "error";
  const definitions = json(projectFile(config, "tasksFile", ".agent/tasks.json"), { tasks: [] });
  const planning = projectPlanning(config, definitions);
  const tasks = definitions.tasks.map(task => ({ ...task, ...(state.tasks || []).find(item => item.id === task.id) }));
  const currentTask = tasks.find(task => task.id === state.currentTaskId) || (state.tasks || []).find(task => task.id === state.currentTaskId) || null;
  return {
    id, name: config.displayName || definitions.projectName || basename(config.projectRoot),
    projectRoot: config.projectRoot, remoteHost: config.remoteHost, remoteCwd: config.remoteCwd,
    status, isRunning, isLaunching, currentTaskId: state.currentTaskId,
    updatedAt: state.updatedAt, lastMessage: launch?.status === "error" && !isRunning ? launch.error : state.lastMessage,
    done: tasks.filter(task => task.status === "done").length, total: tasks.length, tasks, currentTask,
    ...(planning ? { planning } : {}),
    model: config.model, thinking: config.thinking, contextWindow: config.contextWindow,
    contextHandoffTokens: config.contextHandoffTokens, sshKeyPath: config.sshKeyPath,
  };
}
function summaries(archived = false) {
  return registry.filter(item => Boolean(item.archived) === archived).flatMap(item => { try { return [projectSummary(item.id)]; } catch { return []; } });
}
function projectDetails(id) {
  const { config } = lookup(id);
  const info = projectSummary(id);
  const notes = json(join(config.projectRoot, ".agent", "web-notes.json"), []).map(note => ({
    ...note, ...json(join(config.projectRoot, ".agent", "web-receipts", note.id + ".json"), {}),
  }));
  const launch = json(join(config.projectRoot, ".agent", "web-launch.json"));
  return {
    ...info,
    goal: text(projectFile(config, "goalFile", ".agent/GOAL.md")),
    plan: text(projectFile(config, "planFile", "PLAN.md")),
    journal: text(projectFile(config, "journalFile", ".agent/journal.md")),
    userAction: text(projectFile(config, "userActionFile", ".agent/USER_ACTION_REQUIRED.md")),
    checkpoint: info.currentTaskId && /^[\w.-]+$/.test(info.currentTaskId) ? json(join(config.runDirectory, info.currentTaskId + ".checkpoint.json")) : null,
    runs: runsFor(config), notes,
    launchLog: launch?.logPath ? readTail(launch.logPath) : "",
    operation: launch,
  };
}
function assertStopped(id) {
  const info = projectSummary(id);
  if (info.isRunning || info.isLaunching) failure("Сначала остановите задачу.", 409);
}
function validateSettings(body) {
  if (!["low", "medium", "high"].includes(body.thinking)) failure("Неверный уровень размышления.");
  if (!Number.isInteger(body.contextWindow) || body.contextWindow < 8192 || body.contextWindow > 65536 || body.contextWindow % 1024) failure("Контекст: 8192–65536, кратно 1024.");
  if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(body.remoteHost || "")) failure("SSH-адрес должен иметь вид user@host.");
  if (!body.remoteCwd?.startsWith("/") || /[\0\r\n]/.test(body.remoteCwd)) failure("Укажите абсолютный Linux-путь.");
  if (!isAbsolute(body.sshKeyPath || "") || /[\0\r\n]/.test(body.sshKeyPath)) failure("Укажите полный путь к SSH-ключу.");
}
async function ps(args, options = {}) {
  return exec(powershell, [...psPrefix, ...args], { windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024, ...options });
}
function start(id) {
  if (summaries().some(item => item.isRunning || item.isLaunching)) failure("Уже выполняется задача. Для GPU доступен один запуск одновременно.", 409);
  const { config, configPath } = lookup(id);
  if (config.provider !== "local-code") failure("Этот интерфейс запускает только локальный provider local-code.");
  const logPath = join(stateRoot, "launch-" + id + "-" + Date.now() + ".log");
  const opPath = join(config.projectRoot, ".agent", "web-launch.json");
  // Use the existing launcher: it owns full GPU offload verification and cleanup.
  const fd = openSync(logPath, "a");
  const launchId = randomUUID();
  let child;
  try {
    child = spawn(process.execPath, [join(here, "launcher-helper.mjs"), powershell, wrapper, configPath, String(config.contextWindow || 24576), opPath, launchId], {
      cwd: config.projectRoot, detached: true, windowsHide: true, stdio: ["ignore", fd, fd],
      env: { ...process.env, LOCAL_AI_ROOT: aiRoot, LOCAL_AUTOPILOT_WEB_LAUNCH_ID: launchId },
    });
  } finally { closeSync(fd); }
  atomic(opPath, { launchId, status: "starting", pid: child.pid || null, logPath, startedAt: new Date().toISOString() });
  function finish(code, error) {
    const op = json(opPath);
    if (op?.launchId !== launchId) return;
    atomic(opPath, { ...op, status: error || code !== 0 ? "error" : "exited", exitCode: code, error: error || (code ? readTail(logPath, 3000) : null), endedAt: new Date().toISOString() });
  }
  child.once("error", error => finish(null, error.message));
  child.unref();
  return projectDetails(id);
}
async function stop(id) {
  const { config, configPath } = lookup(id);
  const opPath = join(config.projectRoot, ".agent", "web-launch.json");
  const op = json(opPath);
  if (op?.status === "starting") atomic(opPath, { ...op, stopRequested: true });
  await exec(process.execPath, [supervisor, "stop", configPath], { windowsHide: true, timeout: 10000 });
  return { accepted: true };
}
async function createProject(body) {
  validateSettings(body);
  if (!body.name?.trim() || !body.prompt?.trim()) failure("Заполните название и задачу.");
  if (!isAbsolute(body.projectRoot || "")) failure("Укажите полный путь локальной папки.");
  const root = resolve(body.projectRoot);
  if (existsSync(join(root, ".agent", "autopilot.json"))) failure("Здесь уже есть задача. Откройте её или выберите другую папку.", 409);
  const promptPath = join(stateRoot, "prompt-" + randomUUID() + ".md");
  writeFileSync(promptPath, body.prompt, "utf8");
  const name = (basename(root).replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 40) || "task") + "-" + createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 8);
  await ps([wrapper, "new", root, promptPath, "--remote", body.remoteHost + ":" + body.remoteCwd, "--name", name, "--ctx", String(body.contextWindow)], { timeout: 20000, env: { ...process.env, LOCAL_AI_ROOT: aiRoot, LOCAL_AUTOPILOT_SSH_KEY: body.sshKeyPath } });
  const id = register(root);
  const { config, configPath } = lookup(id);
  atomic(configPath, { ...config, displayName: body.name.trim(), thinking: body.thinking });
  return projectDetails(id);
}
async function updateProject(id, body) {
  assertStopped(id);
  const { config, configPath } = lookup(id);
  const next = { ...config, ...Object.fromEntries(["thinking", "contextWindow", "remoteHost", "remoteCwd", "sshKeyPath"].filter(key => key in body).map(key => [key, body[key]])) };
  validateSettings(next);
  next.contextHandoffTokens = Math.floor(next.contextWindow * 0.65);
  if (typeof body.goal === "string") {
    const tasks = json(projectFile(config, "tasksFile", ".agent/tasks.json"));
    if (!tasks?.tasks?.some(task => task.id === "0.1" && (task.canManagePlan || task.kind === "planner"))) failure("План уже создан. Используйте уточнение или создайте новую задачу.");
    writeFileSync(projectFile(config, "goalFile", ".agent/GOAL.md"), body.goal, "utf8");
  }
  atomic(configPath, next);
  return projectDetails(id);
}
function note(id, body) {
  const { config } = lookup(id);
  const value = String(body.message || "").trim();
  if (!value || value.length > 32000) failure("Уточнение должно содержать 1–32000 символов.");
  const path = join(config.projectRoot, ".agent", "web-notes.json");
  const notes = json(path, []);
  if (notes.reduce((sum, item) => sum + item.text.length, 0) + value.length > 16000) failure("Уточнения превысили 16000 символов. Сохраните большой новый запрос отдельной задачей.");
  notes.push({ id: randomUUID(), text: value, at: new Date().toISOString(), status: "pending" });
  atomic(path, notes);
  return { accepted: true, notes };
}
function quoteSh(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function archive(id, archived) {
  assertStopped(id);
  const record = registry.find(item => item.id === id);
  record.archived = archived;
  atomic(registryPath, registry);
  return { accepted: true };
}
function approveStep(id, body) {
  assertStopped(id);
  const { config } = lookup(id);
  const state = projectSummary(id);
  if (state.status !== "waiting-user" || state.currentTaskId !== body.taskId) failure("Этот шаг не ожидает разрешения.", 409);
  const path = projectFile(config, "tasksFile", ".agent/tasks.json");
  const document = json(path);
  const task = document.tasks.find(item => item.id === body.taskId);
  if (!task?.requiresUserApproval) failure("Разрешение уже записано.", 409);
  task.requiresUserApproval = false;
  atomic(path, document);
  const auditPath = join(config.projectRoot, ".agent", "web-approvals.json");
  atomic(auditPath, [...json(auditPath, []), { taskId: task.id, title: task.title, at: new Date().toISOString() }]);
  return projectDetails(id);
}
async function checkSsh(id) {
  const { config } = lookup(id);
  validateSettings(config);
  const result = await exec(ssh, ["-o", "IdentityAgent=none", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=6", "-i", config.sshKeyPath, config.remoteHost, "cd -- " + quoteSh(config.remoteCwd) + " && pwd && uname -s"], { windowsHide: true, timeout: 10000, maxBuffer: 10000 });
  return { ok: true, output: result.stdout.trim() };
}
async function refreshRuntime() {
  if (runtimeBusy) return;
  runtimeBusy = true;
  try {
    const results = await Promise.allSettled(["health", "props", "slots"].map(async endpoint => {
      const response = await fetch("http://127.0.0.1:8080/" + endpoint, { signal: AbortSignal.timeout(1200) });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    }));
    const health = results[0].status === "fulfilled" && results[0].value.status === "ok";
    const props = results[1].status === "fulfilled" ? results[1].value : {};
    const slots = results[2].status === "fulfilled" && Array.isArray(results[2].value) ? results[2].value : [];
    const modelPid = Number(text(join(aiRoot, "state", "llama-server.pid")).trim());
    const proof = json(join(aiRoot, "state", "gpu-proof.json"));
    let currentProof = false;
    if (health && Number.isInteger(modelPid) && modelPid > 0 && proof?.pid === modelPid) {
      try {
        const command = "Get-Process -Id " + modelPid + " | ForEach-Object { [pscustomobject]@{ Name=$_.ProcessName; Started=$_.StartTime.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress";
        const info = JSON.parse((await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 3000 })).stdout);
        currentProof = info.Name === "llama-server" && Math.abs(new Date(info.Started) - new Date(proof.processStartedAt)) < 2000;
      } catch {}
    }
    let log = "";
    try {
      if (currentProof && proof.errLog) {
        const path = proof.errLog;
        const fd = openSync(path, "r");
        const bytes = Buffer.alloc(Math.min(statSync(path).size, 160000));
        try { readSync(fd, bytes, 0, bytes.length, 0); } finally { closeSync(fd); }
        log = bytes.toString("utf8");
      }
    } catch {}
    const offload = log.match(/offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers\s+to\s+GPU/i);
    const full = Boolean(offload && offload[1] === offload[2] && /Vulkan.*(?:KV|cache)|(?:KV|cache).*Vulkan/i.test(log));
    const active = slots.find(slot => slot.is_processing);
    runtime = {
      online: health, gpuVerified: currentProof && full, hardware,
      offload: offload ? offload[1] + "/" + offload[2] : null,
      context: props.default_generation_settings?.n_ctx || props.n_ctx || null,
      promptTokens: active?.n_prompt_tokens ?? null, processing: Boolean(active),
      model: "Ornith 1.5 9B · Q4_K_M", backend: "llama.cpp / Vulkan",
      updatedAt: new Date().toISOString(), diagnostic,
    };
  } finally { runtimeBusy = false; }
}
function runDoctor() {
  if (diagnostic?.status === "running") failure("Диагностика уже выполняется.", 409);
  diagnostic = { status: "running", output: "", startedAt: new Date().toISOString() };
  const child = spawn(powershell, [...psPrefix, launcher, "doctor"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  const append = chunk => { diagnostic.output = (diagnostic.output + chunk).slice(-40000); };
  child.stdout.on("data", append); child.stderr.on("data", append);
  child.once("error", error => { diagnostic = { ...diagnostic, status: "error", output: error.message }; });
  child.once("exit", code => { diagnostic = { ...diagnostic, status: code === 0 ? "done" : "error", exitCode: code }; });
  return { accepted: true };
}
function getFeed(config, run) {
  if (!run || !/^[\w.-]+\.rpc\.jsonl$/.test(run)) return null;
  const path = join(config.runDirectory, run);
  if (!existsSync(path)) return null;
  if (!feeds.has(path)) {
    if (feeds.size >= 8) feeds.delete(feeds.keys().next().value);
    const feed = new RunFeed(path, run);
    feed.poll();
    feeds.set(path, feed);
  }
  return feeds.get(path);
}
function events(req, res, id, selectedRun) {
  const { config } = lookup(id);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  let previousRun = null;
  let previousState = "";
  let previousRevision = -1;
  let ticks = 0;
  const send = value => {
    if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); return; }
    res.write("data: " + JSON.stringify(value) + "\n\n");
  };
  const tick = () => {
    try {
      const detail = projectDetails(id);
      const run = selectedRun || detail.runs[0]?.name || null;
      const feed = getFeed(config, run);
      feed?.poll();
      if (run !== previousRun || previousRevision < 0) {
        send({ type: "feed", ...feed?.snapshot(), entries: feed?.entries || [], run });
        previousRun = run;
      } else if (feed && feed.revision !== previousRevision) {
        send({ type: "patch", run, phase: feed.phase, updatedAt: feed.updatedAt, entries: feed.entries.filter(entry => entry.revision > previousRevision) });
      }
      previousRevision = feed?.revision || 0;
      const stateText = JSON.stringify(detail);
      if (stateText !== previousState) { send({ type: "project", project: detail }); previousState = stateText; }
      if (ticks++ % 3 === 0) send({ type: "runtime", runtime });
    } catch (error) { send({ type: "error", message: error.message }); }
  };
  tick();
  const timer = setInterval(tick, 1000);
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15000);
  req.once("close", () => { clearInterval(timer); clearInterval(heartbeat); });
}
function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let value = "";
  req.setEncoding("utf8");
  for await (const part of req) {
    value += part.toString("utf8");
    if (Buffer.byteLength(value) > 1024 * 1024) failure("Слишком большой запрос.", 413);
  }
  try { return JSON.parse(value || "{}"); } catch { failure("Некорректный JSON."); }
}
function trusted(req) {
  const allowed = ["127.0.0.1:" + port, "localhost:" + port];
  if (!allowed.includes(req.headers.host)) return false;
  if (req.headers.origin && !allowed.map(host => "http://" + host).includes(req.headers.origin)) return false;
  return true;
}
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  try {
    if (!trusted(req)) return sendJson(res, 403, { error: "Local origin required." });
    const url = new URL(req.url, "http://127.0.0.1:" + port);
    const path = url.pathname;
    if (req.method === "GET") {
      if (path === "/api/bootstrap") return sendJson(res, 200, { token, projects: summaries(), runtime, defaults: { projectRoot: scanRoot, aiRoot, remoteHost: summaries()[0]?.remoteHost || "", remoteCwd: summaries()[0]?.remoteCwd || "", sshKeyPath: join(process.env.USERPROFILE || "", ".ssh", "id_ed25519"), thinking: "high", contextWindow: 24576 } });
      if (path === "/api/projects") return sendJson(res, 200, summaries());
      if (path === "/api/archive") return sendJson(res, 200, summaries(true));
      if (path === "/api/runtime") return sendJson(res, 200, { ...runtime, diagnostic });
      const match = path.match(/^\/api\/projects\/([a-f0-9]{16})(\/events)?$/);
      if (match) {
        if (match[2]) return events(req, res, match[1], url.searchParams.get("run"));
        return sendJson(res, 200, projectDetails(match[1]));
      }
      if (path.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });
      const file = resolve(here, "dist", "." + (path === "/" ? "/index.html" : decodeURIComponent(path)));
      if (relative(join(here, "dist"), file).startsWith("..") || !existsSync(file) || statSync(file).isDirectory()) return sendJson(res, 404, { error: "Not found" });
      const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" }[extname(file)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=3600" });
      return res.end(readFileSync(file));
    }
    if (!["POST", "PATCH"].includes(req.method)) return sendJson(res, 405, { error: "Method not allowed" });
    if (req.headers["x-local-code-token"] !== token) return sendJson(res, 403, { error: "Обновите страницу: токен сессии изменился." });
    if (mutationBusy) failure("Предыдущая операция ещё выполняется.", 409);
    mutationBusy = true;
    try {
      const data = await body(req);
      let result;
      const match = path.match(/^\/api\/projects\/([a-f0-9]{16})(?:\/(start|stop|notes|ssh|archive|restore|approve))?$/);
      if (path === "/api/projects" && req.method === "POST") result = await createProject(data);
      else if (path === "/api/import") {
        const id = register(data.path || "");
        registry.find(item => item.id === id).archived = false;
        atomic(registryPath, registry);
        result = projectDetails(id);
      }
      else if (path === "/api/doctor") result = runDoctor();
      else if (match) {
        const [, id, action] = match;
        if (action === "start") result = start(id);
        else if (action === "stop") result = await stop(id);
        else if (action === "notes") result = note(id, data);
        else if (action === "ssh") result = await checkSsh(id);
        else if (action === "archive") result = archive(id, true);
        else if (action === "restore") result = archive(id, false);
        else if (action === "approve") result = approveStep(id, data);
        else if (req.method === "PATCH") result = await updateProject(id, data);
        else failure("Not found", 404);
      } else failure("Not found", 404);
      sendJson(res, 200, result);
    } finally { mutationBusy = false; }
  } catch (error) {
    const message = error.stderr?.trim() || error.message;
    if (!res.headersSent) sendJson(res, error.status || 500, { error: message });
    else res.end();
  }
});

// Bounded discovery: only explicitly configured root and its immediate children.
for (const candidate of [scanRoot, ...(() => { try { return readdirSync(scanRoot, { withFileTypes: true }).filter(item => item.isDirectory() && !item.name.startsWith(".")).map(item => join(scanRoot, item.name)); } catch { return []; } })()]) {
  if (existsSync(join(candidate, ".agent", "autopilot.json"))) { try { register(candidate); } catch {} }
}
exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | Select-Object Name | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 10000 }).then(result => { const data = JSON.parse(result.stdout); hardware = (Array.isArray(data) ? data : [data]).map(item => item.Name); }).catch(() => {});
await refreshRuntime();
setInterval(refreshRuntime, 4000).unref();
setInterval(() => {
  for (const item of registry) {
    try {
      const { config } = lookup(item.id);
      const launch = json(join(config.projectRoot, ".agent", "web-launch.json"));
      if (launch?.stopRequested && launch.status === "starting" && alive(launch.pid)) {
        mkdirSync(config.runDirectory, { recursive: true });
        writeFileSync(join(config.runDirectory, "stop.request"), new Date().toISOString());
      }
    } catch {}
  }
}, 1000).unref();
server.listen(port, "127.0.0.1", () => {
  console.log("Local Code web: http://127.0.0.1:" + port);
  console.log("Registered projects: " + registry.length);
});
server.on("error", error => { console.error(error.message); process.exitCode = 1; });
