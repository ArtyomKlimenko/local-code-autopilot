import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import {
  atomicJson, checkProposal, commitPlan, digest, planPaths, planningSnapshot,
  readJson, recoverPlanCommit, renderPlan, savePlanBatch, toolNames, validateResult,
} from "../plan-store.mjs";

const task = (id, overrides = {}) => ({
  id, title: `Task ${id}`, scope: `Fixture scope ${id}`,
  acceptance: [`Verify fixture ${id}`], requiresUserApproval: false, ...overrides,
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "autopilot-plan-test-"));
  t.after(() => {
    const resolvedRoot = resolve(root);
    const rel = relative(resolve(tmpdir()), resolvedRoot);
    assert.ok(rel.startsWith("autopilot-plan-test-") && !isAbsolute(rel) && !rel.includes(".."));
    rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 3 });
  });
  mkdirSync(join(root, ".agent"));
  const paths = planPaths(root, join(root, ".agent", "GOAL.md"), join(root, "PLAN.md"), join(root, ".agent", "tasks.json"));
  writeFileSync(paths.goalFile, "Synthetic goal: verify only temporary fixture files.\n");
  writeFileSync(paths.planFile, "- [ ] 0.1 Bootstrap fixture\n");
  atomicJson(paths.tasksFile, { version: 1, tasks: [{ id: "0.1", kind: "planner", status: "pending" }] });
  return paths;
}

const mirrors = paths => [paths.planFile, paths.tasksFile].map(path => readFileSync(path, "utf8"));
const approval = proposal => ({ kind: "review", taskId: "0.1", approved: true,
  planRevision: proposal.revision, summary: "Fixture plan approved", issues: [], verification: ["Checked fixture"] });
const submit = paths => savePlanBatch(paths, { summary: "Fixture plan", tasks: [task("1.1"), task("1.2")] });

test("batches merge by id in insertion order, normalize fields, and publish only the completed proposal", t => {
  const paths = fixture(t);
  const activeBefore = mirrors(paths);
  const first = savePlanBatch(paths, { tasks: [task("1.1"), task("1.2")], summary: "  Fixture plan  ", complete: false });
  assert.equal(first.submitted, false);
  assert.equal(readJson(paths.proposal), null);
  assert.deepEqual(mirrors(paths), activeBefore);

  const updated = task("1.1", { title: "  Updated first  ", scope: "  Focused scope  ", acceptance: ["  Focused check  "] });
  const submitted = savePlanBatch(paths, { tasks: [updated, task("1.3")], complete: true });
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.summary, "Fixture plan");
  assert.deepEqual(submitted.tasks.map(item => item.id), ["1.1", "1.2", "1.3"]);
  assert.deepEqual(submitted.tasks[0], task("1.1", { title: "Updated first", scope: "Focused scope", acceptance: ["Focused check"], status: "pending" }));
  assert.deepEqual(readJson(paths.draft), readJson(paths.proposal));
  assert.equal(checkProposal(paths, submitted.revision).revision, submitted.revision);
  assert.notEqual(first.revision, submitted.revision);
  assert.deepEqual(mirrors(paths), activeBefore);

  savePlanBatch(paths, { tasks: [task("1.4")], complete: false });
  assert.equal(readJson(paths.proposal).revision, submitted.revision, "partial follow-up must not replace the submitted revision");
  assert.equal(readJson(paths.draft).tasks.length, 4);
});

test("identical batches have a stable content revision and replace discards prior tasks", t => {
  const paths = fixture(t);
  const original = submit(paths);
  assert.equal(submit(paths).revision, original.revision);
  const replaced = savePlanBatch(paths, { summary: "Replacement", tasks: [task("2.1")], replace: true });
  assert.deepEqual(replaced.tasks.map(item => item.id), ["2.1"]);
  const { revision, submitted, ...content } = replaced;
  assert.equal(revision, digest(content));
  assert.equal(submitted, true);
  assert.notEqual(revision, original.revision);
});

const malformedBatches = [
  ["missing array", undefined], ["object instead of array", {}], ["empty array", []],
  ["null task", [null]], ["numeric id", [task(1)]], ["reserved bootstrap id", [task("0.1")]],
  ["non-numeric id", [task("task-1")]], ["empty id segment", [task("1..2")]],
  ["duplicate ids within one batch", [task("1.1"), task("1.1", { title: "Duplicate" })]],
  ["blank title", [task("1.1", { title: " " })]], ["missing scope", [task("1.1", { scope: undefined })]],
  ["blank scope", [task("1.1", { scope: "\n" })]],
  ["missing acceptance", [task("1.1", { acceptance: undefined })]],
  ["empty acceptance", [task("1.1", { acceptance: [] })]],
  ["string acceptance", [task("1.1", { acceptance: "Check" })]],
  ["blank criterion", [task("1.1", { acceptance: ["Check", " "] })]],
  ["non-string criterion", [task("1.1", { acceptance: [false] })]],
  ["missing approval flag", [task("1.1", { requiresUserApproval: undefined })]],
  ["truthy approval flag", [task("1.1", { requiresUserApproval: "false" })]],
  ["already done", [task("1.1", { status: "done" })]],
  ["already running", [task("1.1", { status: "running" })]],
];

for (const [name, tasks] of malformedBatches) {
  test(`rejects ${name} without changing a valid draft, proposal, or active plan`, t => {
    const paths = fixture(t);
    submit(paths);
    const before = [...mirrors(paths), readFileSync(paths.draft, "utf8"), readFileSync(paths.proposal, "utf8")];
    assert.throws(() => savePlanBatch(paths, { tasks, summary: "Invalid replacement", replace: true }));
    assert.deepEqual([...mirrors(paths), readFileSync(paths.draft, "utf8"), readFileSync(paths.proposal, "utf8")], before);
    assert.equal(readJson(paths.commit), null);
  });
}

test("proposal cannot publish active tasks until its exact revision has an affirmative review", t => {
  const paths = fixture(t);
  const before = mirrors(paths);
  const first = submit(paths);
  for (const review of [null, { ...approval(first), approved: false }, { ...approval(first), approved: "true" }, { ...approval(first), planRevision: "other-revision" }]) {
    assert.throws(() => commitPlan(paths, first.revision, review), /exact plan revision/i);
    assert.deepEqual(mirrors(paths), before);
    assert.equal(readJson(paths.commit), null);
  }

  const second = savePlanBatch(paths, { tasks: [task("1.1", { title: "Revised after review" })] });
  assert.throws(() => commitPlan(paths, first.revision, approval(first)), /stale|changed/i);
  assert.throws(() => commitPlan(paths, second.revision, approval(first)), /exact plan revision/i);
  assert.deepEqual(mirrors(paths), before);
  const committed = commitPlan(paths, second.revision, approval(second));
  assert.equal(committed.revision, second.revision);
  assert.deepEqual(readJson(paths.tasksFile).tasks, second.tasks);
  assert.equal(readJson(paths.tasksFile).planRevision, second.revision);
  assert.equal(readFileSync(paths.planFile, "utf8"), renderPlan(second));
  assert.equal(readJson(paths.commit).applied, true);
});

test("tampering with a submitted proposal fails its content integrity check", t => {
  const paths = fixture(t);
  const before = mirrors(paths);
  const proposal = submit(paths);
  const tampered = readJson(paths.proposal);
  tampered.tasks[0].scope = "Changed without updating revision";
  atomicJson(paths.proposal, tampered);
  assert.throws(() => checkProposal(paths, proposal.revision), /integrity/i);
  assert.throws(() => commitPlan(paths, proposal.revision, approval(proposal)), /integrity/i);
  assert.deepEqual(mirrors(paths), before);
});

test("changed goal hides and rejects the old proposal and starts a fresh draft", t => {
  const paths = fixture(t);
  const before = mirrors(paths);
  const old = submit(paths);
  writeFileSync(paths.goalFile, "A different synthetic fixture goal.\n");
  const snapshot = planningSnapshot(paths);
  assert.equal(snapshot.draft, null);
  assert.equal(snapshot.proposal, null);
  assert.throws(() => checkProposal(paths, old.revision), /stale|absent/i);
  assert.throws(() => commitPlan(paths, old.revision, approval(old)), /stale|absent/i);
  assert.deepEqual(mirrors(paths), before);
  assert.equal(readJson(paths.commit), null);
  const fresh = savePlanBatch(paths, { tasks: [task("2.1")], summary: "New goal plan" });
  assert.deepEqual(fresh.tasks.map(item => item.id), ["2.1"]);
  assert.notEqual(fresh.goalHash, old.goalHash);
  assert.notEqual(fresh.revision, old.revision);
});

for (const crashPoint of ["before mirrors", "tasks mirror written", "plan mirror written", "both mirrors written"]) {
  test(`recovers a durable approved commit after crash: ${crashPoint}`, t => {
    const paths = fixture(t);
    const proposal = submit(paths);
    const review = approval(proposal);
    // Seed the exact durable journal/mirror states left by interrupted application.
    atomicJson(paths.commit, { proposal: readJson(paths.proposal), review, applied: false });
    if (["tasks mirror written", "both mirrors written"].includes(crashPoint)) {
      atomicJson(paths.tasksFile, { version: 1, planRevision: proposal.revision, tasks: proposal.tasks });
    }
    if (["plan mirror written", "both mirrors written"].includes(crashPoint)) writeFileSync(paths.planFile, renderPlan(proposal));

    recoverPlanCommit(paths);
    assert.deepEqual(readJson(paths.tasksFile).tasks, proposal.tasks);
    assert.equal(readJson(paths.tasksFile).planRevision, proposal.revision);
    assert.equal(readFileSync(paths.planFile, "utf8"), renderPlan(proposal));
    assert.equal(readJson(paths.commit).applied, true);
    assert.deepEqual(readJson(paths.commit).review, review);

    const progressed = readJson(paths.tasksFile);
    progressed.tasks[0].status = "done";
    atomicJson(paths.tasksFile, progressed);
    writeFileSync(paths.planFile, renderPlan(proposal).replace("- [ ] 1.1", "- [x] 1.1"));
    const afterProgress = mirrors(paths);
    recoverPlanCommit(paths);
    assert.deepEqual(mirrors(paths), afterProgress, "applied recovery must not reset completed work");
  });
}

for (const invalid of ["not approved", "different revision", "changed goal"]) {
  test(`recovery refuses ${invalid} without publishing pending commit`, t => {
    const paths = fixture(t);
    const proposal = submit(paths);
    const review = approval(proposal);
    if (invalid === "not approved") review.approved = false;
    if (invalid === "different revision") review.planRevision = "stale-review";
    if (invalid === "changed goal") writeFileSync(paths.goalFile, "New fixture goal\n");
    atomicJson(paths.commit, { proposal: readJson(paths.proposal), review, applied: false });
    const before = mirrors(paths);
    assert.throws(() => recoverPlanCommit(paths), /approval|goal changed/i);
    assert.deepEqual(mirrors(paths), before);
    assert.equal(readJson(paths.commit).applied, false);
  });
}

test("protocol tools distinguish both bootstrap roles from ordinary execution", () => {
  assert.deepEqual(toolNames("worker", true), ["read_plan", "inspect_project", "read", "save_bootstrap_plan"]);
  assert.deepEqual(toolNames("reviewer", true), ["read_plan", "finish_review"]);
  assert.deepEqual(toolNames("worker", false), ["read", "bash", "edit", "write", "request_user_action", "finish_step"]);
  assert.deepEqual(toolNames("reviewer", false), ["read", "bash", "finish_review"]);
});

test("worker/reviewer results require matching identity, schema, and a bootstrap plan revision", () => {
  const worker = { kind: "worker", taskId: "1.1", status: "complete", summary: "Fixture completed", changedFiles: [], verification: [], evidence: [] };
  const reviewer = { kind: "review", taskId: "1.1", approved: true, summary: "Fixture reviewed", issues: [], verification: [] };
  assert.deepEqual(validateResult(worker, "worker", "1.1"), worker);
  assert.deepEqual(validateResult(reviewer, "reviewer", "1.1"), reviewer);
  for (const patch of [{ taskId: "1.2" }, { kind: "review" }, { status: "done" }, { evidence: undefined }, { changedFiles: null }, { verification: "PASS" }, { summary: undefined }]) {
    assert.throws(() => validateResult({ ...worker, ...patch }, "worker", "1.1"));
  }
  for (const patch of [{ taskId: "1.2" }, { kind: "worker" }, { approved: "true" }, { issues: undefined }, { verification: "PASS" }]) {
    assert.throws(() => validateResult({ ...reviewer, ...patch }, "reviewer", "1.1"));
  }
  assert.throws(() => validateResult({ ...worker, taskId: "0.1" }, "worker", "0.1", true), /revision/i);
  assert.doesNotThrow(() => validateResult({ ...worker, taskId: "0.1", planRevision: "fixture-revision" }, "worker", "0.1", true));
});
