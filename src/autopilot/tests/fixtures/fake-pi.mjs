import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { atomicJson, planPaths, planningSnapshot, PROTOCOL_VERSION, savePlanBatch, toolNames } from "../../plan-store.mjs";

const notify = (event, callback) => process.send?.(event, callback);
const rpc = event => process.stdout.write(JSON.stringify(event) + "\n");
function fatal(error) {
  process.stderr.write(String(error.stack || error) + "\n");
  if (process.connected) notify({ type: "fixture-error", message: String(error.stack || error) }, () => process.exit(1));
  else process.exit(1);
}

try {
  assert.ok(process.send, "Fake Pi requires the test isolation IPC bridge");
  const root = process.env.AUTOPILOT_TEST_ROOT;
  assert.equal(resolve(process.cwd()), resolve(root));
  const role = process.env.LOCAL_AUTOPILOT_ROLE;
  const taskId = process.env.LOCAL_AUTOPILOT_TASK_ID;
  const bootstrap = process.env.LOCAL_AUTOPILOT_BOOTSTRAP === "1";
  assert.equal(bootstrap, taskId === "0.1", "both bootstrap worker and reviewer need LOCAL_AUTOPILOT_BOOTSTRAP=1");
  const localPath = name => {
    const value = process.env[name];
    assert.ok(value, `${name} must be exported by supervisor`);
    const path = resolve(value);
    const rel = relative(root, path);
    assert.ok(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"), `${name} must stay in the temporary fixture`);
    return path;
  };
  const resultFile = localPath("LOCAL_AUTOPILOT_RESULT_FILE");
  const readyFile = localPath("LOCAL_AUTOPILOT_READY_FILE");
  const paths = bootstrap ? planPaths(root, localPath("LOCAL_AUTOPILOT_GOAL_FILE"), localPath("LOCAL_AUTOPILOT_BOOTSTRAP_PLAN_FILE"), localPath("LOCAL_AUTOPILOT_BOOTSTRAP_TASKS_FILE")) : null;
  const tools = toolNames(role, bootstrap);
  const cliTools = process.argv[process.argv.indexOf("--tools") + 1]?.split(",");
  assert.deepEqual(cliTools?.slice().sort(), tools.slice().sort(), "CLI tools must match the readiness manifest");
  assert.ok(process.argv.includes("--system-prompt"), "supervisor must replace the default system prompt");
  assert.ok(!process.argv.includes("--append-system-prompt"));
  assert.equal(process.argv[process.argv.indexOf("--system-prompt") + 1], process.env.LOCAL_AUTOPILOT_SYSTEM_PROMPT);
  const manifest = { protocol: PROTOCOL_VERSION, role, taskId, tools };
  assert.equal(PROTOCOL_VERSION, 2);
  atomicJson(readyFile, manifest);
  const session = { role, taskId, bootstrap, resultFile, readyFile, manifest,
    goalFile: paths?.goalFile, planFile: paths?.planFile, tasksFile: paths?.tasksFile };
  notify({ type: "ready", ...session });
  let contextTokens = 0;

  function finish(command) {
    let result;
    if (command.action === "raw") {
      result = command.result;
    } else if (role === "worker") {
      result = { kind: "worker", taskId, status: "complete", summary: `Worker evidence for ${taskId}`,
        changedFiles: [`fixture-${taskId}.txt`], verification: [`Verify ${taskId}`], evidence: [`PASS ${taskId}`], blocker: "" };
      if (bootstrap) {
        assert.equal(command.action, "plan", "bootstrap worker must submit a plan batch");
        const proposal = savePlanBatch(paths, { summary: command.summary || "Synthetic implementation plan", tasks: command.tasks, complete: true });
        result.planRevision = proposal.revision;
        result.changedFiles = [".agent/planning/proposal.json"];
      }
      Object.assign(result, command.patch);
    } else if (role === "reviewer") {
      result = { kind: "review", taskId, approved: true, summary: `Review evidence for ${taskId}`, issues: [], verification: [`Review ${taskId}`] };
      if (bootstrap) result.planRevision = planningSnapshot(paths).proposal?.revision;
      Object.assign(result, command.patch);
    } else {
      assert.equal(role, "planner");
      result = { kind: "replan", taskId, diagnosis: "Synthetic recovery", steps: command.steps };
    }
    if (command.text !== undefined) writeFileSync(resultFile, command.text);
    else atomicJson(resultFile, result);
    const toolName = bootstrap && role === "worker" ? "save_bootstrap_plan"
      : role === "worker" ? "finish_step" : role === "reviewer" ? "finish_review" : "finish_replan";
    notify({ type: "result", ...session, result, text: readFileSync(resultFile, "utf8") }, () => {
      if (command.finalizer !== false) rpc({ type: "tool_execution_end", toolName, isError: command.finalizerError === true, result: {} });
      rpc({ type: "agent_settled" });
    });
  }

  process.on("message", command => {
    try {
      if (command.action === "handoff") {
        notify({ type: "handoff", ...session });
        if (command.via === "stats") contextTokens = 1_000_000;
        else rpc({ type: "compaction_start" });
      } else finish(command);
    } catch (error) { fatal(error); }
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", line => {
    try {
      const request = JSON.parse(line);
      rpc({ type: "response", id: request.id, command: request.type, success: true,
        ...(request.type === "get_session_stats" ? { data: { contextUsage: { tokens: contextTokens } } } : {}) });
      if (request.type === "prompt") notify({ type: "prompt", ...session, prompt: request.message });
      if (request.type === "abort") {
        notify({ type: "aborted", ...session }, () => process.exit(0));
      }
    } catch (error) { fatal(error); }
  });
  input.on("close", () => process.exit(0));
  process.on("disconnect", () => process.exit(0));
} catch (error) { fatal(error); }
