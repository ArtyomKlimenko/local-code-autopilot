import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const PROTOCOL_VERSION = 2;
export const isBootstrapTask = task => task.kind === "planner" || task.canManagePlan === true;
export const digest = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export function readJson(path, fallback = null) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) : fallback;
}
export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(temp, path);
}
function atomicText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp";
  writeFileSync(temp, value, "utf8");
  renameSync(temp, path);
}
export function planPaths(root, goalFile, planFile, tasksFile) {
  const directory = join(root, ".agent", "planning");
  return { root, goalFile, planFile, tasksFile, draft: join(directory, "draft.json"), proposal: join(directory, "proposal.json"), commit: join(directory, "commit.json") };
}
export function validateTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error("Provide a non-empty tasks array.");
  const ids = new Set();
  return tasks.map(task => {
    if (!task || typeof task.id !== "string" || !/^[1-9]\d*(?:\.\d+)*$/.test(task.id)) throw new Error("Each task needs a numeric id such as 1.1; bootstrap 0.1 is reserved.");
    if (ids.has(task.id)) throw new Error("Duplicate task id: " + task.id);
    ids.add(task.id);
    for (const field of ["title", "scope"]) if (typeof task[field] !== "string" || !task[field].trim()) throw new Error(task.id + " needs " + field);
    if (!Array.isArray(task.acceptance) || !task.acceptance.length || task.acceptance.some(item => typeof item !== "string" || !item.trim())) throw new Error(task.id + " needs concrete acceptance criteria.");
    if (typeof task.requiresUserApproval !== "boolean") throw new Error(task.id + " needs requiresUserApproval true or false.");
    if (task.status && task.status !== "pending") throw new Error("New plan tasks must be pending, not already completed.");
    return { id: task.id, title: task.title.trim(), scope: task.scope.trim(), acceptance: task.acceptance.map(item => item.trim()), requiresUserApproval: task.requiresUserApproval, status: "pending" };
  });
}
export function renderPlan(proposal) {
  return ["# Autopilot Plan", "", proposal.summary, "", ...proposal.tasks.flatMap(task => [
    "- [ ] " + task.id + " " + task.title, "  " + task.scope,
    ...task.acceptance.map(item => "  - Verify: " + item),
    ...(task.requiresUserApproval ? ["  - Requires explicit user approval."] : []), "",
  ])].join("\n");
}
export function savePlanBatch(paths, { tasks, summary, complete = true, replace = false }) {
  const batch = validateTasks(tasks);
  const goalHash = digest(readFileSync(paths.goalFile, "utf8"));
  const prior = readJson(paths.draft);
  const all = !replace && prior?.goalHash === goalHash ? [...prior.tasks] : [];
  for (const task of batch) {
    const index = all.findIndex(item => item.id === task.id);
    if (index === -1) all.push(task); else all[index] = task;
  }
  const title = typeof summary === "string" && summary.trim() ? summary.trim() : prior?.summary;
  if (!title) throw new Error("Provide a short plan summary.");
  const draft = { version: PROTOCOL_VERSION, goalHash, summary: title, tasks: validateTasks(all) };
  draft.revision = digest(draft);
  atomicJson(paths.draft, draft);
  if (complete) atomicJson(paths.proposal, draft);
  return { ...draft, submitted: complete };
}
export function planningSnapshot(paths) {
  const goal = readFileSync(paths.goalFile, "utf8");
  const current = value => value?.goalHash === digest(goal) ? value : null;
  return {
    location: "LOCAL control workspace on Windows, never the remote VM",
    goal, draft: current(readJson(paths.draft)), proposal: current(readJson(paths.proposal)),
  };
}
export function checkProposal(paths, revision) {
  const proposal = planningSnapshot(paths).proposal;
  if (!proposal || proposal.revision !== revision) throw new Error("Plan proposal is absent, stale, or changed since review.");
  validateTasks(proposal.tasks);
  const { revision: recorded, ...content } = proposal;
  if (digest(content) !== recorded) throw new Error("Plan proposal integrity check failed.");
  return proposal;
}
export function commitPlan(paths, revision, review) {
  if (review?.approved !== true || review.planRevision !== revision) throw new Error("This exact plan revision must be approved before execution.");
  const proposal = checkProposal(paths, revision);
  // Approval is durable before either mirror changes. Restart rolls forward this transaction.
  atomicJson(paths.commit, { proposal, review, applied: false });
  recoverPlanCommit(paths);
  return proposal;
}
export function recoverPlanCommit(paths) {
  const commit = readJson(paths.commit);
  if (!commit || commit.applied) return;
  const { proposal, review } = commit;
  if (review?.approved !== true || review.planRevision !== proposal?.revision) throw new Error("Invalid plan commit approval.");
  const { revision, ...content } = proposal;
  if (digest(content) !== revision) throw new Error("Approved plan commit integrity check failed.");
  if (proposal.goalHash !== digest(readFileSync(paths.goalFile, "utf8"))) throw new Error("Goal changed during a pending plan commit.");
  validateTasks(proposal.tasks);
  atomicJson(paths.tasksFile, { version: 1, projectName: readJson(paths.tasksFile)?.projectName || basename(paths.root), planRevision: proposal.revision, tasks: proposal.tasks });
  atomicText(paths.planFile, renderPlan(proposal));
  atomicJson(paths.commit, { ...commit, applied: true });
}

export function toolNames(role, bootstrap) {
  if (bootstrap) return role === "reviewer" ? ["read_plan", "finish_review"] : ["read_plan", "inspect_project", "read", "save_bootstrap_plan"];
  if (role === "worker") return ["read", "bash", "edit", "write", "request_user_action", "finish_step"];
  return ["read", "bash", role === "reviewer" ? "finish_review" : "finish_replan"];
}
export function validateResult(result, role, taskId, bootstrap = false) {
  if (!result || result.taskId !== taskId) throw new Error("Missing result or mismatched task id.");
  if (typeof result.summary !== "string" && role !== "planner") throw new Error("Missing result summary.");
  if (role === "reviewer") {
    if (result.kind !== "review" || typeof result.approved !== "boolean" || !Array.isArray(result.issues) || !Array.isArray(result.verification)) throw new Error("Invalid review verdict.");
  } else if (role === "worker") {
    if (result.kind !== "worker" || !["complete", "blocked"].includes(result.status) || !Array.isArray(result.changedFiles) || !Array.isArray(result.verification) || !Array.isArray(result.evidence)) throw new Error("Invalid worker result.");
    if (bootstrap && result.status === "complete" && !result.planRevision) throw new Error("Bootstrap must submit a validated local plan revision.");
  } else if (result.kind !== "replan" || !Array.isArray(result.steps) || !result.steps.length) throw new Error("Invalid recovery result.");
  return result;
}
