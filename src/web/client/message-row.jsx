// Adapted from xuzhixiangya/pi-web-ui (MIT). See THIRD_PARTY.md.
import { memo } from "preact/compat";
import { useMemo, useState } from "preact/hooks";
import { Terminal, FileText, Pencil, Check, LoaderCircle, AlertCircle, ChevronRight, Brain, Copy } from "lucide-preact";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
const linkOpen = markdown.renderer.rules.link_open || ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return linkOpen(tokens, index, options, env, self);
};
export const Markdown = memo(({ text = "" }) => {
  const html = useMemo(() => DOMPurify.sanitize(markdown.render(text), { FORBID_TAGS: ["img", "iframe", "form", "input", "style"] }), [text]);
  return <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
});
export function CopyButton({ text, label = "Копировать" }) {
  const [copied, setCopied] = useState(false);
  return <button class="icon-button" aria-label={label} title={label} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>;
}
const toolTitles = { bash: "Команда", read: "Чтение файла", write: "Запись файла", edit: "Редактирование", save_bootstrap_plan: "Сохранение плана", finish_step: "Результат шага", finish_review: "Проверка результата", finish_replan: "Обновление плана", request_user_action: "Запрос к пользователю" };
export const ToolCallRow = memo(({ entry, active }) => {
  const [open, setOpen] = useState(false);
  const name = entry.name || "Инструмент";
  const args = entry.args || {};
  const summary = args.command || args.path || args.summary || args.diagnosis || toolTitles[name] || name;
  const status = entry.status === "running" && !active ? "interrupted" : entry.status;
  const Icon = name === "bash" ? Terminal : ["write", "edit"].includes(name) ? Pencil : FileText;
  return <div class={"tool-row status-" + status}>
    <button class="tool-heading" aria-expanded={open} onClick={() => setOpen(!open)}>
      <ChevronRight size={14} class={open ? "rotate" : ""} />
      <Icon size={15} />
      <span class="tool-label">{toolTitles[name] || name}</span>
      <span class="tool-summary">{String(summary)}</span>
      <span class="tool-state">{status === "running" ? <LoaderCircle size={15} class="spin" /> : status === "error" ? <AlertCircle size={15} /> : status === "done" ? <Check size={15} /> : <span>Прервано</span>}</span>
    </button>
    {open && <div class="tool-body">
      <div class="code-caption"><span>{name === "bash" ? "Команда на VM" : "Аргументы"}</span><CopyButton text={name === "bash" ? args.command || "" : JSON.stringify(args, null, 2)} /></div>
      <pre>{name === "bash" ? args.command : JSON.stringify(args, null, 2)}</pre>
      <div class="code-caption"><span>Результат</span><CopyButton text={entry.output || ""} /></div>
      <pre>{entry.output || (status === "running" ? "Ожидание результата…" : "Результат не записан в этом фрагменте истории.")}</pre>
    </div>}
  </div>;
});
export const MessageRow = memo(({ entry, active, showThinking }) => {
  if (entry.kind === "tool") return <ToolCallRow entry={entry} active={active} />;
  if (entry.kind === "error") return <div class="error-message"><AlertCircle size={16} /><pre>{entry.text}</pre></div>;
  return <article class="agent-message">
    {(entry.text || entry.thinking) && <div class="message-meta"><span class="agent-avatar">π</span><strong>Локальный агент</strong>{entry.streaming && active && <span class="muted">пишет</span>}<CopyButton text={entry.text || entry.thinking} /></div>}
    {entry.thinking && <details class="thinking" open={showThinking}>
      <summary><Brain size={14} /><span>{entry.streaming && active && !entry.text ? "Обдумывает следующий шаг" : "Рассуждение модели"}</span><ChevronRight size={13} /></summary>
      <div class="thinking-text">{entry.thinking}</div>
    </details>}
    {entry.text && <Markdown text={entry.text} />}
  </article>;
});
