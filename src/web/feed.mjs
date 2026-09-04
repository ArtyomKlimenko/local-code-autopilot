import { openSync, readSync, closeSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(item => item.text || "").filter(Boolean).join("\n");
  if (value?.content) return contentText(value.content);
  return value ? JSON.stringify(value, null, 2) : "";
}

// A cursor consumes complete LF-delimited records, including split UTF-8 codepoints.
// Existing logs can be huge; first load only the recent tail, then read new bytes.
export class JsonlCursor {
  constructor(path, { initialBytes = 4 * 1024 * 1024 } = {}) {
    this.path = path;
    this.initialBytes = initialBytes;
    this.offset = 0;
    this.initialized = false;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.skipFirst = false;
    this.truncated = false;
  }
  read(consume) {
    let stat;
    try { stat = statSync(this.path); } catch { return 0; }
    if (!this.initialized || stat.size < this.offset) {
      this.offset = Math.max(0, stat.size - this.initialBytes);
      this.skipFirst = this.offset > 0;
      this.truncated = this.skipFirst;
      this.buffer = "";
      this.decoder = new StringDecoder("utf8");
      this.initialized = true;
    }
    const length = Math.min(stat.size - this.offset, 4 * 1024 * 1024);
    if (!length) return 0;
    const fd = openSync(this.path, "r");
    let count;
    const bytes = Buffer.alloc(length);
    try { count = readSync(fd, bytes, 0, length, this.offset); } finally { closeSync(fd); }
    this.offset += count;
    this.buffer += this.decoder.write(bytes.subarray(0, count));
    let end;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (this.skipFirst) { this.skipFirst = false; continue; }
      try { consume(JSON.parse(line)); } catch { /* Skip incomplete/corrupt historical records. */ }
    }
    // One malformed producer must not retain unbounded text.
    if (this.buffer.length > 8 * 1024 * 1024) this.buffer = "";
    return count;
  }
}

export class RunFeed {
  constructor(path, name) {
    this.cursor = new JsonlCursor(path);
    this.name = name;
    this.entries = [];
    this.message = null;
    this.sequence = 0;
    this.revision = 0;
    this.updatedAt = null;
    this.phase = "idle";
    this.dirty = new Set();
  }
  add(entry) {
    this.entries.push(entry);
    if (this.entries.length > 180) this.entries.shift();
    this.touch(entry);
    return entry;
  }
  touch(entry) {
    this.dirty.add(entry.id);
    entry.revision = ++this.revision;
  }
  accept(event) {
    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.message = this.add({ id: this.name + ":m" + (++this.sequence), kind: "message", text: "", thinking: "", streaming: true });
      this.phase = "thinking";
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent || {};
      if (!["text_delta", "thinking_delta"].includes(update.type)) return;
      if (!this.message) this.message = this.add({ id: this.name + ":m" + (++this.sequence), kind: "message", text: "", thinking: "", streaming: true });
      const field = update.type === "text_delta" ? "text" : "thinking";
      this.message[field] = (this.message[field] + (update.delta || "")).slice(-80000);
      this.phase = field === "text" ? "answering" : "thinking";
      this.touch(this.message);
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      if (!this.message) this.message = this.add({ id: this.name + ":m" + (++this.sequence), kind: "message", text: "", thinking: "" });
      this.message.text = contentText(event.message.content).slice(-80000);
      this.message.thinking = (event.message.content || []).filter(c => c.type === "thinking").map(c => c.thinking || "").join("\n").slice(-80000);
      this.message.streaming = false;
      this.message.at = event.message.timestamp ? new Date(event.message.timestamp).toISOString() : null;
      this.touch(this.message);
      this.message = null;
    } else if (event.type === "tool_execution_start") {
      const id = this.name + ":" + (event.toolCallId || ++this.sequence);
      this.add({ id, kind: "tool", name: event.toolName, args: event.args || {}, output: "", status: "running" });
      this.phase = "tool";
    } else if (["tool_execution_update", "tool_execution_end"].includes(event.type)) {
      const id = this.name + ":" + event.toolCallId;
      let entry = this.entries.find(item => item.id === id);
      if (!entry) entry = this.add({ id, kind: "tool", name: event.toolName, args: {}, output: "", status: "running" });
      entry.output = contentText(event.result || event.partialResult || event.output).slice(-80000);
      if (event.type === "tool_execution_end") entry.status = event.isError ? "error" : "done";
      this.touch(entry);
    } else if (event.type === "agent_settled" || event.type === "agent_end") {
      this.phase = "settled";
      this.revision++;
    } else if (event.type === "response" && event.success === false) {
      this.add({ id: this.name + ":e" + (++this.sequence), kind: "error", text: event.error || "Pi RPC error" });
    }
  }
  poll() {
    this.dirty.clear();
    const before = this.revision;
    const bytes = this.cursor.read(event => this.accept(event));
    if (bytes) {
      try { this.updatedAt = statSync(this.cursor.path).mtime.toISOString(); } catch {}
    }
    return { changed: before !== this.revision, entries: this.entries.filter(entry => this.dirty.has(entry.id)) };
  }
  snapshot() {
    return { run: this.name, entries: this.entries, phase: this.phase, updatedAt: this.updatedAt, truncated: this.cursor.truncated };
  }
}
