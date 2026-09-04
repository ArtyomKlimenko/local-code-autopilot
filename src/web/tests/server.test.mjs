import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";

const serverFile = resolve(import.meta.dirname, "..", "server.mjs");
const autopilotRoot = resolve(import.meta.dirname, "..", "..", "autopilot");
async function until(fn, duration = 15000) {
  const deadline = Date.now() + duration;
  let lastError;
  while (Date.now() < deadline) { try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; } await new Promise(r => setTimeout(r, 150)); }
  throw new Error("Timed out waiting for fixture: " + (lastError?.message || ""));
}

test("UI API preserves local project ownership, settings and launcher lifecycle", { timeout: 45000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "local-code-api-"));
  const projects = join(root, "projects");
  const ai = join(root, "ai");
  for (const path of [projects, join(ai, "autopilot"), join(ai, "launcher")]) mkdirSync(path, { recursive: true });
  copyFileSync(join(autopilotRoot, "local-autopilot.ps1"), join(ai, "autopilot", "local-autopilot.ps1"));
  copyFileSync(join(autopilotRoot, "supervisor.mjs"), join(ai, "autopilot", "supervisor.mjs"));
  copyFileSync(join(autopilotRoot, "plan-store.mjs"), join(ai, "autopilot", "plan-store.mjs"));
  // Exercise the real scaffold/wrapper with a GPU-free launcher fixture.
  writeFileSync(join(ai, "launcher", "local-code.ps1"), [
    'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ArgsList)',
    '$configPath = $ArgsList[2]',
    '$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json',
    '$statePath = Join-Path $config.projectRoot ".agent\\state.json"',
    '$stopPath = Join-Path $config.runDirectory "stop.request"',
    'New-Item -ItemType Directory -Force -Path $config.runDirectory | Out-Null',
    '@{ status="running"; pid=$PID; tasks=@(); lastMessage="fixture running" } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8',
    'Write-Output ("fixture ctx=" + $ArgsList[4])',
    'while (-not (Test-Path -LiteralPath $stopPath)) { Start-Sleep -Milliseconds 100 }',
    '@{ status="stopped"; pid=$null; tasks=@(); lastMessage="fixture stopped" } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8',
  ].join("\n"));
  const server = spawn(process.execPath, [serverFile], { env: { ...process.env, LOCAL_AI_ROOT: ai, LOCAL_CODE_PROJECTS_ROOT: projects, LOCAL_CODE_WEB_PORT: "18766" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  server.stderr.on("data", data => { output += data; });
  const origin = "http://127.0.0.1:18766";
  let id;
  let csrf;
  const call = (path, data, method = "POST") => fetch(origin + "/api" + path, { method, headers: { "Content-Type": "application/json", "X-Local-Code-Token": csrf, Origin: origin }, body: JSON.stringify(data) });
  try {
    const bootstrap = await until(async () => { const r = await fetch(origin + "/api/bootstrap"); return r.ok && r.json(); });
    csrf = bootstrap.token;
    assert.equal(bootstrap.projects.length, 0);
    const blockedOrigin = await fetch(origin + "/api/import", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", "X-Local-Code-Token": csrf }, body: "{}" });
    assert.equal(blockedOrigin.status, 403);
    const blockedToken = await fetch(origin + "/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(blockedToken.status, 403);
    const projectRoot = join(projects, "тест с пробелами");
    const create = await call("/projects", { name: "Проверка UI", projectRoot, prompt: "Большой русский промпт\nВторая строка\n<script>alert(1)</script>", remoteHost: "user@vm.local", remoteCwd: "/home/user/project", sshKeyPath: join(root, "path-only-key"), thinking: "high", contextWindow: 24576 });
    assert.equal(create.status, 200, await create.clone().text());
    const project = await create.json();
    id = project.id;
    assert.equal(project.name, "Проверка UI");
    assert.ok(project.goal.includes("Большой русский промпт"));
    assert.equal(project.projectRoot, projectRoot);
    const saved = JSON.parse(readFileSync(join(projectRoot, ".agent", "autopilot.json"), "utf8"));
    assert.equal(saved.remoteCwd, "/home/user/project");
    assert.ok(saved.runDirectory.startsWith(ai));
    const duplicate = await call("/projects", { ...saved, name: "duplicate", prompt: "test" });
    assert.equal(duplicate.status, 409);
    const updated = await call("/projects/" + id, { thinking: "low", contextWindow: 16384 }, "PATCH");
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).contextHandoffTokens, Math.floor(16384 * .65));
    const note = await call("/projects/" + id + "/notes", { message: "Уточнение\nНа русском" });
    assert.equal(note.status, 200);
    const started = await call("/projects/" + id + "/start", {});
    assert.equal(started.status, 200, await started.clone().text());
    await until(async () => {
      const detail = await (await fetch(origin + "/api/projects/" + id)).json();
      if (detail.status === "error" || detail.operation?.status === "exited") throw new Error(JSON.stringify(detail.operation) + "\n" + detail.launchLog);
      return detail.isRunning;
    });
    const second = await call("/projects/" + id + "/start", {});
    assert.equal(second.status, 409);
    const editRunning = await call("/projects/" + id, { thinking: "high" }, "PATCH");
    assert.equal(editRunning.status, 409);
    const stream = await fetch(origin + "/api/projects/" + id + "/events");
    const reader = stream.body.getReader();
    const firstEvent = await reader.read();
    assert.match(new TextDecoder().decode(firstEvent.value), /"type":"feed"/);
    await reader.cancel();
    const stopped = await call("/projects/" + id + "/stop", {});
    assert.equal(stopped.status, 200);
    await until(async () => {
      const value = await (await fetch(origin + "/api/projects/" + id)).json();
      return !value.isRunning && !value.isLaunching && value.status === "stopped";
    });
    writeFileSync(join(projectRoot, ".agent", "state.json"), JSON.stringify({ status: "stopped", currentTaskId: "0.1", tasks: [{ id: "0.1", title: "Review bootstrap", attempts: 2, lastIssues: ["Check the local plan"] }] }));
    writeFileSync(join(projectRoot, ".agent", "tasks.json"), JSON.stringify({ tasks: [{ id: "1.1", title: "Implementation", status: "pending" }] }));
    const reviewingPlan = await (await fetch(origin + "/api/projects/" + id)).json();
    assert.equal(reviewingPlan.currentTask.id, "0.1");
    assert.equal(reviewingPlan.currentTask.attempts, 2);
    assert.equal(reviewingPlan.tasks[0].id, "1.1");
    assert.equal((await call("/projects/" + id + "/archive", {})).status, 200);
    assert.equal((await (await fetch(origin + "/api/projects")).json()).length, 0);
    assert.equal((await (await fetch(origin + "/api/archive")).json())[0].id, id);
    assert.equal((await call("/projects/" + id + "/restore", {})).status, 200);
    assert.equal((await (await fetch(origin + "/api/projects")).json())[0].id, id);
  } finally {
    if (id && csrf) { try { await call("/projects/" + id + "/stop", {}); } catch {} }
    server.kill();
    if (server.exitCode === null) await once(server, "exit");
    // This path is the unique fixture root allocated by mkdtemp above.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
  assert.equal(output, "");
});
