import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const role = process.env.LOCAL_AUTOPILOT_ROLE;
const taskId = process.env.LOCAL_AUTOPILOT_TASK_ID;
const resultFile = process.env.LOCAL_AUTOPILOT_RESULT_FILE;
const send = event => process.stdout.write(JSON.stringify(event) + "\n");
function finish() {
  const result = role === "reviewer"
    ? { kind: "review", taskId, approved: true, summary: "UI fixture reviewed", issues: [], verification: ["fixture"] }
    : { kind: "worker", taskId, status: "complete", summary: "UI fixture done", changedFiles: [], verification: ["fixture"], evidence: ["PASS"], blocker: "" };
  writeFileSync(resultFile, JSON.stringify(result));
  send({ type: "agent_settled" });
}
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  send({ type: "response", id: request.id, command: request.type, success: true });
  if (request.type === "prompt") {
    const promptIndex = process.argv.indexOf("--append-system-prompt");
    if (!process.argv[promptIndex + 1].includes("Initial UI note")) throw new Error("Initial note missing from agent context");
    if (role === "reviewer") finish();
    else send({ type: "message_start", message: { role: "assistant", content: [] } });
  }
  if (request.type === "steer") {
    send({ type: "message_start", message: { role: "user", content: [{ type: "text", text: request.message }] } });
    setTimeout(finish, 80);
  }
  if (request.type === "abort") process.exit(0);
});
