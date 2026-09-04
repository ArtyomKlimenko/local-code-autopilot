import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlCursor, RunFeed } from "../feed.mjs";

test("JSONL tail retains partial records, UTF-8 and Unicode line separators", () => {
  const root = mkdtempSync(join(tmpdir(), "local-code-feed-"));
  try {
    const file = join(root, "events.jsonl");
    const bytes = Buffer.from(JSON.stringify({ text: "Привет\u2028мир" }) + "\n");
    const split = bytes.indexOf(Buffer.from("П")) + 1;
    writeFileSync(file, bytes.subarray(0, split));
    const cursor = new JsonlCursor(file);
    const events = [];
    cursor.read(value => events.push(value));
    assert.equal(events.length, 0);
    appendFileSync(file, bytes.subarray(split));
    cursor.read(value => events.push(value));
    assert.deepEqual(events, [{ text: "Привет\u2028мир" }]);
    assert.equal(cursor.read(() => assert.fail("duplicate record")), 0);
    writeFileSync(file, '{"reset":true}\n');
    cursor.read(value => events.push(value));
    assert.equal(events[1].reset, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi stream renders complete text and pairs tools across append boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "local-code-feed-"));
  try {
    const file = join(root, "events.rpc.jsonl");
    const first = [
      { type: "message_start", message: { role: "user", content: [{ type: "text", text: "PRIVATE SYSTEM PROMPT" }] } },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Проверю файл." } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Читаю README." } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Проверю файл." }, { type: "text", text: "Читаю README." }] } },
      { type: "tool_execution_start", toolName: "read", toolCallId: "one", args: { path: "README.md" } },
    ];
    writeFileSync(file, first.map(e => JSON.stringify(e)).join("\n") + "\n");
    const feed = new RunFeed(file, "pass-1");
    feed.poll();
    assert.equal(feed.entries.length, 2);
    assert.equal(feed.entries[0].text, "Читаю README.");
    assert.equal(feed.entries[0].thinking, "Проверю файл.");
    assert.equal(feed.entries[0].streaming, false);
    const previousRevision = feed.revision;
    appendFileSync(file, JSON.stringify({ type: "tool_execution_end", toolName: "read", toolCallId: "one", result: { content: [{ type: "text", text: "<script>unsafe()</script>" }] }, isError: false }) + "\n");
    feed.poll();
    assert.equal(feed.entries.length, 2);
    assert.equal(feed.entries[1].status, "done");
    assert.equal(feed.entries[1].output, "<script>unsafe()</script>");
    assert.ok(feed.entries[1].revision > previousRevision);
    assert.ok(!JSON.stringify(feed.snapshot()).includes("PRIVATE SYSTEM PROMPT"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
