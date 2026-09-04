import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { mock } from "node:test";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { planPaths, readJson, savePlanBatch, toolNames } from "../../plan-store.mjs";

const scenario = JSON.parse(process.argv[2]);
const root = process.env.AUTOPILOT_EXTENSION_TEST_ROOT;
assert.ok(root && process.env.LOCAL_AUTOPILOT_PI_PACKAGE, "Run through extension-contract.test.mjs");
assert.equal(process.cwd(), resolve(root));
const packageRoot = process.env.LOCAL_AUTOPILOT_PI_PACKAGE;
const requirePi = createRequire(join(packageRoot, "package.json"));
const remoteRoot = "/fixture/project";
const resultFile = process.env.LOCAL_AUTOPILOT_RESULT_FILE;
const keyPath = process.env.LOCAL_AUTOPILOT_SSH_KEY;
const blockedOperations = [];
const spawns = [];
const children = new Set();
const source = "Synthetic remote source\nsecond line\n";
const outputByCommand = new Map([
  [`test -r '${remoteRoot}/src/main.ts'`, ""],
  [`file --mime-type -b -- '${remoteRoot}/src/main.ts'`, "text/plain\n"],
  [`cat -- '${remoteRoot}/src/main.ts'`, source],
]);

function forbid(operation) {
  blockedOperations.push(operation);
  throw new Error(`Extension contract forbids ${operation}`);
}

// Patch before importing Pi factories or transpiling the real extension.
for (const method of ["exec", "execFile", "execSync", "execFileSync", "spawnSync", "fork"]) mock.method(childProcess, method, () => forbid(method));
mock.method(globalThis, "fetch", () => forbid("network fetch"));
for (const [object, method] of [[net, "connect"], [net, "createConnection"], [net.Socket.prototype, "connect"], [tls, "connect"], [http, "get"], [http, "request"], [https, "get"], [https, "request"]]) {
  mock.method(object, method, () => forbid(`network ${method}`));
}
for (const [object, method] of [[fs, "readFileSync"], [fs, "readFile"], [fs, "createReadStream"], [fsPromises, "readFile"]]) {
  const original = object[method];
  mock.method(object, method, function (path, ...args) {
    if (typeof path === "string" && resolve(path) === resolve(keyPath)) return forbid("key read");
    return original.call(this, path, ...args);
  });
}
mock.method(childProcess, "spawn", (executable, args, options) => {
  const command = args.at(-1);
  spawns.push({ executable, args, options, command });
  if (scenario.scenario !== "absolute-read" || !outputByCommand.has(command)) return forbid(`unexpected process command: ${command}`);
  assert.equal(executable, "C:\\Windows\\System32\\OpenSSH\\ssh.exe");
  assert.equal(args[args.indexOf("-i") + 1], keyPath);
  assert.equal(args.at(-2), "fixture@no-network.invalid");
  assert.equal(options.windowsHide, true);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  children.add(child);
  let closed = false;
  const finish = (code, signal) => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    child.stderr.end();
    children.delete(child);
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  child.kill = () => { queueMicrotask(() => finish(null, "SIGTERM")); return true; };
  queueMicrotask(() => {
    if (closed) return;
    child.stdout.write(outputByCommand.get(command));
    finish(0, null);
  });
  return child;
});
syncBuiltinESMExports();

const tools = new Map();
const hooks = new Map();
let activeTools = [];
const pi = {
  registerTool(tool) { assert.ok(!tools.has(tool.name), `Duplicate tool ${tool.name}`); tools.set(tool.name, tool); },
  on(name, handler) { const handlers = hooks.get(name) || []; handlers.push(handler); hooks.set(name, handlers); },
  setActiveTools(names) { activeTools = [...names]; },
  getActiveTools() { return [...activeTools]; },
};
async function emit(name, event = {}) {
  assert.ok(hooks.has(name), `Extension must register ${name}`);
  let result;
  for (const handler of hooks.get(name)) result = (await handler({ type: name, ...event }, { cwd: root })) ?? result;
  return result;
}
const call = (name, input = {}) => emit("tool_call", { toolName: name, toolCallId: `fixture-${name}`, input });
const execute = (name, input = {}) => tools.get(name).execute(`fixture-${name}`, input, new AbortController().signal, undefined, { cwd: root });
const batch = calls => emit("message_end", { message: { role: "assistant", content: calls.map(([name, args]) => ({ type: "toolCall", id: `fixture-${name}`, name, arguments: args })) } });
const planTask = { id: "1.1", title: "Synthetic task", scope: "Synthetic source only", acceptance: ["Synthetic verification"], requiresUserApproval: false };
const finalizerInput = name => ({
  finish_step: { status: "complete", summary: "Synthetic work verified", changedFiles: [], verification: ["Synthetic check"], evidence: ["PASS"], blocker: "" },
  request_user_action: { title: "Synthetic dependency", reason: "Fixture pauses", requiredActions: ["Acknowledge synthetic fixture"], verificationAfter: ["Check fixture acknowledgement"] },
  finish_review: { approved: true, summary: "Synthetic plan verified", issues: [], verification: ["Synthetic check"] },
  finish_replan: { diagnosis: "Synthetic recovery", steps: [{ title: "Repair fixture", scope: "Synthetic source", acceptance: ["Synthetic check"] }] },
  save_bootstrap_plan: { summary: "Synthetic implementation plan", tasks: [planTask], complete: true },
})[name];
const peer = scenario.bootstrap ? (scenario.role === "worker" ? "inspect_project" : "read_plan") : "read";
const peerInput = peer === "read_plan" ? {} : { path: "src/main.ts" };

try {
  // Use the installed factories and schema helpers without importing a CLI, session, or model registry.
  const importFile = path => import(pathToFileURL(path).href);
  const { createJiti } = await importFile(requirePi.resolve("jiti"));
  const resolver = createJiti(pathToFileURL(join(packageRoot, "dist", "index.js")).href, { fsCache: false });
  const installedTools = {};
  for (const name of ["read", "bash", "edit", "write"]) Object.assign(installedTools, await importFile(join(packageRoot, "dist", "core", "tools", `${name}.js`)));
  Object.assign(installedTools, await importFile(join(packageRoot, "dist", "core", "extensions", "types.js")));
  const aiDirectory = dirname(fileURLToPath(resolver.esmResolve("@earendil-works/pi-ai")));
  const enumModule = await importFile(join(aiDirectory, "utils", "typebox-helpers.js"));
  const typebox = await import(resolver.esmResolve("typebox"));
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, tryNative: false,
    virtualModules: { "@earendil-works/pi-coding-agent": installedTools, "@earendil-works/pi-ai": enumModule, typebox } });
  const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../pi-autopilot-extension.ts");
  const extension = await jiti.import(extensionPath, { default: true });
  await extension(pi);
  await emit("session_start");

  const paths = planPaths(root, process.env.LOCAL_AUTOPILOT_GOAL_FILE, join(root, "PLAN.md"), join(root, ".agent", "tasks.json"));
  const proposal = scenario.bootstrap ? savePlanBatch(paths, { summary: "Synthetic proposal", tasks: [planTask], complete: true }) : null;
  const before = [paths.planFile, paths.tasksFile].map(path => fs.readFileSync(path, "utf8"));
  assert.deepEqual([...tools.keys()].sort(), toolNames(scenario.role, scenario.bootstrap).sort());
  if (scenario.bootstrap) {
    const snapshot = JSON.parse((await execute("read_plan")).content[0].text);
    assert.match(snapshot.location, /LOCAL/);
    if (scenario.role === "reviewer") {
      assert.deepEqual(Object.keys(snapshot).sort(), ["goal", "location", "proposal"]);
      assert.equal(snapshot.goal, fs.readFileSync(paths.goalFile, "utf8"));
      assert.deepEqual(snapshot.proposal, readJson(paths.proposal));
    } else {
      assert.deepEqual(Object.keys(snapshot).sort(), ["draft", "goalNote", "location"]);
      assert.equal(typeof snapshot.goalNote, "string");
      assert.ok(snapshot.goalNote.trim());
      assert.ok(!snapshot.goalNote.includes(fs.readFileSync(paths.goalFile, "utf8").trim()));
      assert.deepEqual(snapshot.draft, readJson(paths.draft));
    }
  }

  if (scenario.scenario === "plan-review") {
    assert.deepEqual([...tools.keys()], ["read_plan", "finish_review"]);
    assert.deepEqual(activeTools, ["read_plan", "finish_review"]);
    assert.deepEqual(readJson(process.env.LOCAL_AUTOPILOT_READY_FILE), { protocol: 2, role: "reviewer", taskId: "0.1", tools: ["read_plan", "finish_review"] });
    const start = await emit("before_agent_start", { systemPrompt: "Default prompt that must be replaced" });
    assert.equal(start.systemPrompt, process.env.LOCAL_AUTOPILOT_SYSTEM_PROMPT);
    for (const name of ["read", "bash", "edit", "write", "inspect_project", "save_bootstrap_plan", "finish_step", "finish_replan"]) {
      assert.equal((await call(name)).block, true, `Plan reviewer must reject ${name}`);
    }
    await batch([["finish_review", finalizerInput("finish_review")]]);
    assert.equal((await call("finish_review", finalizerInput("finish_review")))?.block, undefined);
    const result = await execute("finish_review", finalizerInput("finish_review"));
    assert.equal(result.terminate, true);
    assert.equal(readJson(resultFile).planRevision, proposal.revision);
    assert.deepEqual([paths.planFile, paths.tasksFile].map(path => fs.readFileSync(path, "utf8")), before);
  } else if (scenario.scenario === "mixed") {
    const input = finalizerInput(scenario.finalizer);
    // The finalizer must be blocked in either position, before any peer tool runs.
    for (const calls of [[[peer, peerInput], [scenario.finalizer, input]], [[scenario.finalizer, input], [peer, peerInput]]]) {
      await batch(calls);
      const verdict = await call(scenario.finalizer, input);
      assert.equal(verdict?.block, true);
      assert.match(verdict.reason, /only tool call|separate.*turn/i);
      assert.equal((await call(peer, peerInput))?.block, undefined, "The non-finalizing peer remains usable");
      assert.equal(fs.existsSync(resultFile), false);
    }
    if (scenario.finalizer === "save_bootstrap_plan") {
      const partial = { ...input, complete: false };
      await batch([[peer, peerInput], [scenario.finalizer, partial]]);
      assert.equal((await call(scenario.finalizer, partial))?.block, undefined, "Partial draft batches are not finalizers");
    }
    await batch([[scenario.finalizer, input]]);
    assert.equal((await call(scenario.finalizer, input))?.block, undefined, "A fresh single-tool turn must reset the mixed-batch guard");
  } else if (scenario.scenario === "after-result") {
    const input = finalizerInput(scenario.finalizer);
    await batch([[scenario.finalizer, input]]);
    assert.equal((await call(scenario.finalizer, input))?.block, undefined);
    assert.equal((await execute(scenario.finalizer, input)).terminate, true);
    const saved = fs.readFileSync(resultFile, "utf8");
    for (const name of tools.keys()) {
      const nextInput = finalizerInput(name) || (name === "bash" ? { command: "true" } : peerInput);
      await batch([[name, nextInput]]);
      const verdict = await call(name, nextInput);
      assert.equal(verdict?.block, true, `${name} must be blocked after a durable result`);
      assert.match(verdict.reason, /already submitted|no further tools/i);
    }
    assert.equal(fs.readFileSync(resultFile, "utf8"), saved);
  } else if (scenario.scenario === "compact") {
    assert.deepEqual(await emit("session_before_compact", { preparation: {}, signal: new AbortController().signal }), { cancel: true });
    assert.equal(fs.existsSync(resultFile), false);
  } else if (scenario.scenario === "absolute-read") {
    assert.equal(process.platform, "win32");
    // A local file exists only to prove that contents still come from the mocked remote adapter.
    fs.mkdirSync(join(root, "src"));
    fs.writeFileSync(join(root, "src", "main.ts"), "LOCAL_CONTENT_MUST_NOT_BE_READ");
    for (const path of [`${remoteRoot}/src/main.ts`, `${remoteRoot}/src/../src/main.ts`]) {
      assert.equal((await call("read", { path }))?.block, undefined);
      const result = await execute("read", { path });
      assert.equal(result.content[0].text, source);
      assert.equal(result.isError, undefined);
    }
    assert.deepEqual(spawns.map(item => item.command), [...outputByCommand.keys(), ...outputByCommand.keys()]);
  } else if (scenario.scenario === "escape-read") {
    for (const path of ["../outside.ts", "src/../../outside.ts", "src\\..\\..\\outside.ts", `${remoteRoot}/../outside.ts`,
      `${remoteRoot}/src/../../outside.ts`, `${remoteRoot}-sibling/main.ts`, `${root}/src/../../outside.ts`]) {
      await assert.rejects(async () => execute("read", { path }), /outside.*project/i, `Path ${path} must be rejected before spawn`);
    }
    for (const path of ["src/../PLAN.md", `${remoteRoot}/src/../.agent/GOAL.md`]) {
      await assert.rejects(async () => execute("read", { path }), /LOCAL_AUTOPILOT_CONTROL_PATH/);
    }
  } else assert.fail(`Unknown extension contract ${scenario.scenario}`);

  if (scenario.scenario !== "absolute-read") assert.equal(spawns.length, 0);
  assert.deepEqual(blockedOperations, [], "No attempted real network, process, or key access may be swallowed");
} finally {
  try {
    if (hooks.has("session_shutdown")) await emit("session_shutdown");
    assert.equal(children.size, 0, "All mocked SSH operations must close before fixture exit");
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}
process.stdout.write("EXTENSION_CONTRACT_OK\n");
