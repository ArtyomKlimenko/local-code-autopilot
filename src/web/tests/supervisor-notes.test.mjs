import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";

const supervisor = resolve(import.meta.dirname, "../../autopilot/supervisor.mjs");
test("supervisor delivers UI notes and resumes worker/reviewer without altering task scope", { timeout: 12000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "local-code-notes-"));
  const agent = join(root, ".agent");
  mkdirSync(agent);
  const put = (name, value) => writeFileSync(join(agent, name), JSON.stringify(value));
  const notes = [{ id: "initial", text: "Initial UI note", at: new Date().toISOString() }];
  put("web-notes.json", notes);
  writeFileSync(join(agent, "GOAL.md"), "Fixture goal");
  writeFileSync(join(root, "PLAN.md"), "- [ ] 1.1 Fixture\n");
  put("tasks.json", { projectName: "fixture", tasks: [{ id: "1.1", title: "Fixture", scope: "Read only fixture", status: "pending", acceptance: ["fixture"], requiresUserApproval: false }] });
  const config = {
    projectRoot: root, tasksFile: ".agent/tasks.json", goalFile: ".agent/GOAL.md", planFile: "PLAN.md", stateFile: ".agent/state.json", journalFile: ".agent/journal.md",
    runDirectory: join(root, "runs"), piSessionDirectory: join(root, "sessions"), nodeExecutable: process.execPath,
    piCli: join(import.meta.dirname, "pi-fixture.mjs"), extension: resolve(import.meta.dirname, "../../autopilot/pi-autopilot-extension.ts"),
    remoteHost: "user@fixture", remoteCwd: "/fixture", sshKeyPath: join(root, "path-only-key"),
    provider: "fixture", model: "fixture", thinking: "high", contextWindow: 24576, attemptTimeoutMinutes: null,
  };
  put("autopilot.json", config);
  const child = spawn(process.execPath, [supervisor, "start", join(agent, "autopilot.json")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const exit = once(child, "exit");
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    for (let i = 0; i < 60 && !existsSync(join(agent, "web-receipts", "initial.json")); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(existsSync(join(agent, "web-receipts", "initial.json")), output);
    notes.push({ id: "live", text: "Live user clarification", at: new Date().toISOString() });
    put("web-notes.json", notes);
    const [code] = await exit;
    assert.equal(code, 0, output);
    const receipt = JSON.parse(readFileSync(join(agent, "web-receipts", "live.json")));
    assert.ok(["delivered", "included"].includes(receipt.status));
    const state = JSON.parse(readFileSync(join(agent, "state.json")));
    assert.equal(state.status, "complete");
    assert.equal(state.tasks[0].attempts, 1);
    assert.equal(JSON.parse(readFileSync(join(agent, "tasks.json"))).tasks[0].scope, "Read only fixture");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && !child.killed) { child.kill(); await exit; }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
