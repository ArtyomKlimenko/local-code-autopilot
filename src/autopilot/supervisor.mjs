import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const [, , command = "start", configArg] = process.argv;

function fail(message, code = 1) {
  process.stderr.write(`[autopilot] ERROR: ${message}\n`);
  process.exit(code);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function resolveFromProject(projectRoot, value) {
  return isAbsolute(value) ? value : resolve(projectRoot, value);
}

function now() {
  return new Date().toISOString();
}

function clip(value, max = 260) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function numericLimit(value) {
  if (value === null || value === undefined || value === false) return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}

function contextHandoffLimit(config) {
  const contextWindow = Number(config.contextWindow) || 24576;
  const configured = Number(config.contextHandoffTokens);
  if (Number.isFinite(configured) && configured >= 4096 && configured < contextWindow) {
    return Math.floor(configured);
  }
  // Leave enough room for a final tool result; do not rely on model-generated compaction.
  return Math.max(4096, Math.floor(contextWindow * 0.65));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (!configArg) fail("usage: supervisor.mjs start|status|stop <config.json>");
const configPath = resolve(configArg);
if (!existsSync(configPath)) fail(`config not found: ${configPath}`);
const config = readJson(configPath);
const projectRoot = resolve(config.projectRoot);
const tasksPath = resolveFromProject(projectRoot, config.tasksFile);
const goalPath = resolveFromProject(projectRoot, config.goalFile);
const planPath = resolveFromProject(projectRoot, config.planFile);
const statePath = resolveFromProject(projectRoot, config.stateFile);
const journalPath = resolveFromProject(projectRoot, config.journalFile);
const userActionPath = resolveFromProject(projectRoot, config.userActionFile || ".agent/USER_ACTION_REQUIRED.md");
const runDirectory = resolve(config.runDirectory);
const lockPath = join(runDirectory, "supervisor.lock.json");
const stopPath = join(runDirectory, "stop.request");
const remoteHost = config.remoteHost;
const remoteCwd = config.remoteCwd;
const sshKeyPath = config.sshKeyPath;
if (!remoteHost || !remoteCwd || !sshKeyPath) {
  fail("autopilot config requires remoteHost, remoteCwd, and sshKeyPath");
}

function loadState(tasksDocument) {
  if (existsSync(statePath)) {
    const loaded = readJson(statePath);
    const known = new Map(loaded.tasks?.map((item) => [item.id, item]) ?? []);
    loaded.tasks = tasksDocument.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: known.get(task.id)?.status ?? task.status ?? "pending",
      attempts: known.get(task.id)?.attempts ?? 0,
      lastIssues: known.get(task.id)?.lastIssues ?? [],
      completedAt: known.get(task.id)?.completedAt ?? null,
    }));
    return loaded;
  }
  return {
    version: 1,
    project: tasksDocument.projectName,
    status: "ready",
    currentTaskId: null,
    pid: null,
    startedAt: null,
    updatedAt: now(),
    lastMessage: "Ready to start",
    tasks: tasksDocument.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status ?? "pending",
      attempts: 0,
      lastIssues: [],
      completedAt: task.status === "done" ? now() : null,
    })),
  };
}

function saveState(state, message) {
  state.updatedAt = now();
  if (message) state.lastMessage = message;
  atomicJson(statePath, state);
}

function reloadTasksIntoState(state) {
  tasksDocument = readJson(tasksPath);
  taskDefinitions = new Map(tasksDocument.tasks.map((task) => [task.id, task]));
  const known = new Map(state.tasks?.map((item) => [item.id, item]) ?? []);
  state.tasks = tasksDocument.tasks.map((task) => {
    const existing = known.get(task.id);
    return {
      id: task.id,
      title: task.title,
      status: existing?.status ?? task.status ?? "pending",
      attempts: existing?.attempts ?? 0,
      lastIssues: existing?.lastIssues ?? [],
      completedAt: existing?.completedAt ?? (task.status === "done" ? now() : null),
    };
  });
}

function showStatus() {
  if (!existsSync(statePath)) {
    process.stdout.write("[autopilot] No state yet.\n");
    return;
  }
  const state = readJson(statePath);
  process.stdout.write(`[autopilot] status=${state.status} current=${state.currentTaskId ?? "-"}\n`);
  process.stdout.write(`[autopilot] ${state.lastMessage ?? ""}\n`);
  for (const task of state.tasks ?? []) {
    process.stdout.write(`  ${task.id} ${task.status.padEnd(8)} attempts=${task.attempts} ${task.title}\n`);
  }
}

function activityFiles() {
  if (!existsSync(runDirectory)) return [];
  return readdirSync(runDirectory)
    .filter((name) => name.endsWith(".activity.jsonl"))
    .map((name) => {
      const path = join(runDirectory, name);
      const stat = statSync(path);
      return { path, name, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function formatActivityLine(line) {
  try {
    const event = JSON.parse(line);
    const time = event.at ? new Date(event.at).toLocaleTimeString() : "--:--:--";
    if (event.type === "tool_call") {
      return `[${time}] ${event.role ?? "agent"} ${event.taskId ?? "-"} tool ${event.tool}: ${clip(JSON.stringify(event.input ?? {}), 320)}`;
    }
    if (event.type === "result") {
      return `[${time}] ${event.role ?? "agent"} ${event.taskId ?? "-"} result: ${clip(JSON.stringify(event.result ?? {}), 500)}`;
    }
    return `[${time}] ${clip(line, 500)}`;
  } catch {
    return clip(line, 500);
  }
}

function showWatch() {
  process.stdout.write("[autopilot] Watching status and activity. Press Ctrl+C to close this view; it does not stop the agent.\n");
  let currentFile = null;
  let offset = 0;
  let lastStatusText = "";

  const tick = () => {
    if (existsSync(statePath)) {
      const state = readJson(statePath);
      const statusText = `[autopilot] status=${state.status} current=${state.currentTaskId ?? "-"} ${state.lastMessage ?? ""}`;
      if (statusText !== lastStatusText) {
        process.stdout.write(`${statusText}\n`);
        lastStatusText = statusText;
      }
    }

    const [latest] = activityFiles();
    if (!latest) return;
    if (latest.path !== currentFile) {
      currentFile = latest.path;
      offset = Math.max(0, latest.size - 8000);
      process.stdout.write(`[autopilot] tailing ${latest.name}\n`);
    }
    const stat = statSync(currentFile);
    if (stat.size < offset) offset = 0;
    if (stat.size === offset) return;

    const handle = readFileSync(currentFile).subarray(offset, stat.size).toString("utf8");
    offset = stat.size;
    for (const line of handle.split(/\r?\n/)) {
      if (line.trim()) process.stdout.write(`${formatActivityLine(line)}\n`);
    }
  };

  tick();
  const timer = setInterval(tick, 2000);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.stdout.write("\n[autopilot] Watch closed.\n");
    process.exit(0);
  });
}

if (command === "status") {
  showStatus();
  process.exit(0);
}

if (command === "watch") {
  showWatch();
  await new Promise(() => {});
}

if (command === "stop") {
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(stopPath, `${now()}\n`, "utf8");
  process.stdout.write("[autopilot] Stop requested. The active tool/model turn will be aborted.\n");
  process.exit(0);
}

if (command !== "start") fail(`unknown command: ${command}`);

for (const required of [tasksPath, goalPath, planPath, config.nodeExecutable, config.piCli, config.extension]) {
  if (!existsSync(required)) fail(`required file not found: ${required}`);
}

mkdirSync(runDirectory, { recursive: true });
mkdirSync(config.piSessionDirectory, { recursive: true });
if (existsSync(lockPath)) {
  const lock = readJson(lockPath);
  if (processAlive(Number(lock.pid))) fail(`another supervisor is running, pid=${lock.pid}`);
  rmSync(lockPath, { force: true });
}
rmSync(stopPath, { force: true });
atomicJson(lockPath, { pid: process.pid, startedAt: now(), configPath });

let tasksDocument = readJson(tasksPath);
let taskDefinitions = new Map(tasksDocument.tasks.map((task) => [task.id, task]));
const goal = readFileSync(goalPath, "utf8");
const state = loadState(tasksDocument);
state.status = "running";
state.pid = process.pid;
state.startedAt = state.startedAt ?? now();
for (const taskState of state.tasks) {
  if (taskState.status === "done") markPlanDone(taskState.id);
}
saveState(state, "Supervisor started");

let activeChild = null;
let interrupted = false;

function requestAbort(reason) {
  interrupted = true;
  if (activeChild?.stdin?.writable) {
    activeChild.stdin.write(`${JSON.stringify({ type: "clear_queue" })}\n`);
    activeChild.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
  }
  process.stdout.write(`[autopilot] abort requested: ${reason}\n`);
}

process.on("SIGINT", () => requestAbort("Ctrl+C"));
process.on("SIGTERM", () => requestAbort("process termination"));

function appendJournal(task, workerResult, reviewResult) {
  mkdirSync(dirname(journalPath), { recursive: true });
  if (!existsSync(journalPath)) {
    writeFileSync(journalPath, "# Autopilot journal\n\n", "utf8");
  }
  const lines = [
    `## ${task.id} - ${task.title}`,
    "",
    `Completed: ${now()}`,
    "",
    workerResult.summary,
    "",
    `Review: ${reviewResult.summary}`,
    "",
    `Changed files: ${workerResult.changedFiles.length ? workerResult.changedFiles.join(", ") : "none"}`,
    "",
    "Verification:",
    ...workerResult.verification.map((item) => `- ${item}`),
    "",
  ];
  appendFileSync(journalPath, `${lines.join("\n")}\n`, "utf8");
}

function markPlanDone(taskId) {
  const original = readFileSync(planPath, "utf8");
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^\\s*- \\[) \\](\\s+${escaped}\\b)`, "m");
  if (!pattern.test(original)) return false;
  const updated = original.replace(pattern, "$1x]$2");
  writeFileSync(planPath, updated, "utf8");
  return true;
}

function buildWorkerPrompt(task, attempt, previousIssues) {
  const checkpointPath = join(runDirectory, `${task.id}.checkpoint.json`);
  const checkpoint = existsSync(checkpointPath) ? readJson(checkpointPath) : null;
  const canManagePlan = task.kind === "planner" || task.canManagePlan === true;
  return [
    "You are a worker controlled by a local deterministic supervisor.",
    `Execute ONLY task ${task.id}: ${task.title}.`,
    canManagePlan
      ? "This is the bootstrap planning task. Read the goal, inspect the project, then replace PLAN.md and .agent/tasks.json with a small ordered implementation plan."
      : "Do not start, plan, or partially implement any later task.",
    canManagePlan
      ? "You may edit only PLAN.md and .agent/tasks.json for planning. Do not implement project changes in this task."
      : "Do not edit PLAN.md, .agent/tasks.json, .agent/state.json, or .agent/journal.md; the supervisor owns them.",
    "Do not read .agent/tasks.json or .agent/state.json; the assigned scope, acceptance criteria, and prior issues are already included below.",
    `All read/write/edit/bash tools already operate in ${remoteCwd} on ${remoteHost} through SSH. Never type ssh/scp yourself and never use Windows paths.`,
    "Do not read browser profile cache file bodies under multi-account/.cache; inspect only bounded directory structure and project code/config.",
    "Read .agent/GOAL.md first, then inspect only files needed for this task.",
    "Treat each command as a hypothesis. When the same command produces the same evidence, do not rerun it unchanged: explain what that evidence proves, then inspect a different bounded source or make a targeted repair.",
    `Task scope: ${task.scope}`,
    ...(task.knownContext?.length ? ["Known starting observations: verify them directly once, then do not repeat broad investigation:", ...task.knownContext.map((item) => `- ${item}`)] : []),
    "Acceptance criteria:",
    ...task.acceptance.map((item) => `- ${item}`),
    ...(canManagePlan ? [
      "Planning output rules:",
      "- PLAN.md must be a checklist of small task ids such as 1.1, 1.2, 1.3.",
      "- .agent/tasks.json must contain those same task ids and must not contain the bootstrap 0.1 task.",
      "- Each task must have title, status:\"pending\", scope, acceptance array, requiresUserApproval:false unless the step changes host networking, credentials, real browser login state, destructive data, or other explicitly risky state.",
      "- Keep tasks small enough that a reviewer can verify each one independently.",
      "- Put investigation, implementation, tests, deployment, and documentation into separate tasks when the goal is broad.",
    ] : []),
    `This is recovery pass ${attempt}. There is no attempt, tool-call, or wall-clock limit. The supervisor may rotate this session before its context overflows; persist concrete results in project files and the checkpoint so a fresh session can continue. Continue until the task is verified complete or blocked by a real external requirement.`,
    previousIssues.length ? "Issues from the previous rejected attempt:" : "There is no previous rejected attempt.",
    ...previousIssues.map((item) => `- ${item}`),
    checkpoint ? "Durable checkpoint from the previous pass (verify it; do not repeat completed work):" : "There is no durable checkpoint from an earlier pass.",
    ...(checkpoint ? [JSON.stringify(checkpoint, null, 2)] : []),
    "Work in small verified edits. Keep every command and its output bounded. To check a server, start it in the background, retain its PID, poll its health endpoint with a bounded client, then clean up that PID with a trap. A foreground `timeout` followed by curl only proves the server was killed; do not use that pattern as a health check.",
    "After a rejected pass, repair the listed issue first. Do not restart broad discovery or rewrite working parts.",
    "Do not merely describe intended work. Make the in-scope changes and run focused verification.",
    "If a real external dependency is missing (for example a proxy endpoint, an account login, model endpoint, or explicit approval), do not guess, fabricate configuration, or repeat discovery. Call request_user_action immediately with the smallest safe action the user must take. Never request secrets in chat, logs, or repository files.",
    "When verification passes, call finish_step. If your turn ends without it, the supervisor will continue the same session from its durable checkpoint.",
  ].join("\n");
}

function buildReviewPrompt(task, workerResult) {
  return [
    "You are an independent read-only reviewer in a fresh session.",
    `Review ONLY task ${task.id}: ${task.title}.`,
    "You may read files and run focused non-mutating tests. You must not write or edit files.",
    "Read .agent/GOAL.md and independently inspect the claimed changes.",
    "Do not read .agent/tasks.json or .agent/state.json; the complete assigned task is included below.",
    `Task scope: ${task.scope}`,
    "Acceptance criteria:",
    ...task.acceptance.map((item) => `- ${item}`),
    "Worker claim:",
    JSON.stringify(workerResult, null, 2),
    "Reject incomplete, untested, misplaced, unsafe, or out-of-scope work. Do not accept prose as evidence when a focused check is possible.",
    "Call finish_review with an explicit approved verdict and concrete issues. If your turn ends early, the supervisor will continue the same review session.",
  ].join("\n");
}

function buildRecoveryPlanPrompt(task, workerFailure) {
  return [
    "You are a read-only recovery planner for one stalled task.",
    `Replan ONLY task ${task.id}: ${task.title}.`,
    "The worker made no progress because it repeated a failed shell hypothesis. Do not implement, edit, write, or restart services.",
    "Inspect only the remote files and bounded test evidence needed to understand the failure.",
    "Return a small ordered list of independently verifiable replacement steps. Keep every step inside the original task scope and acceptance criteria; do not broaden access, credentials, host networking, or browser-login state.",
    "Do not include generic discovery loops. Each step needs a concrete observable acceptance criterion.",
    `Original scope: ${task.scope}`,
    "Original acceptance criteria:",
    ...task.acceptance.map((item) => `- ${item}`),
    "Recorded no-progress diagnosis:",
    `- ${workerFailure}`,
    "Call finish_replan with diagnosis and the replacement steps.",
  ].join("\n");
}

function applyRecoveryPlan(task, proposal) {
  if (proposal?.kind !== "replan" || !Array.isArray(proposal.steps) || proposal.steps.length === 0) {
    throw new Error(`recovery planner returned no usable steps for ${task.id}`);
  }
  const taskPosition = tasksDocument.tasks.findIndex((item) => item.id === task.id);
  if (taskPosition < 0) throw new Error(`cannot replan missing task ${task.id}`);

  const replacements = proposal.steps.map((step, index) => {
    const title = String(step?.title ?? "").trim();
    const scope = String(step?.scope ?? "").trim();
    const acceptance = Array.isArray(step?.acceptance)
      ? step.acceptance.map((item) => String(item).trim()).filter(Boolean)
      : [];
    if (!title || !scope || acceptance.length === 0) {
      throw new Error(`recovery planner produced an incomplete step for ${task.id}`);
    }
    return {
      id: `${task.id}.${index + 1}`,
      title,
      status: "pending",
      scope,
      acceptance,
      requiresUserApproval: Boolean(task.requiresUserApproval),
      replannedFrom: task.id,
      knownContext: [
        `Recovery diagnosis: ${String(proposal.diagnosis ?? "no-progress loop").trim()}`,
        "Do not repeat the previously stalled command unchanged; start from the focused scope and acceptance criteria below.",
      ],
    };
  });

  tasksDocument.tasks.splice(taskPosition, 1, ...replacements);
  taskDefinitions = new Map(tasksDocument.tasks.map((item) => [item.id, item]));
  atomicJson(tasksPath, tasksDocument);
  appendFileSync(planPath, [
    "",
    `## Recovery replan for ${task.id} - ${task.title}`,
    "",
    `Diagnosis: ${String(proposal.diagnosis ?? "no-progress loop").trim()}`,
    "",
    ...replacements.map((item) => `- [ ] ${item.id} ${item.title}`),
    "",
  ].join("\n"), "utf8");
  return replacements;
}

function extractAssistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function runPi({ role, task, attempt, prompt }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = `${stamp}-${task.id}-${role}-a${attempt}`;
  const resultFile = join(runDirectory, `${prefix}.result.json`);
  const activityFile = join(runDirectory, `${prefix}.activity.jsonl`);
  const rpcLog = join(runDirectory, `${prefix}.rpc.jsonl`);
  const stderrLog = join(runDirectory, `${prefix}.stderr.log`);
  rmSync(resultFile, { force: true });

  const finishTool = role === "reviewer"
    ? "finish_review"
    : role === "planner"
      ? "finish_replan"
      : "finish_step";
  const tools = role === "worker"
    ? `read,bash,edit,write,request_user_action,${finishTool}`
    : `read,bash,${finishTool}`;
  const systemPrompt = [
    `Autopilot role: ${role}. Assigned task: ${task.id}.`,
    "Never read, print, copy, encode, summarize, or inspect private SSH key contents. Use only the supplied key path with ssh -i.",
    "Never perform broad filesystem, dependency, cache, browser-profile, AppData, or root scans.",
    `Every read/write/edit/bash tool is already redirected to ${remoteCwd} on ${remoteHost}. Never invoke ssh/scp yourself and never use a Windows path.`,
    "Do not read browser profile cache file bodies under multi-account/.cache; inspect only bounded directory structure and project code/config.",
    "Do not run foreground servers or watchers as plain bash commands. For a server check: run it in the background, retain its PID, poll its health endpoint with a bounded client, and clean up that PID with a trap. Do not use bare pkill -f patterns. Treat an identical command and identical evidence as a failed hypothesis, not as a reason to retry it.",
    role === "planner"
      ? "You are read-only: do not edit files, start services, or make project changes. Return only a narrow recovery plan through finish_replan."
      : "VM project files and project-owned user services may be modified when the assigned task calls for it. Never change Windows host state, VirtualBox/host networking, VM firewall/networking, unrelated VM files, real browser-login profile data, or credentials.",
    `End only through ${finishTool} or request_user_action.`,
    role === "worker"
      ? "When an external prerequisite is missing, end through request_user_action rather than guessing or repeating inspection."
      : "",
  ].join(" ");

  const args = [
    config.piCli,
    "--offline",
    "--provider", config.provider,
    "--model", config.model,
    "--thinking", role === "worker" ? config.thinking : "medium",
    "--append-system-prompt", systemPrompt,
    "--tools", tools,
    "--session-dir", config.piSessionDirectory,
    "--name", `autopilot-${task.id}-${role}-a${attempt}`,
    "--no-extensions",
    "--extension", config.extension,
    "--no-skills",
    "--no-prompt-templates",
    "--approve",
    "--mode", "rpc",
  ];

  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: join(process.env.USERPROFILE, ".pi", "agent"),
    PI_CODING_AGENT_SESSION_DIR: config.piSessionDirectory,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    LLAMA_BASE_URL: "http://127.0.0.1:8080",
    LOCAL_CODE: "1",
    LOCAL_AUTOPILOT_ROLE: role,
    LOCAL_AUTOPILOT_TASK_ID: task.id,
    LOCAL_AUTOPILOT_RESULT_FILE: resultFile,
    LOCAL_AUTOPILOT_ACTIVITY_FILE: activityFile,
    LOCAL_AUTOPILOT_ACTION_FILE: userActionPath,
    LOCAL_AUTOPILOT_REMOTE_HOST: remoteHost,
    LOCAL_AUTOPILOT_REMOTE_CWD: remoteCwd,
    LOCAL_AUTOPILOT_SSH_KEY: sshKeyPath,
  };

  process.stdout.write(`\n[autopilot] ${task.id} ${role} attempt ${attempt}\n`);
  const child = spawn(config.nodeExecutable, args, {
    cwd: projectRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  activeChild = child;
  let settled = false;
  let exitCode = null;
  let abortReason = "";
  let toolCalls = 0;
  let compactions = 0;
  let settledWithoutResult = 0;
  let noProgressLoop = false;
  let lastAssistantText = "";
  const recentEvents = [];
  const changedFiles = new Set();
  const checkpointPath = join(runDirectory, `${task.id}.checkpoint.json`);

  const saveCheckpoint = (phase) => {
    atomicJson(checkpointPath, {
      version: 1,
      taskId: task.id,
      phase,
      role,
      pass: attempt,
      updatedAt: now(),
      lastAssistantText: clip(lastAssistantText, 1200),
      changedFiles: [...changedFiles],
      recentEvents: recentEvents.slice(-16),
    });
  };

  const send = (value) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(value)}\n`);
  };

  const abort = (reason) => {
    if (abortReason) return;
    abortReason = reason;
    send({ type: "clear_queue" });
    send({ type: "abort" });
    setTimeout(() => {
      if (processAlive(child.pid)) child.kill();
    }, 3000).unref();
  };

  const attemptTimeoutMinutes = numericLimit(config.attemptTimeoutMinutes);
  const handoffTokens = contextHandoffLimit(config);
  let contextCheckInFlight = false;
  const timeout = Number.isFinite(attemptTimeoutMinutes)
    ? setTimeout(() => abort(`attempt exceeded ${config.attemptTimeoutMinutes} minutes`), attemptTimeoutMinutes * 60_000)
    : null;
  const stopPoll = setInterval(() => {
    if (existsSync(stopPath) || interrupted) abort(existsSync(stopPath) ? "stop requested" : "interrupted");
  }, 1000);
  const contextPoll = setInterval(async () => {
    if (abortReason || contextCheckInFlight) return;
    contextCheckInFlight = true;
    try {
      const response = await fetch("http://127.0.0.1:8080/slots", { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return;
      const slots = await response.json();
      const activeSlot = Array.isArray(slots)
        ? slots.find((slot) => slot?.is_processing && Number.isFinite(Number(slot?.n_prompt_tokens)))
        : null;
      const promptTokens = Number(activeSlot?.n_prompt_tokens);
      if (Number.isFinite(promptTokens) && promptTokens >= handoffTokens) {
        recentEvents.push({ at: now(), type: "context_handoff", promptTokens, threshold: handoffTokens });
        saveCheckpoint("context-handoff");
        abort(`context handoff: ${promptTokens} prompt tokens reached the ${handoffTokens} safe-session threshold`);
      }
    } catch {
      // The server can be busy loading or ending a request. A later poll will retry.
    } finally {
      contextCheckInFlight = false;
    }
  }, 2000);

  child.stderr.on("data", (chunk) => appendFileSync(stderrLog, chunk));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    appendFileSync(rpcLog, `${line}\n`, "utf8");
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      process.stdout.write(`[pi] ${clip(line)}\n`);
      return;
    }

    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      const argsText = JSON.stringify(event.args ?? {});
      process.stdout.write(`[tool ${toolCalls}] ${event.toolName}: ${clip(argsText, 220)}\n`);
      recentEvents.push({ at: now(), type: "tool_start", tool: event.toolName, input: clip(argsText, 500) });
      if (["write", "edit"].includes(event.toolName)) {
        const path = event.args?.path;
        if (path) changedFiles.add(String(path));
      }
      saveCheckpoint("working");
    } else if (event.type === "tool_execution_end") {
      process.stdout.write(`[tool] ${event.toolName} ${event.isError ? "ERROR" : "ok"}\n`);
      const toolResultText = JSON.stringify(event.result ?? event.output ?? "");
      recentEvents.push({
        at: now(),
        type: "tool_end",
        tool: event.toolName,
        status: event.isError ? "error" : "ok",
        result: clip(toolResultText, 700),
      });
      if (toolResultText.includes("LOCAL_AUTOPILOT_NO_PROGRESS_LOOP")) {
        noProgressLoop = true;
        saveCheckpoint("no-progress-loop");
        abort("no-progress loop detected: the same shell command produced identical evidence twice without a project edit; restarting with a clean session and the recorded diagnosis");
        return;
      }
      saveCheckpoint(event.isError ? "repair-needed" : "working");
    } else if (event.type === "message_end") {
      const text = extractAssistantText(event.message);
      if (text) {
        lastAssistantText = text;
        process.stdout.write(`[agent] ${clip(text, 900)}\n`);
        saveCheckpoint("thinking");
      }
    } else if (event.type === "compaction_start") {
      compactions += 1;
      recentEvents.push({ at: now(), type: "compaction-blocked", number: compactions });
      saveCheckpoint("context-handoff");
      abort("context handoff: automatic compaction was requested; preserving the checkpoint and starting a clean session instead");
    } else if (event.type === "agent_settled") {
      settled = true;
      saveCheckpoint("settled-without-result");
      if (existsSync(resultFile)) {
        child.kill();
      } else if (compactions > 0 || settledWithoutResult >= 1) {
        abort("context handoff: session settled repeatedly without a structured result");
      } else {
        settledWithoutResult += 1;
        setTimeout(() => send({
          id: `continue-${Date.now()}`,
          type: "prompt",
          message: [
            "Continue the same assigned task; do not stop at a prose status update.",
            "Use the work and tool results already in this session and the durable checkpoint. Do not repeat broad discovery.",
            `Take the smallest concrete next action toward the acceptance criteria, verify it, and call ${finishTool} when complete or genuinely blocked.`,
          ].join(" "),
        }), 250);
      }
    }
  });

  child.on("error", (error) => {
    appendFileSync(stderrLog, `${error.stack ?? error}\n`, "utf8");
  });

  send({ type: "set_steering_mode", mode: "one-at-a-time" });
  send({ type: "set_follow_up_mode", mode: "one-at-a-time" });
  send({ type: "set_auto_compaction", enabled: false });
  send({ id: "task-prompt", type: "prompt", message: prompt });

  await new Promise((resolvePromise) => {
    child.on("exit", (code) => {
      exitCode = code;
      resolvePromise();
    });
  });
  if (timeout) clearTimeout(timeout);
  clearInterval(stopPoll);
  clearInterval(contextPoll);
  lines.close();
  activeChild = null;

  let result = null;
  if (existsSync(resultFile)) {
    try {
      result = readJson(resultFile);
    } catch (error) {
      abortReason ||= `invalid result JSON: ${error.message}`;
    }
  }
  return {
    result, settled, exitCode, abortReason, toolCalls, compactions, noProgressLoop,
    contextHandoff: abortReason.startsWith("context handoff:"), rpcLog, stderrLog,
  };
}

async function main() {
  let taskIndex = 0;
  while (taskIndex < state.tasks.length) {
    const taskState = state.tasks[taskIndex];
    if (taskState.status === "done") {
      taskIndex += 1;
      continue;
    }
    const task = taskDefinitions.get(taskState.id);
    if (!task) fail(`task definition missing: ${taskState.id}`);

    if (task.requiresUserApproval) {
      taskState.status = "waiting";
      state.status = "waiting-user";
      state.currentTaskId = task.id;
      saveState(state, `Task ${task.id} requires explicit user authorization: ${task.title}`);
      process.stdout.write(`[autopilot] PAUSED before ${task.id}: explicit user authorization required.\n`);
      return;
    }

    taskState.status = "running";
    state.currentTaskId = task.id;
    saveState(state, `Starting task ${task.id}: ${task.title}`);
    let accepted = false;
    let replanned = false;

    while (!accepted) {
      taskState.attempts += 1;
      saveState(state, `Worker attempt ${taskState.attempts} for task ${task.id}`);
      const worker = await runPi({
        role: "worker",
        task,
        attempt: taskState.attempts,
        prompt: buildWorkerPrompt(task, taskState.attempts, taskState.lastIssues ?? []),
      });

      if (existsSync(stopPath) || interrupted) {
        taskState.status = "pending";
        state.status = "stopped";
        saveState(state, `Stopped during task ${task.id}`);
        return;
      }
      if (!worker.result) {
        const workerFailure = worker.abortReason || `worker exited without finish_step (exit=${worker.exitCode}, settled=${worker.settled})`;
        taskState.lastIssues = [workerFailure];
        saveState(state, `Worker attempt ${taskState.attempts} failed without a structured result`);
        if (worker.contextHandoff) {
          saveState(state, `Context handoff for task ${task.id}; continuing from durable checkpoint in a clean session`);
          process.stdout.write(`[autopilot] CONTEXT HANDOFF ${task.id}: clean session will resume from checkpoint\n`);
          continue;
        }
        if (worker.noProgressLoop) {
          saveState(state, `Recovery planner is reframing stalled task ${task.id}`);
          const recovery = await runPi({
            role: "planner",
            task,
            attempt: taskState.attempts,
            prompt: buildRecoveryPlanPrompt(task, workerFailure),
          });
          if (existsSync(stopPath) || interrupted) {
            taskState.status = "pending";
            state.status = "stopped";
            saveState(state, `Stopped during recovery planning for task ${task.id}`);
            return;
          }
          try {
            const replacements = applyRecoveryPlan(task, recovery.result);
            reloadTasksIntoState(state);
            state.status = "running";
            state.currentTaskId = null;
            saveState(state, `Task ${task.id} reframed into ${replacements.length} focused recovery steps`);
            process.stdout.write(`[autopilot] REPLANNED ${task.id}: ${replacements.map((item) => item.id).join(", ")}\n`);
            replanned = true;
            break;
          } catch (error) {
            taskState.lastIssues = [workerFailure, `Recovery planner did not return a usable plan: ${error.message}`];
            saveState(state, `Recovery planner failed for task ${task.id}`);
          }
        }
        continue;
      }
      if (worker.result.status === "blocked") {
        taskState.status = "blocked";
        taskState.lastIssues = [worker.result.blocker || worker.result.summary];
        state.status = "blocked";
        const actionHint = worker.result.actionFile ? ` See ${worker.result.actionFile}` : "";
        saveState(state, `Task ${task.id} blocked: ${taskState.lastIssues[0]}${actionHint}`);
        process.stdout.write(`[autopilot] BLOCKED ${task.id}: ${taskState.lastIssues[0]}\n`);
        return;
      }

      saveState(state, `Reviewing worker attempt ${taskState.attempts} for task ${task.id}`);
      const review = await runPi({
        role: "reviewer",
        task,
        attempt: taskState.attempts,
        prompt: buildReviewPrompt(task, worker.result),
      });
      if (existsSync(stopPath) || interrupted) {
        taskState.status = "pending";
        state.status = "stopped";
        saveState(state, `Stopped during review of task ${task.id}`);
        return;
      }
      if (!review.result) {
        taskState.lastIssues = [review.abortReason || `reviewer exited without finish_review (exit=${review.exitCode})`];
        saveState(state, `Review attempt ${taskState.attempts} failed without a verdict`);
        if (review.contextHandoff) {
          saveState(state, `Reviewer context handoff for task ${task.id}; retrying independent review in a clean session`);
        }
        continue;
      }
      if (!review.result.approved) {
        taskState.lastIssues = review.result.issues?.length ? review.result.issues : [review.result.summary];
        saveState(state, `Review rejected task ${task.id}: ${taskState.lastIssues.join("; ")}`);
        process.stdout.write(`[autopilot] REVIEW REJECTED ${task.id}: ${clip(taskState.lastIssues.join("; "), 500)}\n`);
        continue;
      }

      accepted = true;
      taskState.status = "done";
      taskState.completedAt = now();
      taskState.lastIssues = [];
      appendJournal(task, worker.result, review.result);
      rmSync(userActionPath, { force: true });
      const planUpdated = markPlanDone(task.id);
      saveState(state, `Task ${task.id} accepted${planUpdated ? " and PLAN.md updated" : ""}`);
      process.stdout.write(`[autopilot] ACCEPTED ${task.id}: ${review.result.summary}\n`);
      reloadTasksIntoState(state);
      saveState(state);
      taskIndex = 0;
      continue;
    }

    if (replanned) {
      taskIndex = 0;
      continue;
    }
    taskIndex += 1;
  }

  state.status = "complete";
  state.currentTaskId = null;
  saveState(state, "All authorized tasks are complete");
  process.stdout.write("[autopilot] All authorized tasks are complete.\n");
}

try {
  await main();
} catch (error) {
  state.status = "failed";
  saveState(state, error.stack ?? error.message ?? String(error));
  throw error;
} finally {
  state.pid = null;
  saveState(state);
  rmSync(lockPath, { force: true });
  rmSync(stopPath, { force: true });
}
