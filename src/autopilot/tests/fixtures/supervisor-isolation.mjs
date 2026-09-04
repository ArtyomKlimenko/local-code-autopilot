import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";

// Loaded only into the test supervisor, never into an installed Pi/extension.
const root = process.env.AUTOPILOT_TEST_ROOT;
const fakePi = process.env.AUTOPILOT_TEST_PI;
if (!root || !fakePi || !process.send) throw new Error("Test isolation requires a fixture root and parent IPC");
const send = message => { if (process.connected) process.send(message); };
const forbidden = () => { throw new Error("Regression fixture forbids real network access or non-fixture processes"); };
globalThis.fetch = async input => {
  if (String(input) !== "http://127.0.0.1:8080/slots") return forbidden();
  return Response.json([]);
};
net.connect = net.createConnection = net.Socket.prototype.connect = forbidden;
http.request = http.get = https.request = https.get = tls.connect = forbidden;

const spawn = childProcess.spawn;
const children = new Map();
let cleaningUp = false;
childProcess.spawn = (executable, args, options) => {
  if (cleaningUp) throw new Error("Fixture cleanup in progress");
  if (resolve(executable) !== resolve(process.execPath) || resolve(args?.[0] || ".") !== resolve(fakePi) || resolve(options?.cwd || ".") !== resolve(root)) forbidden();
  const child = spawn(executable, args, { ...options, stdio: ["pipe", "pipe", "pipe", "ipc"] });
  const closed = new Promise(done => child.once("close", (code, signal) => {
    send({ type: "pi-exit", pid: child.pid, code, signal });
    children.delete(child.pid);
    done();
  }));
  children.set(child.pid, { child, closed });
  send({ type: "pi-spawn", pid: child.pid });
  child.on("message", event => send({ type: "pi-event", pid: child.pid, event }));
  return child;
};
for (const name of ["exec", "execFile", "execSync", "execFileSync", "spawnSync", "fork"]) childProcess[name] = forbidden;
syncBuiltinESMExports();

process.on("message", async message => {
  if (message.type === "pi-command") {
    const entry = children.get(message.pid);
    if (entry?.child.connected) entry.child.send(message.command);
  } else if (message.type === "fixture-cleanup") {
    cleaningUp = true;
    const active = [...children.values()];
    for (const { child } of active) child.kill("SIGKILL");
    await Promise.all(active.map(entry => entry.closed));
    send({ type: "fixture-cleaned" });
  }
});
process.on("disconnect", () => {
  cleaningUp = true;
  for (const { child } of children.values()) child.kill("SIGKILL");
});
// Parent control must not keep an otherwise completed supervisor alive.
process.channel.unref();
