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
import { PROTOCOL_VERSION, isBootstrapTask, planPaths, planningSnapshot, checkProposal, commitPlan, recoverPlanCommit, toolNames, validateResult, digest } from "./plan-store.mjs";

const [, , command = "start", configArg] = process.argv;

function fail(message, code = 1) {
  process.stderr.write(`[autopilot] ERROR: ${message}\n`);
  process.exit(code);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function readWebNotes() {
  try {
    const notes = readJson(join(projectRoot, ".agent", "web-notes.json"));
    return Array.isArray(notes) ? notes.filter(note => /^[\w-]+$/.test(note.id) && typeof note.text === "string") : [];
  } catch { return []; }
}

function webNoteReceipt(id, status, error) {
  atomicJson(join(projectRoot, ".agent", "web-receipts", id + ".json"), { status, error, atStatus: now() });
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
const planningPaths = planPaths(projectRoot, goalPath, planPath, tasksPath);
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

if (process.env.LOCAL_AUTOPILOT_WEB_LAUNCH_ID) {
  const webLaunchPath = join(projectRoot, ".agent", "web-launch.json");
  if (existsSync(webLaunchPath)) {
    const webLaunch = readJson(webLaunchPath);
    if (webLaunch.launchId === process.env.LOCAL_AUTOPILOT_WEB_LAUNCH_ID && webLaunch.stopRequested) {
      process.stdout.write("[autopilot] Web launch cancelled during GPU startup.\n");
      process.exit(0);
    }
  }
}

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

recoverPlanCommit(planningPaths);
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
  const marker = `<!-- accepted:${digest({ taskId: task.id, workerResult, reviewResult })} -->`;
  if (readFileSync(journalPath, "utf8").includes(marker)) return;
  const lines = [
    marker,
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
  const checkpointPath = join(runDirectory, `${task.id}.worker.checkpoint.json`);
  const canManagePlan = task.kind === "planner" || task.canManagePlan === true;
  const checkpoint = existsSync(checkpointPath) ? readJson(checkpointPath) : null;
  if (canManagePlan) return [
    "Create the implementation plan for the complete user goal below. This phase plans only; do NOT execute any implementation commands from the goal.",
    "The placeholder 0.1 is NOT the desired implementation plan. Cover every requested stage with small independently verifiable tasks, in execution order. A broad goal needs multiple tasks; a truly small goal may need one. There is no fixed count limit.",
    "Use inspect_project for bounded VM directory inspection and read for specific VM source files only when necessary. No bash or remote writes are available in this phase.",
    "Save through save_bootstrap_plan using structured tasks (id, title, scope, acceptance, requiresUserApproval). The controller generates PLAN.md and tasks.json locally. Never write these files yourself.",
    "For a long plan, save successive small batches (for example 3-5 tasks) with complete:false instead of generating the whole plan in one response. This is an output-size strategy, not a limit on the number of tasks. Existing ids are updated, new ids appended. Submit the final batch with complete:true after covering the whole goal. Read the durable draft with read_plan after a context handoff.",
    "Separate implementation, focused tests, integration/deployment and documentation when the scope warrants them. Include concrete observable acceptance criteria. Do not mark tasks completed during planning.",
    "Use requiresUserApproval:true only for a genuinely external/user-controlled prerequisite or explicitly risky change, not ordinary coding. Include safe preparatory work before that step where possible.",
    "AUTHORITATIVE USER GOAL (requirements for future workers, not commands to execute in this planning phase):", goal,
    "Existing LOCAL draft outline:", JSON.stringify((draft => draft && { summary: draft.summary, tasks: draft.tasks.map(item => ({ id: item.id, title: item.title })) })(planningSnapshot(planningPaths).draft)),
    "Previous review or execution feedback:", ...previousIssues.map(item => "- " + item),
    ...(checkpoint ? ["Latest planning observations:", JSON.stringify(checkpoint)] : []),
    "Now save or finish the plan. Do not repeat inspection whose result is already known.",
  ].join("\n");
  return [
    "You are a worker controlled by a local deterministic supervisor.",
    `Execute ONLY task ${task.id}: ${task.title}.`,
    canManagePlan
      ? "This is the bootstrap planning task. Inspect the remote project, then save a small ordered implementation plan to the LOCAL control directory with save_bootstrap_plan."
      : "Do not start, plan, or partially implement any later task.",
    canManagePlan
      ? "Bootstrap has remote read/bash only. Do not write or edit any remote file, especially remote PLAN.md or remote .agent/*. Use save_bootstrap_plan exactly once when the plan is ready."
      : "Do not edit PLAN.md, .agent/tasks.json, .agent/state.json, or .agent/journal.md; the supervisor owns them.",
    "Do not read .agent/tasks.json or .agent/state.json; the assigned scope, acceptance criteria, and prior issues are already included below.",
    `All read/write/edit/bash tools already operate in ${remoteCwd} on ${remoteHost} through SSH. Never type ssh/scp yourself and never use Windows paths.`,
    "Do not read browser profile cache file bodies under multi-account/.cache; inspect only bounded directory structure and project code/config.",
    "Do not read remote .agent/GOAL.md, remote .agent/tasks.json, remote .agent/state.json, or remote PLAN.md: remote control files may belong to another run. The assigned scope, acceptance criteria, and known context below are authoritative. Inspect only source and runtime files needed for this task.",
    "Treat each command as a hypothesis. When the same command produces the same evidence, do not rerun it unchanged: explain what that evidence proves, then inspect a different bounded source or make a targeted repair.",
    `Task scope: ${task.scope}`,
    ...(task.knownContext?.length ? ["Known starting observations: verify them directly once, then do not repeat broad investigation:", ...task.knownContext.map((item) => `- ${item}`)] : []),
    "Acceptance criteria:",
    ...task.acceptance.map((item) => `- ${item}`),
    ...(canManagePlan ? [
      "Authoritative local goal:",
      goal,
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
    canManagePlan
      ? "If later work will require user input, represent it as a narrow planned task with requiresUserApproval:true. Do not request it during bootstrap."
      : "Use request_user_action only after one focused check proves that an acceptance criterion cannot be met without a real external dependency (for example a proxy endpoint, account login, model endpoint, or explicit approval). Do not call it for code defects, failing tests, safely creatable project files, or ordinary uncertainty: repair or investigate those normally. Once the external dependency is proven missing, do not guess, fabricate configuration, or repeat discovery; request the smallest safe user action. Never request secrets in chat, logs, or repository files.",
    canManagePlan
      ? "When the plan is ready, call save_bootstrap_plan. If your turn ends without it, the supervisor will continue the same session from its durable checkpoint."
      : "When verification passes, call finish_step. If your turn ends without it, the supervisor will continue the same session from its durable checkpoint.",
  ].join("\n");
}

function buildReviewPrompt(task, workerResult) {
  const canManagePlan = task.kind === "planner" || task.canManagePlan === true;
  if (canManagePlan) return [
    "Review the submitted LOCAL plan, not implementation. First call read_plan to read the authoritative goal and proposal from disk.",
    "Check that the plan covers the whole goal in ordered, independently verifiable steps, with concrete acceptance criteria and genuine user prerequisites flagged. Reject missing stages or vague giant tasks.",
    "The code has NOT been implemented yet. Do not demand that planned files/tests already exist or that planned checks have already passed. Evaluate the plan as a plan.",
    "Only read_plan and finish_review are available. You have no VM access; remote PLAN.md belongs to a different task and is never relevant.",
    "The controller has validated schema, unique ids and local storage. Focus on semantic coverage and ordering, not re-checking VM files.",
    "Submitted revision: " + workerResult.planRevision,
    "Call finish_review with approved:true when coverage is adequate; otherwise give specific edits to the plan without inventing extra requirements.",
  ].join("\n");
  const localPlan = canManagePlan && existsSync(planPath) ? readFileSync(planPath, "utf8") : "";
  const localTasks = canManagePlan && existsSync(tasksPath) ? readFileSync(tasksPath, "utf8") : "";
  return [
    "You are an independent read-only reviewer in a fresh session.",
    `Review ONLY task ${task.id}: ${task.title}.`,
    "You may read files and run focused non-mutating tests. You must not write or edit files.",
    canManagePlan
      ? "For this bootstrap review, inspect remote source files as needed but do not read remote .agent/ or remote PLAN.md; those belong to another run. The authoritative local goal and generated local plan are included below."
      : "Inspect remote source and runtime files needed for this task, but do not read remote .agent/ or remote PLAN.md; those control files may belong to another run.",
    "Do not read .agent/tasks.json or .agent/state.json; the complete assigned task is included below.",
    `Task scope: ${task.scope}`,
    "Acceptance criteria:",
    ...task.acceptance.map((item) => `- ${item}`),
    ...(canManagePlan ? ["Authoritative local goal:", goal, "Generated local PLAN.md:", localPlan, "Generated local .agent/tasks.json:", localTasks] : []),
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
  const startupNotes = readWebNotes();
  const sentNotes = new Set(startupNotes.map(note => note.id));
  const pendingNotes = new Map();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = `${stamp}-${task.id}-${role}-a${attempt}`;
  const resultFile = join(runDirectory, `${prefix}.result.json`);
  const activityFile = join(runDirectory, `${prefix}.activity.jsonl`);
  const rpcLog = join(runDirectory, `${prefix}.rpc.jsonl`);
  const stderrLog = join(runDirectory, `${prefix}.stderr.log`);
  rmSync(resultFile, { force: true });

  const bootstrapTask = isBootstrapTask(task);
  const bootstrapPlanning = role === "worker" && bootstrapTask;
  const finishTool = bootstrapPlanning
    ? "save_bootstrap_plan"
    : role === "reviewer"
    ? "finish_review"
    : role === "planner"
      ? "finish_replan"
      : "finish_step";
  const expectedTools = toolNames(role, bootstrapTask);
  const tools = expectedTools.join(",");
  const roleInstructions = bootstrapTask
    ? ["You are the LOCAL implementation-plan " + (role === "reviewer" ? "reviewer" : "author") + ".",
      "The authoritative user goal and plan live on Windows in this run's controller, NOT in the VM project.",
      role === "reviewer" ? "Read the proposal with read_plan, assess coverage of the goal, then finish_review. No code execution or remote access is available or necessary." : "Use save_bootstrap_plan with structured tasks. Save partial batches with complete:false for large plans, final batch complete:true. The controller writes the plan. Inspect VM source only through inspect_project/read when necessary, never execute the user goal during planning.",
      "These tools are the entire available interface: " + tools + ". Do not emulate other tools or try to bypass restrictions."]
    : ["You are a coding " + role + " working on exactly one assigned task in a Debian VM.",
      "Source read/write/edit/bash tools operate via SSH inside " + remoteCwd + " on " + remoteHost + ". Never invoke SSH yourself or use Windows paths.",
      role === "worker" ? "Make only task-scoped changes and verify them before finish_step. Use request_user_action only for a proven external prerequisite, never ordinary code defects." : "You are read-only: do not modify project files, start/restart services or perform deployment. Run focused non-mutating checks and report through " + finishTool + ".",
      "Never read or change remote .agent or PLAN.md; controller state is provided in your assignment.",
      "Avoid repeated commands with identical evidence. Use bounded source inspection and focused checks. Do not use bare pkill -f. Background any necessary worker-owned test server, retain its PID, poll health, and clean up that PID."];
  const systemPrompt = [
    ...roleInstructions,
    "Never read, print, copy, encode or inspect private keys, credentials, tokens, cookies or real browser-profile contents. Tool schemas define the allowed interface.",
    "There is no iteration limit. Context handoff preserves local drafts and evidence; continue from them instead of repeating work.",
    ...startupNotes.flatMap(note => ["User clarification (" + note.at + "):", note.text]),
  ].join("\n");

  const args = [
    config.piCli,
    "--offline",
    "--provider", config.provider,
    "--model", config.model,
    "--thinking", role === "worker" ? config.thinking : "medium",
    "--system-prompt", systemPrompt,
    "--tools", tools,
    "--session-dir", config.piSessionDirectory,
    "--name", `autopilot-${task.id}-${role}-a${attempt}`,
    "--no-extensions",
    "--extension", config.extension,
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--approve",
    "--mode", "rpc",
  ];

  const piProfile = join(runDirectory, "pi-profile");
  mkdirSync(piProfile, { recursive: true });
  const userModels = join(process.env.USERPROFILE, ".pi", "agent", "models.json");
  if (config.provider === "local-code") {
    const provider = existsSync(userModels) ? readJson(userModels).providers?.[config.provider] : null;
    if (!provider || !/^http:\/\/(127\.0\.0\.1|localhost):8080(?:\/|$)/.test(provider.baseUrl)) throw new Error("Local provider must use the loopback llama.cpp endpoint.");
    atomicJson(join(piProfile, "models.json"), { providers: { [config.provider]: provider } });
  }
  atomicJson(join(piProfile, "settings.json"), { compaction: { enabled: false } });
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: piProfile,
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
    LOCAL_AUTOPILOT_BOOTSTRAP: bootstrapTask ? "1" : "0",
    LOCAL_AUTOPILOT_GOAL_FILE: goalPath,
    LOCAL_AUTOPILOT_BOOTSTRAP_PLAN_FILE: bootstrapTask ? planPath : "",
    LOCAL_AUTOPILOT_BOOTSTRAP_TASKS_FILE: bootstrapTask ? tasksPath : "",
    LOCAL_AUTOPILOT_SYSTEM_PROMPT: systemPrompt,
    LOCAL_AUTOPILOT_READY_FILE: join(runDirectory, prefix + ".ready.json"),
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
  let infrastructureError = false;
  let exited = false;
  let continuationTimer = null;
  let promptDeadline = null;
  const successfulTools = new Set();
  const pendingWrites = new Map();
  const recentEvents = [];
  const changedFiles = new Set();
  const checkpointPath = join(runDirectory, `${task.id}.${role}.checkpoint.json`);

  const saveCheckpoint = (phase) => {
    const value = {
      version: 1,
      taskId: task.id,
      phase,
      role,
      pass: attempt,
      updatedAt: now(),
      lastAssistantText: clip(lastAssistantText, 1200),
      changedFiles: [...changedFiles],
      recentEvents: recentEvents.slice(-16),
    };
    atomicJson(checkpointPath, value);
    atomicJson(join(runDirectory, `${task.id}.checkpoint.json`), value);
  };

  const send = (value) => {
    if (!exited && child.stdin.writable && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`, () => {});
  };

  const abort = (reason) => {
    if (abortReason) return;
    abortReason = reason;
    clearTimeout(continuationTimer);
    clearTimeout(promptDeadline);
    send({ type: "clear_queue" });
    send({ type: "abort" });
    setTimeout(() => {
      if (!exited && processAlive(child.pid)) child.kill();
    }, 3000).unref();
  };

  const attemptTimeoutMinutes = numericLimit(config.attemptTimeoutMinutes);
  const handoffTokens = bootstrapTask && role === "reviewer"
    ? Math.max(contextHandoffLimit(config), (Number(config.contextWindow) || 24576) - 4096)
    : contextHandoffLimit(config);
  const timeout = Number.isFinite(attemptTimeoutMinutes)
    ? setTimeout(() => abort(`attempt exceeded ${config.attemptTimeoutMinutes} minutes`), attemptTimeoutMinutes * 60_000)
    : null;
  const stopPoll = setInterval(() => {
    if (existsSync(stopPath) || interrupted) abort(existsSync(stopPath) ? "stop requested" : "interrupted");
  }, 1000);
  const notePoll = setInterval(() => {
    if (abortReason || interrupted || !child.stdin.writable) return;
    for (const note of readWebNotes()) {
      if (sentNotes.has(note.id)) continue;
      sentNotes.add(note.id);
      pendingNotes.set("web-note-" + note.id, note);
      send({ id: "web-note-" + note.id, type: "steer", message: note.text });
    }
  }, 1000);
  const contextPoll = setInterval(() => {
    if (!abortReason && !exited) send({ id: "context-usage", type: "get_session_stats" });
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

    if (event.type === "extension_error" || (event.type === "response" && event.success === false && !pendingNotes.has(event.id))) {
      infrastructureError = true;
      abort("Pi command/extension error: " + clip(event.error || event.message || JSON.stringify(event), 1000));
    } else if (event.type === "response" && event.id === "context-usage") {
      const tokens = event.data?.contextUsage?.tokens;
      if (!abortReason && !exited && typeof tokens === "number" && tokens >= handoffTokens) {
        recentEvents.push({ at: now(), type: "context_handoff", promptTokens: tokens, threshold: handoffTokens });
        saveCheckpoint("context-handoff");
        abort("context handoff: this Pi session reached " + tokens + " prompt tokens");
      }
    } else if (event.type === "response" && event.id === "task-prompt" && event.success) {
      clearTimeout(promptDeadline);
      for (const note of startupNotes) webNoteReceipt(note.id, "included");
    } else if (event.type === "response" && pendingNotes.has(event.id)) {
      const note = pendingNotes.get(event.id);
      webNoteReceipt(note.id, event.success ? "queued" : "error", event.error);
    } else if (event.type === "message_start" && event.message?.role === "user") {
      const content = event.message.content;
      const messageText = typeof content === "string" ? content : (content || []).map(item => item.text || "").join("\n");
      for (const note of pendingNotes.values()) {
        if (messageText === note.text) webNoteReceipt(note.id, "delivered");
      }
    } else if (event.type === "tool_execution_start") {
      toolCalls += 1;
      const argsText = JSON.stringify(event.args ?? {});
      process.stdout.write(`[tool ${toolCalls}] ${event.toolName}: ${clip(argsText, 220)}\n`);
      recentEvents.push({ at: now(), type: "tool_start", tool: event.toolName, input: clip(argsText, 500) });
      if (["write", "edit"].includes(event.toolName)) {
        const path = event.args?.path;
        if (path) pendingWrites.set(event.toolCallId, String(path));
      }
      saveCheckpoint("working");
    } else if (event.type === "tool_execution_end") {
      if (!event.isError) {
        successfulTools.add(event.toolName);
        if (pendingWrites.has(event.toolCallId)) changedFiles.add(pendingWrites.get(event.toolCallId));
      }
      process.stdout.write(`[tool] ${event.toolName} ${event.isError ? "ERROR" : "ok"}\n`);
      const toolResultText = JSON.stringify(event.result ?? event.output ?? "");
      if (toolResultText.includes("LOCAL_AUTOPILOT_SANDBOX_UNAVAILABLE")) {
        infrastructureError = true;
        abort("Debian needs bubblewrap for read-only review; no writable fallback was used");
      }
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
      if (event.message?.stopReason === "error") {
        infrastructureError = true;
        abort("Model request failed: " + clip(event.message.errorMessage, 1000));
      }
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
      if (abortReason || interrupted || existsSync(stopPath)) { child.stdin.end(); return; }
      saveCheckpoint("settled-without-result");
      if (existsSync(resultFile)) {
        child.stdin.end();
      } else if (compactions > 0 || settledWithoutResult >= 1) {
        abort("context handoff: session settled repeatedly without a structured result");
      } else {
        settledWithoutResult += 1;
        continuationTimer = setTimeout(() => {
          if (abortReason || interrupted || exited || existsSync(stopPath)) return;
          send({
          id: `continue-${Date.now()}`,
          type: "prompt",
          message: [
            "Continue the same assigned task; do not stop at a prose status update.",
            "Use the work and tool results already in this session and the durable checkpoint. Do not repeat broad discovery.",
            `Take the smallest concrete next action toward the acceptance criteria, verify it, and call ${finishTool} when complete or genuinely blocked.`,
          ].join(" "),
          });
        }, 250);
      }
    }
  });

  child.on("error", (error) => {
    infrastructureError = true;
    abortReason ||= "Could not start Pi: " + error.message;
    appendFileSync(stderrLog, `${error.stack ?? error}\n`, "utf8");
  });
  child.stdin.on("error", error => {
    if (!abortReason && !settled) { infrastructureError = true; abort("Pi input failed: " + error.message); }
  });
  const closed = new Promise(resolvePromise => {
    child.once("close", code => { exitCode = code; exited = true; resolvePromise(); });
  });

  const readyDeadline = Date.now() + 15000;
  while (!exited && !abortReason && !existsSync(env.LOCAL_AUTOPILOT_READY_FILE) && Date.now() < readyDeadline) await new Promise(r => setTimeout(r, 50));
  if (!exited && !abortReason) {
    const manifest = existsSync(env.LOCAL_AUTOPILOT_READY_FILE) ? readJson(env.LOCAL_AUTOPILOT_READY_FILE) : null;
    if (manifest?.protocol !== PROTOCOL_VERSION || manifest.role !== role || manifest.taskId !== task.id || JSON.stringify([...(manifest.tools || [])].sort()) !== JSON.stringify([...expectedTools].sort())) {
      infrastructureError = true;
      abort("Pi extension tool handshake failed. Expected: " + tools + ". No model prompt was sent.");
    } else {
      send({ id: "steering-mode", type: "set_steering_mode", mode: "one-at-a-time" });
      send({ id: "follow-up-mode", type: "set_follow_up_mode", mode: "one-at-a-time" });
      send({ id: "auto-compaction", type: "set_auto_compaction", enabled: false });
      promptDeadline = setTimeout(() => { infrastructureError = true; abort("Pi did not acknowledge the prompt within 15 seconds"); }, 15000);
      send({ id: "task-prompt", type: "prompt", message: prompt });
    }
  }
  await closed;
  if (timeout) clearTimeout(timeout);
  clearInterval(stopPoll);
  clearInterval(notePoll);
  clearInterval(contextPoll);
  clearTimeout(continuationTimer);
  clearTimeout(promptDeadline);
  lines.close();
  activeChild = null;

  let result = null;
  if (existsSync(resultFile)) {
    try {
      result = readJson(resultFile);
      validateResult(result, role, task.id, bootstrapTask);
      if (!successfulTools.has(finishTool) && !successfulTools.has("request_user_action")) throw new Error("No successful finalizer tool event for the saved result");
    } catch (error) {
      result = null;
      abortReason ||= `invalid result JSON: ${error.message}`;
    }
  }
  return {
    result, settled, exitCode, abortReason, toolCalls, compactions, noProgressLoop, infrastructureError: infrastructureError || (!abortReason && exitCode !== 0),
    contextHandoff: abortReason.startsWith("context handoff:"), rpcLog, stderrLog,
  };
}

async function main() {
  while (true) {
    const taskState = state.tasks.find(item => item.status !== "done");
    if (!taskState) break;
    const task = taskDefinitions.get(taskState.id);
    if (!task) throw new Error("Task definition missing: " + taskState.id);
    const stopped = message => {
      if (!existsSync(stopPath) && !interrupted) return false;
      taskState.status = "pending";
      state.status = "stopped";
      saveState(state, message);
      return true;
    };
    if (stopped("Stopped before task " + task.id)) return;
    state.currentTaskId = task.id;
    if (task.requiresUserApproval) {
      taskState.status = "waiting";
      state.status = "waiting-user";
      saveState(state, "Task " + task.id + " requires explicit user authorization: " + task.title);
      return;
    }

    const bootstrap = isBootstrapTask(task);
    const ticketPath = join(runDirectory, task.id + ".pending-review.json");
    const fingerprint = digest({ task, goal });
    let ticket = existsSync(ticketPath) ? readJson(ticketPath) : null;
    if (ticket?.fingerprint !== fingerprint) {
      ticket = null;
      rmSync(ticketPath, { force: true });
    }
    taskState.status = "running";
    let taskFinished = false;
    while (!taskFinished) {
      if (stopped("Stopped during task " + task.id)) return;
      if (!ticket) {
        taskState.attempts += 1;
        state.status = bootstrap ? "planning" : "running";
        saveState(state, "Worker attempt " + taskState.attempts + " for task " + task.id);
        const worker = await runPi({
          role: "worker", task, attempt: taskState.attempts,
          prompt: buildWorkerPrompt(task, taskState.attempts, taskState.lastIssues ?? []),
        });
        if (stopped("Stopped during task " + task.id)) return;
        if (worker.infrastructureError) throw new Error(worker.abortReason || "Pi runtime failed; see " + worker.stderrLog);
        if (!worker.result) {
          const reason = worker.abortReason || "Worker returned no structured result";
          taskState.lastIssues = [reason];
          saveState(state, reason);
          if (worker.noProgressLoop && !bootstrap) {
            state.status = "planning";
            saveState(state, "Recovery planner is reframing stalled task " + task.id);
            const recovery = await runPi({ role: "planner", task, attempt: taskState.attempts, prompt: buildRecoveryPlanPrompt(task, reason) });
            if (stopped("Stopped during recovery planning for task " + task.id)) return;
            if (recovery.infrastructureError) throw new Error(recovery.abortReason);
            try {
              const replacements = applyRecoveryPlan(task, recovery.result);
              reloadTasksIntoState(state);
              saveState(state, "Replanned " + task.id + " into " + replacements.length + " steps");
              taskFinished = true;
            } catch (error) {
              taskState.lastIssues = [reason, "Recovery plan failed: " + error.message];
              saveState(state);
            }
          }
          continue;
        }
        if (worker.result.status === "blocked") {
          taskState.status = "blocked";
          taskState.lastIssues = [worker.result.blocker || worker.result.summary];
          state.status = "blocked";
          saveState(state, "Task " + task.id + " needs user action: " + taskState.lastIssues[0]);
          return;
        }
        if (bootstrap) checkProposal(planningPaths, worker.result.planRevision);
        ticket = { fingerprint, taskId: task.id, worker: worker.result, reviewAttempts: 0 };
        atomicJson(ticketPath, ticket);
      }

      // A completed worker is never repeated because a reviewer ran out of context or was stopped.
      state.status = "reviewing";
      ticket.reviewAttempts += 1;
      atomicJson(ticketPath, ticket);
      saveState(state, "Review " + ticket.reviewAttempts + " for task " + task.id + "; worker result preserved");
      const reviewCheckpointPath = join(runDirectory, task.id + ".reviewer.checkpoint.json");
      const reviewContext = ticket.reviewAttempts > 1 && existsSync(reviewCheckpointPath)
        ? "\nPrior review observations (verify and continue without repeating them):\n" + JSON.stringify(readJson(reviewCheckpointPath)) : "";
      const review = await runPi({
        role: "reviewer", task, attempt: ticket.reviewAttempts,
        prompt: buildReviewPrompt(task, ticket.worker) + reviewContext,
      });
      if (stopped("Stopped during review of task " + task.id)) return;
      if (review.infrastructureError) throw new Error(review.abortReason);
      if (!review.result) {
        taskState.lastIssues = [review.abortReason || "Reviewer returned no verdict; retrying review only"];
        saveState(state, "Continuing independent review of " + task.id + "; worker not repeated");
        continue;
      }
      if (!review.result.approved) {
        taskState.lastIssues = review.result.issues.length ? review.result.issues : [review.result.summary];
        saveState(state, "Review rejected " + task.id + ": " + taskState.lastIssues.join("; "));
        rmSync(ticketPath, { force: true });
        ticket = null;
        continue;
      }
      if (bootstrap) commitPlan(planningPaths, ticket.worker.planRevision, review.result);
      taskState.status = "done";
      taskState.completedAt = now();
      taskState.lastIssues = [];
      appendJournal(task, ticket.worker, review.result);
      rmSync(userActionPath, { force: true });
      markPlanDone(task.id);
      saveState(state, "Task " + task.id + " accepted");
      rmSync(ticketPath, { force: true });
      reloadTasksIntoState(state);
      saveState(state);
      taskFinished = true;
    }
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
