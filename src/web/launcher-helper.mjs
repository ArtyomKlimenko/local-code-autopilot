import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, openSync, readSync, closeSync, statSync } from "node:fs";

const [, , powershell, wrapper, configPath, context, opPath, launchId] = process.argv;
function read() {
  try { return JSON.parse(readFileSync(opPath, "utf8")); } catch { return null; }
}
function update(values) {
  const op = read();
  if (op?.launchId !== launchId) return;
  const temp = opPath + "." + process.pid + ".tmp";
  writeFileSync(temp, JSON.stringify({ ...op, ...values }, null, 2), "utf8");
  renameSync(temp, opPath);
}
function logTail(path) {
  try {
    const length = statSync(path).size;
    const bytes = Buffer.alloc(Math.min(length, 4000));
    const fd = openSync(path, "r");
    try { readSync(fd, bytes, 0, bytes.length, Math.max(0, length - bytes.length)); } finally { closeSync(fd); }
    return bytes.toString("utf8");
  } catch { return ""; }
}
for (let i = 0; i < 20 && read()?.launchId !== launchId; i++) await new Promise(r => setTimeout(r, 50));
if (read()?.launchId !== launchId) process.exit(1);
// Windows PowerShell exits without executing -File when detached with hidden
// redirected handles. Detach this small Node owner; keep PowerShell attached to it.
const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper, "start", configPath, "--ctx", context], { windowsHide: true, stdio: ["ignore", "inherit", "inherit"], env: process.env });
update({ commandPid: child.pid });
child.once("error", error => update({ status: "error", error: error.message, endedAt: new Date().toISOString() }));
child.once("exit", code => {
  const op = read();
  update({ status: code === 0 ? "exited" : "error", exitCode: code, error: code === 0 ? null : logTail(op?.logPath), endedAt: new Date().toISOString() });
});
