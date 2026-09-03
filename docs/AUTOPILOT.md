# local-autopilot usage

## Best workflow

Write the big task into a UTF-8 markdown file, then scaffold an autopilot run:

```cmd
local-autopilot new C:\path\to\project C:\path\to\prompt.md --remote user@vm-host:/home/user/project
local-autopilot start C:\path\to\project
local-autopilot watch C:\path\to\project
```

`watch` is only a live view. Close it with `Ctrl+C`; it does not stop the agent.

Run `start` from a normal user CMD/PowerShell, not an Administrator window.
On this AMD system an elevated process may select a different Vulkan driver and
crash before the model loads.

The configured remote directory must already contain the project files, or at
least be the sandbox directory where the agent is allowed to create them.
`local-autopilot new` creates local control files (`.agent/*`, `PLAN.md`) and
points the tools at the remote VM path; it does not copy a whole project tree.

## Commands

```cmd
local-autopilot new <project-folder> <prompt-file> [--remote user@ip:/abs/path] [--name name] [--ctx 24576] [--force]
local-autopilot start <project-folder|autopilot.json> [--ctx 24576]
local-autopilot status <project-folder|autopilot.json>
local-autopilot watch <project-folder|autopilot.json>
local-autopilot stop <project-folder|autopilot.json>
```

## What `new` creates

```text
<project>\.agent\GOAL.md
<project>\.agent\tasks.json
<project>\.agent\autopilot.json
<project>\PLAN.md
```

The initial `tasks.json` contains only `0.1 Bootstrap planning from GOAL.md`.
That planner task may edit `PLAN.md` and `.agent/tasks.json`.
After reviewer approval, the supervisor reloads `.agent/tasks.json` and starts the generated task list.

## No-progress protection

There is no global iteration, tool-call, or wall-clock limit. A long task may
continue as long as it makes new observations or changes.

## Context handoff

Pi auto-compaction is disabled. The supervisor watches the local llama-server
slot and, at `contextHandoffTokens` (by default 65% of `contextWindow`), saves
the durable checkpoint, stops the current Pi process, and starts a clean
session for the same task. It also treats an unexpected compaction request or
two consecutive unstructured `agent_settled` events as an immediate handoff.
This prevents a failed model-generated summary from looping forever. It is a
session rotation, not a task or iteration limit: task work continues from
`PLAN.md`, project files, and the checkpoint.

## When you must act

When a task requires a real external prerequisite that is not present, such as
an interactive account login, a proxy/model endpoint, a safe configuration
choice, or explicit approval, the worker calls `request_user_action`. This
stops the whole autopilot in `blocked` state and writes a concrete checklist to
`<project>\.agent\USER_ACTION_REQUIRED.md`. The same reason and file path are
shown by `local-autopilot status`.

Complete the listed manual action, without placing passwords, private keys,
session cookies, or access tokens in the project or chat. Then start the same
autopilot again; it resumes the blocked task from its checkpoint.

The only automatic interruption is semantic: if the exact same bash command
gets the exact same result twice without a successful project `write` or
`edit`, the third identical retry is rejected. The current worker is then
paused and a read-only recovery planner is invoked. The planner inspects the
current VM evidence, replaces only the stalled task with smaller focused
subtasks, and the supervisor resumes from that new plan. This prevents a model
from burning context on a failed hypothesis while leaving normal debugging and
long-running work unrestricted.

For server checks, use a background process, a stored PID, a bounded health
poll, and PID cleanup. A foreground `timeout` ending in code `124` only proves
that the server was stopped; it is not a health check.

Bare `pkill -f` is blocked because its search pattern can match the shell that
is executing it. Use the PID returned by the background process and `kill
$PID` in a cleanup trap instead.

## Prompt shape

Good prompt:

```text
Goal:
<what should exist when done>

Environment:
- Work on Debian VM in /home/user/project.
- Do not touch Windows host, keys, credentials, real browser-login profile data, VirtualBox/networking unless explicitly required.
- Long-running processes must use timeout/background execution plus health checks.

Acceptance:
- <observable result 1>
- <observable result 2>
- <tests or commands that should pass>

Planning:
- Split into small independently reviewable tasks.
- Separate investigation, implementation, tests, deployment, and docs.
- Do not move to later tasks until current task has focused verification.
```

Avoid vague prompts like "make the whole thing good". Give the target state and the dangerous boundaries.
