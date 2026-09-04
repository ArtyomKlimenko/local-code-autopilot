import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const configuredPackage = process.env.LOCAL_AUTOPILOT_PI_PACKAGE;
const packageRoot = configuredPackage ? resolve(configuredPackage) : null;
const skipReason = !packageRoot ? "Set LOCAL_AUTOPILOT_PI_PACKAGE to an installed Pi package to enable no-model extension contracts"
  : !existsSync(join(packageRoot, "package.json")) ? "Configured optional Pi package is absent" : false;

const finalizers = [
  { role: "worker", bootstrap: false, finalizer: "finish_step" },
  { role: "worker", bootstrap: false, finalizer: "request_user_action" },
  { role: "reviewer", bootstrap: false, finalizer: "finish_review" },
  { role: "planner", bootstrap: false, finalizer: "finish_replan" },
  { role: "worker", bootstrap: true, finalizer: "save_bootstrap_plan" },
  { role: "reviewer", bootstrap: true, finalizer: "finish_review" },
];

const scenarios = [
  { name: "plan reviewer exposes only read_plan/finish_review and the protocol-2 manifest", scenario: "plan-review", role: "reviewer", bootstrap: true },
  ...finalizers.map(entry => ({ ...entry, scenario: "mixed", name: `${entry.bootstrap ? "bootstrap " : ""}${entry.role} blocks ${entry.finalizer} in a mixed tool batch` })),
  ...finalizers.map(entry => ({ ...entry, scenario: "after-result", name: `${entry.bootstrap ? "bootstrap " : ""}${entry.role} permits no further tools after ${entry.finalizer}` })),
  { name: "session_before_compact cancels compaction", scenario: "compact", role: "worker", bootstrap: false },
  { name: "Windows read adapter maps absolute Linux source paths to the configured VM root", scenario: "absolute-read", role: "worker", bootstrap: false, windows: true },
  { name: "normalized parent traversal and sibling prefixes cannot escape the remote read adapter", scenario: "escape-read", role: "worker", bootstrap: false },
];

for (const scenario of scenarios) {
  const skip = skipReason || (scenario.windows && process.platform !== "win32" ? "Windows-specific Pi path adapter contract" : false);
  test(`extension: ${scenario.name}`, { skip }, async t => {
    const root = mkdtempSync(join(tmpdir(), "autopilot-extension-test-"));
    let child;
    let closed;
    let deadline;
    let exited = false;
    let expired = false;
    t.after(async () => {
      clearTimeout(deadline);
      if (child && !exited) child.kill("SIGKILL");
      if (closed) await closed;
      const target = resolve(root);
      const rel = relative(resolve(tmpdir()), target);
      assert.ok(rel.startsWith("autopilot-extension-test-") && !isAbsolute(rel) && !rel.includes(".."));
      rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    });
    mkdirSync(join(root, ".agent"));
    mkdirSync(join(root, "home"));
    writeFileSync(join(root, ".agent", "GOAL.md"), "Synthetic extension contract goal, with no external dependencies.\n");
    writeFileSync(join(root, "PLAN.md"), "- [ ] 0.1 Synthetic bootstrap\n");
    writeFileSync(join(root, ".agent", "tasks.json"), JSON.stringify({ tasks: [{ id: "0.1", status: "pending" }] }));

    const env = Object.fromEntries(["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "TMPDIR", "PATHEXT"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
    Object.assign(env, {
      PATH: dirname(process.execPath), HOME: join(root, "home"), USERPROFILE: join(root, "home"),
      APPDATA: join(root, "home"), LOCALAPPDATA: join(root, "home"),
      PI_CODING_AGENT_DIR: join(root, "home", ".pi"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      LOCAL_AUTOPILOT_PI_PACKAGE: packageRoot, AUTOPILOT_EXTENSION_TEST_ROOT: root,
      LOCAL_AUTOPILOT_ROLE: scenario.role, LOCAL_AUTOPILOT_TASK_ID: scenario.bootstrap ? "0.1" : "1.1",
      LOCAL_AUTOPILOT_BOOTSTRAP: scenario.bootstrap ? "1" : "0",
      LOCAL_AUTOPILOT_GOAL_FILE: join(root, ".agent", "GOAL.md"),
      LOCAL_AUTOPILOT_BOOTSTRAP_PLAN_FILE: scenario.bootstrap ? join(root, "PLAN.md") : "",
      LOCAL_AUTOPILOT_BOOTSTRAP_TASKS_FILE: scenario.bootstrap ? join(root, ".agent", "tasks.json") : "",
      LOCAL_AUTOPILOT_READY_FILE: join(root, ".agent", "ready.json"),
      LOCAL_AUTOPILOT_RESULT_FILE: join(root, ".agent", "result.json"),
      LOCAL_AUTOPILOT_ACTIVITY_FILE: join(root, ".agent", "activity.jsonl"),
      LOCAL_AUTOPILOT_ACTION_FILE: join(root, ".agent", "USER_ACTION_REQUIRED.md"),
      LOCAL_AUTOPILOT_SYSTEM_PROMPT: "Synthetic extension contract system prompt",
      LOCAL_AUTOPILOT_REMOTE_HOST: "fixture@no-network.invalid", LOCAL_AUTOPILOT_REMOTE_CWD: "/fixture/project",
      LOCAL_AUTOPILOT_SSH_KEY: join(root, "nonexistent-fixture-key"),
    });
    child = spawn(process.execPath, [join(directory, "fixtures", "extension-contract.mjs"), JSON.stringify(scenario)], {
      cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let spawnError;
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.on("error", error => { spawnError = error; });
    closed = new Promise(done => child.once("close", (code, signal) => {
      exited = true;
      clearTimeout(deadline);
      done({ code, signal });
    }));
    // A hang fails the test; the deadline is only a process cleanup backstop.
    deadline = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 30_000);
    const outcome = await closed;
    assert.equal(expired, false, `Extension fixture exceeded cleanup deadline.\n${output}`);
    assert.ifError(spawnError);
    assert.equal(outcome.code, 0, output);
    assert.match(output, /EXTENSION_CONTRACT_OK/, "Fixture must complete assertions and shutdown cleanup");
  });
}
