import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { atomicJson, planPaths, readJson } from "../plan-store.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const supervisor = resolve(directory, "../supervisor.mjs");
const fakePi = join(directory, "fixtures", "fake-pi.mjs");
const isolation = pathToFileURL(join(directory, "fixtures", "supervisor-isolation.mjs")).href;

const deferred = () => {
  let resolvePromise;
  const promise = new Promise(done => { resolvePromise = done; });
  return { promise, resolve: resolvePromise };
};

export const task = (id, overrides = {}) => ({ id, title: `Fixture task ${id}`, scope: `Only synthetic scope ${id}`,
  acceptance: [`Verify synthetic fixture ${id}`], status: "pending", requiresUserApproval: false, ...overrides });
export const bootstrapTask = () => task("0.1", { kind: "planner", canManagePlan: true });

export function createHarness(t, tasks = [task("1.1")]) {
  const root = mkdtempSync(join(tmpdir(), "autopilot-supervisor-test-"));
  const paths = planPaths(root, join(root, ".agent", "GOAL.md"), join(root, "PLAN.md"), join(root, ".agent", "tasks.json"));
  const stateFile = join(root, ".agent", "state.json");
  const journalFile = join(root, ".agent", "journal.md");
  const configFile = join(root, ".agent", "autopilot.json");
  const runs = [];
  const trace = [];
  let active;
  mkdirSync(join(root, ".agent"));
  mkdirSync(join(root, "home"));
  writeFileSync(paths.goalFile, "Synthetic regression goal. No external resources exist or are needed.\n");
  writeFileSync(paths.planFile, tasks.map(item => `- [ ] ${item.id} ${item.title}\n`).join(""));
  atomicJson(paths.tasksFile, { version: 1, projectName: "regression-fixture", tasks });
  atomicJson(configFile, {
    projectRoot: root, goalFile: paths.goalFile, planFile: paths.planFile, tasksFile: paths.tasksFile,
    stateFile, journalFile, userActionFile: join(root, ".agent", "USER_ACTION_REQUIRED.md"),
    runDirectory: join(root, "runs"), piSessionDirectory: join(root, "sessions"),
    nodeExecutable: process.execPath, piCli: fakePi, extension: join(directory, "fixtures", "unused-extension.mjs"),
    remoteHost: "fixture@no-network.invalid", remoteCwd: "/synthetic-fixture", sshKeyPath: join(root, "nonexistent-fixture-key"),
    provider: "fixture", model: "fixture", thinking: "high", contextWindow: 24576, attemptTimeoutMinutes: null,
  });

  // Deliberately do not inherit model tokens, SSH agent sockets, NODE_OPTIONS, or user Pi configuration.
  const env = Object.fromEntries(["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "TMPDIR", "PATHEXT"].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  Object.assign(env, { PATH: dirname(process.execPath), USERPROFILE: join(root, "home"), HOME: join(root, "home"),
    APPDATA: join(root, "home"), LOCALAPPDATA: join(root, "home"), AUTOPILOT_TEST_ROOT: root, AUTOPILOT_TEST_PI: fakePi });

  function launch(command) {
    const child = spawn(process.execPath, ["--import", isolation, supervisor, command, configFile], {
      cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const closed = deferred();
    const failed = deferred();
    const record = { child, closed, failed, exited: false, events: [], waiters: new Set(), pis: new Map(), output: "", error: null, cursor: 0 };
    runs.push(record);
    const publish = event => {
      record.events.push(event);
      for (const wake of [...record.waiters]) wake();
    };
    record.fail = error => {
      record.error ||= error;
      failed.resolve(record.error);
      for (const wake of [...record.waiters]) wake();
    };
    child.stdout.on("data", chunk => { record.output += chunk; });
    child.stderr.on("data", chunk => { record.output += chunk; });
    child.on("error", error => record.fail(error));
    child.on("message", message => {
      if (message.type === "pi-spawn") record.pis.set(message.pid, deferred());
      if (message.type === "pi-exit") record.pis.get(message.pid)?.resolve();
      if (message.type === "pi-event") {
        const event = { ...message.event, pid: message.pid };
        if (event.type === "fixture-error") record.fail(new Error(event.message));
        if (event.type === "prompt") trace.push(event);
        publish(event);
      } else publish(message);
    });
    child.once("close", (code, signal) => {
      clearTimeout(watchdog);
      record.exited = true;
      const event = { type: "supervisor-exit", code, signal };
      publish(event);
      closed.resolve(event);
    });
    // This deadline only fails/cleans up a hung test; no scenario transition depends on elapsed time.
    const watchdog = setTimeout(() => record.fail(new Error(`Fixture exceeded cleanup deadline.\n${record.output}`)), 20_000);
    record.wait = predicate => new Promise((done, reject) => {
      const check = () => {
        const event = record.events.find(predicate);
        if (record.error || event || record.exited) {
          record.waiters.delete(check);
          if (record.error) reject(record.error);
          else if (event) done(event);
          else reject(new Error(`Supervisor exited before expected fixture event.\n${record.output}`));
        }
      };
      record.waiters.add(check);
      check();
    });
    record.guard = promise => Promise.race([promise, failed.promise.then(error => { throw error; })]);
    record.cleanup = async () => {
      clearTimeout(watchdog);
      if (!record.exited && child.connected) {
        const cleaned = new Promise(done => {
          const listener = message => {
            if (message.type === "fixture-cleaned") { child.off("message", listener); done(); }
          };
          child.on("message", listener);
          child.send({ type: "fixture-cleanup" });
        });
        await Promise.race([cleaned, closed.promise]);
      }
      // The bridge reports actual close events from all fake Pi descendants before root deletion.
      await Promise.all([...record.pis.values()].map(item => item.promise));
      if (!record.exited) child.kill("SIGKILL");
      await closed.promise;
    };
    return record;
  }

  t.after(async () => {
    for (const record of runs) await record.cleanup();
    const resolvedRoot = resolve(root);
    const rel = relative(resolve(tmpdir()), resolvedRoot);
    assert.ok(rel.startsWith("autopilot-supervisor-test-") && !isAbsolute(rel) && !rel.includes(".."));
    rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  const harness = {
    root, paths, stateFile, journalFile, trace,
    start() { active = launch("start"); return active; },
    state: () => readJson(stateFile),
    plan: () => readFileSync(paths.planFile, "utf8"),
    async nextTurn() {
      const record = active;
      const event = await record.wait((item, index) => index >= record.cursor && ["prompt", "supervisor-exit"].includes(item.type));
      record.cursor = record.events.indexOf(event) + 1;
      return event;
    },
    async nextPrompt(role, taskId) {
      const event = await harness.nextTurn();
      assert.equal(event.type, "prompt", `Expected ${role} ${taskId}.\n${active.output}`);
      assert.deepEqual([event.role, event.taskId], [role, taskId], `Unexpected next role/task.\n${active.output}`);
      return event;
    },
    async command(session, command) {
      const record = active;
      const since = record.events.length;
      record.child.send({ type: "pi-command", pid: session.pid, command });
      return record.wait((event, index) => index >= since && event.pid === session.pid && event.type === (command.action === "handoff" ? "handoff" : "result"));
    },
    finish: (session, patch = {}) => harness.command(session, { action: "complete", patch }),
    async exit(expectedCode = 0) {
      const event = await active.guard(active.closed.promise);
      if (expectedCode !== null) assert.equal(event.code, expectedCode, active.output);
      return event;
    },
    async stop() {
      const record = launch("stop");
      const event = await record.guard(record.closed.promise);
      assert.equal(event.code, 0, record.output);
      await harness.exit();
    },
  };
  return harness;
}
