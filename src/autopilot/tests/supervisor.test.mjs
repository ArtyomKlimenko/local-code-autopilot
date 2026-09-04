import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { atomicJson, readJson } from "../plan-store.mjs";
import { bootstrapTask, createHarness, task } from "./supervisor-harness.mjs";

const sequence = h => h.trace.map(({ role, taskId }) => `${role}:${taskId}`);
const statuses = h => h.state().tasks.map(({ id, status }) => [id, status]);
const activeFiles = h => [h.paths.planFile, h.paths.tasksFile].map(path => readFileSync(path, "utf8"));
const ticket = (h, id) => readJson(join(h.root, "runs", `${id}.pending-review.json`));

function assertNotDone(h, id = "1.1") {
  assert.notEqual(h.state().status, "complete");
  const state = h.state().tasks.find(item => item.id === id);
  assert.ok(state, `Task ${id} must still exist`);
  assert.notEqual(state.status, "done");
  assert.equal(state.completedAt, null);
  assert.ok(!h.plan().includes(`- [x] ${id}`));
  assert.equal(existsSync(h.journalFile), false, "invalid result must not be journaled as accepted");
}

async function finishTask(h, id) {
  const worker = await h.nextPrompt("worker", id);
  const claim = await h.finish(worker);
  const reviewer = await h.nextPrompt("reviewer", id);
  assert.ok(reviewer.prompt.includes(claim.result.summary));
  await h.finish(reviewer);
  return claim;
}

async function submitPlan(h, tasks) {
  const worker = await h.nextPrompt("worker", "0.1");
  const claim = await h.command(worker, { action: "plan", tasks });
  const reviewer = await h.nextPrompt("reviewer", "0.1");
  assert.ok(reviewer.prompt.includes(claim.result.planRevision));
  return { worker, claim, reviewer };
}

test("bootstrap -> review -> first task -> second task never skips the first approved task", async t => {
  const h = createHarness(t, [bootstrapTask()]);
  const before = activeFiles(h);
  h.start();
  const planned = [task("1.1"), task("1.2")];
  const { worker, claim, reviewer } = await submitPlan(h, planned);
  for (const session of [worker, reviewer]) {
    assert.equal(session.bootstrap, true);
    assert.equal(session.goalFile, h.paths.goalFile);
    assert.equal(session.planFile, h.paths.planFile);
    assert.equal(session.tasksFile, h.paths.tasksFile);
    assert.equal(session.manifest.protocol, 2);
    assert.deepEqual(readJson(session.readyFile), session.manifest);
  }
  assert.deepEqual(worker.manifest.tools, ["read_plan", "inspect_project", "read", "save_bootstrap_plan"]);
  assert.deepEqual(reviewer.manifest.tools, ["read_plan", "finish_review"]);
  assert.deepEqual(activeFiles(h), before, "submitted proposal must not replace active bootstrap tasks before review");
  assert.equal(readJson(h.paths.proposal).revision, claim.result.planRevision);
  assert.deepEqual(ticket(h, "0.1").worker, claim.result);
  const verdict = await h.finish(reviewer);
  assert.equal(verdict.result.planRevision, claim.result.planRevision);

  const first = await h.nextPrompt("worker", "1.1");
  assert.equal(readJson(h.paths.tasksFile).planRevision, claim.result.planRevision);
  assert.deepEqual(readJson(h.paths.tasksFile).tasks.map(item => item.id), ["1.1", "1.2"]);
  assert.equal(readJson(h.paths.commit).applied, true);
  assert.ok(h.plan().includes("- [ ] 1.1"));
  assert.ok(h.plan().includes("- [ ] 1.2"));
  await h.finish(first);
  await h.finish(await h.nextPrompt("reviewer", "1.1"));
  await finishTask(h, "1.2");
  await h.exit();
  assert.equal(h.state().status, "complete");
  assert.deepEqual(statuses(h), [["1.1", "done"], ["1.2", "done"]]);
  assert.deepEqual(sequence(h), ["worker:0.1", "reviewer:0.1", "worker:1.1", "reviewer:1.1", "worker:1.2", "reviewer:1.2"]);
  assert.ok(h.plan().includes("- [x] 1.1"));
  assert.ok(h.plan().includes("- [x] 1.2"));
  assert.ok(h.state().tasks.every(item => item.attempts === 1));
});

test("reviewer context handoffs retry review, preserving the single worker result", async t => {
  const h = createHarness(t);
  h.start();
  const worker = await h.nextPrompt("worker", "1.1");
  const claim = await h.finish(worker, { summary: "Immutable worker evidence across reviewer handoffs" });
  for (const via of ["compaction", "stats"]) {
    const reviewer = await h.nextPrompt("reviewer", "1.1");
    assert.deepEqual(ticket(h, "1.1").worker, claim.result);
    assert.ok(reviewer.prompt.includes(claim.result.summary));
    await h.command(reviewer, { action: "handoff", via });
  }
  const finalReview = await h.nextPrompt("reviewer", "1.1");
  assert.deepEqual(ticket(h, "1.1").worker, claim.result);
  assert.ok(finalReview.prompt.includes(claim.result.summary));
  await h.finish(finalReview);
  await h.exit();
  assert.deepEqual(sequence(h), ["worker:1.1", "reviewer:1.1", "reviewer:1.1", "reviewer:1.1"]);
  assert.equal(h.state().tasks[0].attempts, 1);
  assert.deepEqual(statuses(h), [["1.1", "done"]]);
});

for (const bootstrap of [false, true]) {
  test(`stop/resume during ${bootstrap ? "bootstrap" : "ordinary"} review retains worker evidence and resumes reviewer`, async t => {
    const id = bootstrap ? "0.1" : "1.1";
    const h = createHarness(t, [bootstrap ? bootstrapTask() : task(id)]);
    const before = activeFiles(h);
    h.start();
    const worker = await h.nextPrompt("worker", id);
    const claim = bootstrap
      ? await h.command(worker, { action: "plan", tasks: [task("1.1")] })
      : await h.finish(worker, { summary: "Durable worker result survives supervisor restart", evidence: ["Unique synthetic verification evidence"] });
    await h.nextPrompt("reviewer", id);
    const pending = ticket(h, id);
    assert.deepEqual(pending.worker, claim.result);
    await h.stop();
    assert.equal(h.state().status, "stopped");
    assert.equal(h.state().pid, null);
    assert.deepEqual(ticket(h, id).worker, claim.result);
    assert.equal(readFileSync(worker.resultFile, "utf8"), claim.text);
    if (bootstrap) assert.deepEqual(activeFiles(h), before);

    h.start();
    const resumed = await h.nextPrompt("reviewer", id);
    assert.deepEqual(ticket(h, id).worker, claim.result);
    assert.ok(resumed.prompt.includes(bootstrap ? claim.result.planRevision : claim.result.summary));
    const review = await h.finish(resumed);
    if (bootstrap) {
      assert.equal(review.result.planRevision, claim.result.planRevision);
      await finishTask(h, "1.1");
    }
    await h.exit();
    assert.equal(h.state().status, "complete");
    assert.deepEqual(sequence(h).slice(0, 3), [`worker:${id}`, `reviewer:${id}`, `reviewer:${id}`]);
    assert.equal(h.trace.filter(item => item.role === "worker" && item.taskId === id).length, 1);
    const journal = readFileSync(h.journalFile, "utf8");
    assert.equal(journal.split(`## ${id} - `).length - 1, 1, "resuming review must not duplicate acceptance journal entries");
  });
}

const validWorker = { kind: "worker", taskId: "1.1", status: "complete", summary: "Untrusted fixture claim", changedFiles: [], verification: ["Synthetic check"], evidence: ["PASS"] };
const validReview = { kind: "review", taskId: "1.1", approved: true, summary: "Untrusted fixture verdict", issues: [], verification: ["Synthetic review"] };
const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
const invalidResults = [
  ["worker", "wrong task id", { ...validWorker, taskId: "1.2" }],
  ["worker", "wrong result kind", { ...validWorker, kind: "review" }],
  ["worker", "invalid completion status", { ...validWorker, status: "done" }],
  ["worker", "missing evidence", without(validWorker, "evidence")],
  ["worker", "broken JSON", validWorker, { text: "{broken-json" }],
  ["worker", "result file without finalizer", validWorker, { finalizer: false }],
  ["worker", "failed finalizer", validWorker, { finalizerError: true }],
  ["reviewer", "wrong task id", { ...validReview, taskId: "1.2" }],
  ["reviewer", "wrong result kind", { ...validReview, kind: "worker" }],
  ["reviewer", "truthy non-boolean approval", { ...validReview, approved: "true" }],
  ["reviewer", "missing verification", without(validReview, "verification")],
  ["reviewer", "result file without finalizer", validReview, { finalizer: false }],
];

for (const [role, name, result, options = {}] of invalidResults) {
  test(`invalid ${role} result (${name}) cannot mark a task done`, async t => {
    const h = createHarness(t);
    h.start();
    const worker = await h.nextPrompt("worker", "1.1");
    let session = worker;
    if (role === "reviewer") {
      await h.finish(worker);
      session = await h.nextPrompt("reviewer", "1.1");
    }
    await h.command(session, { action: "raw", result, ...options });
    const retry = await h.nextPrompt(role, "1.1");
    assertNotDone(h);
    if (role === "reviewer") {
      await h.finish(retry, { approved: false, summary: "Synthetic rejection ends review", issues: ["Needs fixture repair"] });
      session = await h.nextPrompt("worker", "1.1");
    } else session = retry;
    await h.finish(session, { status: "blocked", summary: "Synthetic fixture dependency", blocker: "Fixture intentionally cannot continue" });
    await h.exit();
    assert.equal(h.state().status, "blocked");
    assertNotDone(h);
  });
}

test("bootstrap reviewer cannot approve a different plan revision", async t => {
  const h = createHarness(t, [bootstrapTask()]);
  const before = activeFiles(h);
  h.start();
  const { reviewer } = await submitPlan(h, [task("1.1")]);
  await h.finish(reviewer, { planRevision: "different-proposal-revision" });
  await h.exit(null);
  assert.equal(h.state().status, "failed");
  assertNotDone(h, "0.1");
  assert.deepEqual(activeFiles(h), before);
  assert.equal(readJson(h.paths.commit), null);
  assert.deepEqual(sequence(h), ["worker:0.1", "reviewer:0.1"]);
});

test("user approval pauses only the flagged step, then resumes it and subsequent work", async t => {
  const h = createHarness(t, [bootstrapTask()]);
  h.start();
  const { reviewer } = await submitPlan(h, [task("1.1"), task("1.2", { requiresUserApproval: true }), task("1.3")]);
  await h.finish(reviewer);
  await finishTask(h, "1.1");
  await h.exit();
  assert.equal(h.state().status, "waiting-user");
  assert.equal(h.state().currentTaskId, "1.2");
  assert.deepEqual(statuses(h), [["1.1", "done"], ["1.2", "waiting"], ["1.3", "pending"]]);
  assert.deepEqual(sequence(h), ["worker:0.1", "reviewer:0.1", "worker:1.1", "reviewer:1.1"]);
  assert.ok(h.plan().includes("- [x] 1.1"));
  assert.ok(h.plan().includes("- [ ] 1.2"));
  assert.ok(h.plan().includes("- [ ] 1.3"));

  // Simulate the user's grant only in this fixture's active task document.
  const tasks = readJson(h.paths.tasksFile);
  tasks.tasks.find(item => item.id === "1.2").requiresUserApproval = false;
  atomicJson(h.paths.tasksFile, tasks);
  h.start();
  await finishTask(h, "1.2");
  await finishTask(h, "1.3");
  await h.exit();
  assert.equal(h.state().status, "complete");
  assert.deepEqual(statuses(h), [["1.1", "done"], ["1.2", "done"], ["1.3", "done"]]);
  assert.deepEqual(sequence(h), ["worker:0.1", "reviewer:0.1", "worker:1.1", "reviewer:1.1", "worker:1.2", "reviewer:1.2", "worker:1.3", "reviewer:1.3"]);
});
