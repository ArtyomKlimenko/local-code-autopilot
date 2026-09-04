# local-code-autopilot

Windows-first local coding-agent stack for a llama.cpp Vulkan server and Pi
Coding Agent. It keeps model inference on a selected AMD GPU, routes agent
tools to an SSH-accessible Linux sandbox, and can run a long task through a
worker/reviewer supervisor.

## Included

- GPU-only llama.cpp launcher with model, port-owner, layer-offload, and KV
  cache checks.
- Pi Coding Agent local-provider launcher.
- Remote-tool extension that keeps file and shell work inside the Linux VM.
- Generic `local-autopilot` command for planner-first task execution.
- No-progress protection: identical command plus identical evidence is treated
  as a failed hypothesis, not a reason to burn context.
- Recovery planner that replaces a stalled broad task with focused,
  independently verifiable steps.
- Local Preact web workspace: projects, live Pi messages and tool results,
  plans, start/stop/resume, user clarifications, GPU state and SSH checks.

## Not Included

No GGUF model, runtime binaries, logs, sessions, SSH private keys, VM IPs,
project folders, browser profiles, or credentials are tracked in this repo.

## Setup

1. Install Node.js, a Vulkan build of llama.cpp, Pi Coding Agent, and a GGUF
   model locally.
2. Copy the source files to your local AI root, normally `C:\LocalAI`.
3. Set the variables shown in [config/local-code.example.env](config/local-code.example.env).
4. Create an autopilot configuration from
   [config/autopilot.example.json](config/autopilot.example.json).
5. Run from a non-Administrator terminal. On some AMD installations an
   elevated process gets a different Vulkan runtime.

See [docs/AUTOPILOT.md](docs/AUTOPILOT.md) for the planner-first workflow.
See [docs/WEB_UI.md](docs/WEB_UI.md) for the browser interface and installation.
See [docs/PIPELINE.md](docs/PIPELINE.md) for staged plans, review/resume behavior, and regression tests.

## Security model

The remote extension refuses private-key reads, broad scans, destructive
commands, browser-profile cache reads, unsafe `pkill -f` cleanup, and access
to remote `.agent/` or `PLAN.md` control files. Autopilot plans and state are
always stored in the local control project. It uses the SSH key only as a path
passed to OpenSSH. It does not upload the key or its contents to the model.

This is an agent harness, not a security boundary. Give its VM account only
the access that the task actually needs.
