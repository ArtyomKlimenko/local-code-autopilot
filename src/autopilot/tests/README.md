# Autopilot regression tests

Run from the repository root with Node 22 or newer. No dependency installation is needed:

```powershell
node --test src/autopilot/tests/plan-store.test.mjs src/autopilot/tests/supervisor.test.mjs
```

The initial verification used Node 22.14.0 on Windows: 53 tests passed.

## Coverage

- `plan-store.test.mjs`: ordered batch merge and replacement, stable content revisions, malformed/duplicate task rejection without partial writes, proposal isolation, exact-revision approval, integrity checks, stale goals, and approved-commit recovery before/between/after mirror writes. Recovery also verifies that an already applied commit cannot erase later progress.
- `supervisor.test.mjs`: bootstrap review before publication, execution of both first and second tasks, reviewer handoffs through compaction and RPC context usage, stop/resume in ordinary and bootstrap review, retained worker evidence, invalid results/finalizers, mismatched plan approval, and pausing/resuming only at the flagged task.

Crash recovery tests seed the durable commit record and possible mirror states directly. They do not depend on killing a process at a lucky instant.

## Isolation And Synchronization

Each test owns a unique `mkdtemp` directory containing a synthetic goal, plan, tasks, state, and sessions. No user configuration, goals, credentials, SSH agent environment, or installed Pi process is used. The configured key path does not exist, and the remote host is a `.invalid` fixture name.

`supervisor-harness.mjs` starts the repository supervisor with `fixtures/supervisor-isolation.mjs` as a process-local preload. It permits only the repository's `fixtures/fake-pi.mjs` as a child program, rejects real network connections, and stubs the legacy model-slot fetch. The configured extension is a throwing sentinel; the fake never imports it or the production extension.

The preload bridges parent IPC to each fake Pi process. Tests wait for prompt/result/exit events and explicitly release results or request handoff. There are no test sleeps, fixed-delay success assertions, or live model requests. The supervisor's own polling drives stop requests and `get_session_stats`; the fake returns `contextUsage.tokens` as controlled by the test.

Fake Pi validates the exported bootstrap paths and `--system-prompt`, then writes `{protocol: 2, role, taskId, tools: toolNames(role, bootstrap)}` to `LOCAL_AUTOPILOT_READY_FILE`. Bootstrap workers submit with `savePlanBatch(..., {tasks, complete: true})`; bootstrap reviewers return the proposal's revision. Normal successful results emit the appropriate `tool_execution_end` before `agent_settled`. Negative tests explicitly suppress or fail the finalizer. Closing stdin or receiving abort ends the fake process.

The 20-second per-process watchdog only fails a hung test and invokes cleanup; it never makes a scenario pass. Cleanup shuts down fake children, waits for their actual close events, then terminates and awaits the supervisor before removing that fixture's validated temporary directory. All control commands, including `stop`, are tracked and awaited.

Only new files in this directory are required. Production runtime and existing web tests are outside this suite's edit scope.

## Optional Extension Contracts

The real TypeScript extension can also be tested without a model, GPU, SSH connection, or installed agent session. Point to an existing Pi package directory; no install is performed:

```powershell
$env:LOCAL_AUTOPILOT_PI_PACKAGE = 'C:\LocalAI\pi\node_modules\@earendil-works\pi-coding-agent'
node --test src/autopilot/tests/extension-contract.test.mjs
```

All 16 extension contracts passed on Windows with Pi 0.84.4, its installed Jiti, and Node 22.14.0. When the environment variable is unset or the package is absent, all extension contracts are skipped. The Windows-specific absolute-path case also skips on other platforms. An installed but incompatible package fails visibly.

`extension-contract.test.mjs` launches `fixtures/extension-contract.mjs` in a unique temporary cwd for each case, with synthetic environment paths and no inherited user/model credentials. The fixture uses Jiti virtual modules populated from the installed Pi tool factories, type guards, and schema helpers. It imports the production extension without importing the Pi CLI, model registry, or creating an agent session. Jiti filesystem caching is disabled.

The mock ExtensionAPI captures registered tools, active tools, and lifecycle hooks. Contracts cover bootstrap reviewer tools/readiness, each finalizer in both positions of a mixed tool batch, resetting the batch guard, blocking every registered tool after a result, and cancelling `session_before_compact`. Partial bootstrap batches remain allowed.

Bootstrap `read_plan` contracts verify the exact compact fields: workers receive `{location, goalNote, draft}`, and reviewers receive `{location, goal, proposal}`. They also verify stored plan contents and prevent duplication of the full goal or both plan versions in one response.

The path tests exercise the actual installed `createReadTool` and extension adapters. `child_process.spawn` is mocked before imports; only exact synthetic read commands receive in-memory output. Tests verify absolute Linux paths on Windows, normalized paths within the project, parent traversal rejection, sibling-prefix rejection, and reserved control paths. Network and other process APIs are blocked, and attempted reads of the nonexistent fixture key fail explicitly. Every mock is restored after the shutdown hook. The parent awaits child close before deleting its temporary directory; its 30-second watchdog is only a cleanup backstop.

To include these optional contracts with the base suite, append `src/autopilot/tests/extension-contract.test.mjs` to the first command above.
