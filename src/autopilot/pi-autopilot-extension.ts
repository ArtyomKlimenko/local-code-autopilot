import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { PROTOCOL_VERSION, atomicJson, planPaths, planningSnapshot, savePlanBatch, toolNames } from "./plan-store.mjs";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	defineTool,
	isToolCallEventType,
	type BashOperations,
	type EditOperations,
	type ExtensionAPI,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const resultFile = process.env.LOCAL_AUTOPILOT_RESULT_FILE || "";
const activityFile = process.env.LOCAL_AUTOPILOT_ACTIVITY_FILE || "";
const actionFile = process.env.LOCAL_AUTOPILOT_ACTION_FILE || "";
const bootstrapPlanFile = process.env.LOCAL_AUTOPILOT_BOOTSTRAP_PLAN_FILE || "";
const bootstrapTasksFile = process.env.LOCAL_AUTOPILOT_BOOTSTRAP_TASKS_FILE || "";
const role = process.env.LOCAL_AUTOPILOT_ROLE || "worker";
const bootstrapTask = process.env.LOCAL_AUTOPILOT_BOOTSTRAP === "1";
const bootstrapPlanning = bootstrapTask && role === "worker";
const localPlan = bootstrapTask ? planPaths(process.cwd(), process.env.LOCAL_AUTOPILOT_GOAL_FILE, bootstrapPlanFile, bootstrapTasksFile) : null;
const taskId = process.env.LOCAL_AUTOPILOT_TASK_ID || "unknown";
const remoteHost = process.env.LOCAL_AUTOPILOT_REMOTE_HOST || "";
const remoteCwd = process.env.LOCAL_AUTOPILOT_REMOTE_CWD || "";
const sshExecutable = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const sshKeyPath = process.env.LOCAL_AUTOPILOT_SSH_KEY || "";
if (!remoteHost || !remoteCwd || !sshKeyPath) {
	throw new Error("LOCAL_AUTOPILOT_REMOTE_HOST, LOCAL_AUTOPILOT_REMOTE_CWD, and LOCAL_AUTOPILOT_SSH_KEY must be configured.");
}
const sshArgs = [
	"-o", "IdentityAgent=none",
	"-o", "IdentitiesOnly=yes",
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=10",
	"-i", sshKeyPath,
	remoteHost,
];
const defaultBashTimeoutSeconds = 240;
const maxBashTimeoutSeconds = 900;
const operationSignal = new AsyncLocalStorage<AbortSignal | undefined>();
const sshChildren = new Set<ReturnType<typeof spawn>>();

type ActionObservation = {
	epoch: number;
	outcome: string;
	matchingRuns: number;
};

/**
 * This is deliberately not a general iteration limit.  It only intervenes
 * when the agent is about to repeat an identical shell action after the same
 * observation, with no successful write/edit since.  A changed command,
 * output, or project edit starts a fresh line of investigation.
 */
class NoProgressGuard {
	private epoch = 0;
	private readonly observations = new Map<string, ActionObservation>();

	markProjectChange(): void {
		this.epoch += 1;
		this.observations.clear();
	}

	shouldBlock(command: string, cwd: string): string | null {
		const key = `${compact(cwd)}\n${compact(command)}`;
		const observation = this.observations.get(key);
		if (!observation || observation.epoch !== this.epoch || observation.matchingRuns < 2) return null;
		return "LOCAL_AUTOPILOT_NO_PROGRESS_LOOP: this exact bash command has already produced the same result twice without a successful project edit. Do not retry it unchanged. State the failed hypothesis, inspect a different bounded source of evidence, or make the smallest targeted repair before retesting.";
	}

	record(command: string, cwd: string, exitCode: number | null, output: string): void {
		const key = `${compact(cwd)}\n${compact(command)}`;
		const outcome = compact(`exit=${exitCode ?? "signal"}; ${output.slice(-4000)}`);
		const previous = this.observations.get(key);
		const matchingRuns = previous && previous.epoch === this.epoch && previous.outcome === outcome
			? previous.matchingRuns + 1
			: 1;
		this.observations.set(key, { epoch: this.epoch, outcome, matchingRuns });
	}
}

function saveJson(path: string, value: unknown): void {
	if (!path) return;
	atomicJson(path, value);
}

function logActivity(value: unknown): void {
	if (!activityFile) return;
	mkdirSync(dirname(activityFile), { recursive: true });
	appendFileSync(activityFile, `${JSON.stringify({ at: new Date().toISOString(), ...value as object })}\n`, "utf8");
}

function compact(value: string): string {
	return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function privateKeyRead(command: string): boolean {
	if (!/id_ed25519/i.test(command)) return false;
	const withoutIdentityArgument = command.replace(
		/(^|\s)-i\s+(?:"[^"]*id_ed25519[^"]*"|'[^']*id_ed25519[^']*'|[^\s;|&]*id_ed25519[^\s;|&]*)/gi,
		"$1-i <ssh-key-path>",
	);
	if (/id_ed25519/i.test(withoutIdentityArgument)) return true;
	return !/\bssh(?:\.exe)?\b/i.test(command);
}

function dangerousCommand(command: string): string | null {
	const normalized = compact(command);
	const pkillFlags = command.match(/\bpkill\b((?:\s+-[A-Za-z0-9]+)+)\s+/i);
	if (pkillFlags && /f/i.test(pkillFlags[1])) {
		return "Bare pkill -f is blocked because its pattern can match and kill the invoking shell. Keep the PID returned by your own background process and use kill $PID with a cleanup trap instead.";
	}
	if (/\b(?:rm\s+-[^\n]*r[^\n]*f|git\s+reset\s+--hard|git\s+checkout\s+--|format(?:\.com)?\s|diskpart\b|del\s+\/s|rmdir\s+\/s|remove-item[^\n]*-recurse)\b/i.test(normalized)) {
		return "Destructive command blocked by local autopilot.";
	}
	if (/\bfind\s+\/(?:\s|$)|\b(?:grep|rg)\b[^\n]*(?:-r|-R|--recursive)[^\n]*\s\/(?:\s|$)/i.test(command)) {
		return "Broad filesystem scan blocked. Use one targeted directory and bounded output.";
	}
	if (/\bmulti-account\/\.cache\b/i.test(command)) {
		const allowedStructureOnly =
			/\bfind\s+multi-account\/\.cache\/[^\s;&|]+(?:\s+-maxdepth\s+[12])?\s*(?:[;&|]|$)/i.test(command) ||
			/\bls\s+-la\s+multi-account\/\.cache(?:\/[^\s;&|]+)?\s*(?:[;&|]|$)/i.test(command);
		if (!allowedStructureOnly && /\b(?:cat|head|tail|grep|rg|sed|awk|python3?\b|node\b|find\b)/i.test(command)) {
			return "Browser profile cache contents are blocked. Inspect only safe structure, not profile file bodies.";
		}
	}
	if (privateKeyRead(command)) {
		return "Reading or copying the private SSH key is forbidden. The remote tools already use its path internally.";
	}
	return null;
}

function sshExec(command: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const signal = operationSignal.getStore();
		if (signal?.aborted) { reject(new Error("aborted")); return; }
		const child = spawn(sshExecutable, [...sshArgs, command], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		sshChildren.add(child);
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		let size = 0;
		let failed = "";
		const cancel = () => { failed = "aborted"; child.kill(); };
		const timer = setTimeout(() => { failed = "SSH file operation exceeded 60 seconds"; child.kill(); }, 60000);
		signal?.addEventListener("abort", cancel, { once: true });
		const collect = (target: Buffer[], data: Buffer) => {
			size += data.length;
			if (size > 8 * 1024 * 1024) { failed = "File output exceeds 8 MiB; inspect a smaller source file"; child.kill(); }
			else target.push(data);
		};
		child.stdout.on("data", data => collect(chunks, data));
		child.stderr.on("data", data => collect(errChunks, data));
		child.on("error", error => { failed = error.message; });
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			sshChildren.delete(child);
			if (failed) reject(new Error(failed));
			else if (code !== 0) {
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

function withRemoteScope(tool: any) {
	return { ...tool, execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
		if (signal?.aborted) throw new Error("aborted");
		const input = typeof params.path === "string"
			? { ...params, path: posix.relative(remoteCwd, remotePath(params.path, process.cwd())) || "." } : params;
		return operationSignal.run(signal, async () => {
			const result = await tool.execute(id, input, signal, onUpdate, ctx);
			return boundedResult(result);
		});
	} };
}

function boundedResult(result: any) {
	let remaining = 8000;
	return { ...result, content: result.content.map((part: any) => {
		if (part.type !== "text") return part;
		const budget = remaining;
		remaining = Math.max(0, remaining - part.text.length);
		if (part.text.length <= budget) return part;
		const head = Math.floor(budget * 0.65);
		const tail = budget - head;
		return { ...part, text: part.text.slice(0, head) + "\n[Output shortened for the local context. Read a smaller offset/limit range or run a targeted command; do not repeat the full dump.]\n" + (tail ? part.text.slice(-tail) : "") };
	}) };
}

function remotePath(path: string, localCwd: string): string {
	const normalized = path.replace(/\\/g, "/");
	const localNormalized = localCwd.replace(/\\/g, "/");
	let target: string;
	if (normalized === localNormalized) target = remoteCwd;
	else if (normalized.startsWith(`${localNormalized}/`)) target = remoteCwd + normalized.slice(localNormalized.length);
	else if (/^[A-Za-z]:\//.test(normalized)) {
		throw new Error(`Local Windows path is outside the remote project: ${path}`);
	} else target = posix.resolve(remoteCwd, normalized);
	target = posix.normalize(target);
	if (target !== remoteCwd && !target.startsWith(remoteCwd + "/")) throw new Error("Path is outside the configured VM project.");
	if (/[\0\r\n]/.test(target)) throw new Error("Invalid project path.");
	return target;
}

function quoteSh(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

const controlHint = "LOCAL_AUTOPILOT_CONTROL_PATH: PLAN.md and .agent belong to the local controller. Use read_plan to inspect the local draft and save_bootstrap_plan to save it. Never copy or write remote control files.";

function isRemoteControlPath(path: string, localCwd: string): boolean {
	const target = remotePath(path, localCwd).replace(/\/+$/, "");
	return target === `${remoteCwd}/PLAN.md` || target === `${remoteCwd}/.agent` || target.startsWith(`${remoteCwd}/.agent/`);
}

function assertRemoteProjectPath(path: string, localCwd: string): string {
	if (isRemoteControlPath(path, localCwd)) {
		throw new Error(controlHint);
	}
	return remotePath(path, localCwd);
}

function createRemoteReadOps(localCwd: string): ReadOperations {
	return {
		readFile: (path) => sshExec(`cat -- ${quoteSh(assertRemoteProjectPath(path, localCwd))}`),
		access: (path) => sshExec(`test -r ${quoteSh(assertRemoteProjectPath(path, localCwd))}`).then(() => {}),
		detectImageMimeType: async (path) => {
			try {
				const result = await sshExec(`file --mime-type -b -- ${quoteSh(assertRemoteProjectPath(path, localCwd))}`);
				const mime = result.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(localCwd: string, progress: NoProgressGuard): WriteOperations {
	return {
		writeFile: async (path, content) => {
			const encoded = Buffer.from(content).toString("base64");
			await sshExec(`printf %s ${quoteSh(encoded)} | base64 -d > ${quoteSh(assertRemoteProjectPath(path, localCwd))}`);
			progress.markProjectChange();
		},
		mkdir: (path) => sshExec(`mkdir -p -- ${quoteSh(assertRemoteProjectPath(path, localCwd))}`).then(() => progress.markProjectChange()),
	};
}

function createRemoteEditOps(localCwd: string, progress: NoProgressGuard): EditOperations {
	const read = createRemoteReadOps(localCwd);
	const write = createRemoteWriteOps(localCwd, progress);
	return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
}

function createRemoteBashOps(localCwd: string, progress: NoProgressGuard): BashOperations {
	return {
			exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				if (signal?.aborted) { reject(new Error("aborted")); return; }
				const blocked = dangerousCommand(command) || (/(?:^|[\s\"'`/])(?:\.agent(?:[\\/\s\"'`]|$)|PLAN\.md(?:[\s\"'`]|$))/i.test(command)
					? "Remote .agent and PLAN.md are reserved for the remote project. This run's plan and state are local only."
					: null);
				if (blocked) {
					reject(new Error(blocked));
					return;
				}
				const remoteWorkingDirectory = remotePath(cwd, localCwd);
				const loopBlock = progress.shouldBlock(command, remoteWorkingDirectory);
				if (loopBlock) {
					logActivity({ type: "no_progress_guard", role, taskId, command: compact(command).slice(0, 600) });
					reject(new Error(loopBlock));
					return;
				}
				const effectiveTimeout = Math.min(timeout || defaultBashTimeoutSeconds, maxBashTimeoutSeconds);
				const boundedCommand = `timeout --signal=TERM --kill-after=2s ${effectiveTimeout}s /bin/bash -c ${quoteSh(command)}`;
				const execution = role === "worker" ? boundedCommand
					: `command -v bwrap >/dev/null || { echo LOCAL_AUTOPILOT_SANDBOX_UNAVAILABLE; exit 78; }; exec bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-pid --die-with-parent --chdir ${quoteSh(remoteWorkingDirectory)} /bin/bash -c ${quoteSh(boundedCommand)}`;
				const child = spawn(sshExecutable, [...sshArgs, `cd ${quoteSh(remoteWorkingDirectory)} && ${execution}`], {
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				sshChildren.add(child);
				const output: Buffer[] = [];
				let timedOut = false;
				const timer = effectiveTimeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, (effectiveTimeout + 3) * 1000)
					: undefined;
				child.stdout.on("data", (data) => {
					output.push(Buffer.from(data));
					onData(data);
				});
				child.stderr.on("data", (data) => {
					output.push(Buffer.from(data));
					onData(data);
				});
				child.on("error", (error) => {
					if (timer) clearTimeout(timer);
					reject(error);
				});
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					sshChildren.delete(child);
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${effectiveTimeout}`));
					else {
						progress.record(command, remoteWorkingDirectory, code, Buffer.concat(output).toString("utf8"));
						resolve({ exitCode: code });
					}
				});
			}),
	};
}

const finishStep = defineTool({
	name: "finish_step",
	label: "Finish step",
	description: "Finish the assigned worker step with a machine-readable result.",
	promptSnippet: "Finish exactly one assigned task with structured evidence",
	promptGuidelines: [
		"Call finish_step when the assigned task is verified complete or blocked by a real external requirement.",
		"Use status complete only after focused verification passes; otherwise use blocked.",
	],
	parameters: Type.Object({
		status: StringEnum(["complete", "blocked"] as const),
		summary: Type.String({ description: "Concise factual result" }),
		changedFiles: Type.Array(Type.String(), { description: "Remote project-relative files changed in this step" }),
		verification: Type.Array(Type.String(), { description: "Commands or checks actually run" }),
		evidence: Type.Array(Type.String(), { description: "Compact pass/fail evidence from those checks" }),
		blocker: Type.String({ description: "Empty when complete; exact blocker when blocked" }),
	}),
	async execute(_id, params) {
		const value = { kind: "worker", taskId, at: new Date().toISOString(), ...params };
		saveJson(resultFile, value);
		logActivity({ type: "finish_step", taskId, status: params.status });
		return {
			content: [{ type: "text", text: `Worker result saved for ${taskId}: ${params.status}` }],
			details: value,
			terminate: true,
		};
	},
});

const saveBootstrapPlan = defineTool({
	name: "save_bootstrap_plan",
	label: "Save bootstrap plan",
	description: "Save structured tasks to the LOCAL plan draft. complete:false saves a batch; complete:true submits the full draft for review. PLAN.md is generated automatically. No remote file is written.",
	promptSnippet: "Persist the new local control plan without editing the remote project's legacy control files",
	promptGuidelines: [
		"Use this only for bootstrap planning after bounded remote inspection.",
		"Do not write PLAN.md or .agent/tasks.json through remote write/edit tools during bootstrap.",
		"Use tasks as structured objects, never JSON encoded as a string. Task 0.1 is reserved.",
		"For a large goal, save successive batches with complete:false, then submit the last batch with complete:true. Existing ids are updated, new ids appended. No fixed task count is required.",
	],
	parameters: Type.Object({
		summary: Type.String({ description: "Concise description of the plan" }),
		tasks: Type.Array(Type.Object({
			id: Type.String({ description: "Unique ordered task id, for example 1.1" }),
			title: Type.String(), scope: Type.String(), acceptance: Type.Array(Type.String()),
			requiresUserApproval: Type.Boolean(),
		})),
		complete: Type.Boolean({ description: "false saves a partial draft; true submits all accumulated tasks for review" }),
		replace: Type.Optional(Type.Boolean({ description: "Explicitly replace the whole draft instead of merging this batch" })),
	}),
	async execute(_id, params) {
		const proposal = savePlanBatch(localPlan, params);
		if (!params.complete) return { content: [{ type: "text", text: `LOCAL draft saved: ${proposal.tasks.length} tasks. Add the remaining stages, then submit with complete:true.` }], details: { revision: proposal.revision } };
		const value = {
			kind: "worker",
			taskId,
			at: new Date().toISOString(),
			status: "complete",
			planRevision: proposal.revision,
			summary: params.summary,
			changedFiles: [".agent/planning/proposal.json"],
			verification: ["Validated and saved the LOCAL proposal; active plan unchanged until review"],
			evidence: [`${proposal.tasks.length} planned tasks saved outside the remote project`],
			blocker: "",
		};
		saveJson(resultFile, value);
		logActivity({ type: "save_bootstrap_plan", taskId, tasks: proposal.tasks.length });
		return {
			content: [{ type: "text", text: `LOCAL plan submitted for review: ${proposal.tasks.length} tasks` }],
			details: value,
			terminate: true,
		};
	},
});

const readPlan = defineTool({
	name: "read_plan", label: "Read local plan",
	description: "Read the authoritative user goal and draft/proposal from this run's LOCAL control workspace. This never reads PLAN.md on the VM.",
	promptSnippet: "Read the authoritative LOCAL goal and plan proposal",
	parameters: Type.Object({}),
	async execute() {
		const snapshot = planningSnapshot(localPlan);
		const view = role === "reviewer"
			? { location: snapshot.location, goal: snapshot.goal, proposal: snapshot.proposal }
			: { location: snapshot.location, goalNote: "The full goal is already in your assignment. Do not reread it or restart discovery.", draft: snapshot.draft };
		return { content: [{ type: "text", text: JSON.stringify(view, null, 2) }] };
	},
});

const inspectProject = defineTool({
	name: "inspect_project", label: "Inspect VM project",
	description: "Read-only bounded list of a directory in the configured VM project. Use read for individual source files. No shell command or writes are accepted.",
	promptSnippet: "List a bounded VM source directory without modifying it",
	parameters: Type.Object({ path: Type.String({ description: "Project-relative directory, normally ." }) }),
	async execute(_id, params) {
		const path = assertRemoteProjectPath(params.path, process.cwd());
		const output = await sshExec(`find ${quoteSh(path)} -mindepth 1 -maxdepth 1 ! -name .agent ! -name PLAN.md ! -name .git ! -name node_modules -printf '%f\\n' | head -100`);
		return { content: [{ type: "text", text: output.toString("utf8") }] };
	},
});

const requestUserAction = defineTool({
	name: "request_user_action",
	label: "Request user action",
	description: "Stop the current task and record the exact external action required from the user.",
	promptSnippet: "Stop for a real external dependency and request a safe, concrete user action",
	promptGuidelines: [
		"Call this only after one focused check confirms that the task acceptance criteria cannot be met without a real account login, proxy endpoint, model endpoint, explicit user approval, or another external value the project does not contain.",
		"Do not call this for a normal code defect, a failing test, a missing project file that can safely be created, an ordinary investigation step, or uncertainty that a bounded read/test can resolve.",
		"Never ask the user to paste passwords, private keys, session cookies, or tokens into chat, logs, or the repository.",
		"Give the smallest concrete manual action and a verification condition for resuming.",
	],
	parameters: Type.Object({
		title: Type.String({ description: "Short title of the dependency" }),
		reason: Type.String({ description: "Why the task cannot safely continue" }),
		requiredActions: Type.Array(Type.String(), { description: "Concrete safe actions for the user" }),
		verificationAfter: Type.Array(Type.String(), { description: "What the agent should verify once the user acts" }),
	}),
	async execute(_id, params) {
		const value = {
			kind: "worker",
			taskId,
			at: new Date().toISOString(),
			status: "blocked",
			summary: `User action required: ${params.title}`,
			changedFiles: [],
			verification: [],
			evidence: [],
			blocker: params.reason,
			actionFile,
			requiredActions: params.requiredActions,
			verificationAfter: params.verificationAfter,
		};
		if (actionFile) {
			mkdirSync(dirname(actionFile), { recursive: true });
			writeFileSync(actionFile, [
				"# User Action Required",
				"",
				`Task: ${taskId}`,
				`Updated: ${value.at}`,
				"",
				`## ${params.title}`,
				"",
				params.reason,
				"",
				"## Do This",
				...params.requiredActions.map((item, index) => `${index + 1}. ${item}`),
				"",
				"## Resume Verification",
				...params.verificationAfter.map((item) => `- ${item}`),
				"",
				"Do not place passwords, private keys, session cookies, or access tokens in this file, the repository, or agent chat output.",
				"",
			].join("\n"), "utf8");
		}
		saveJson(resultFile, value);
		logActivity({ type: "request_user_action", taskId, title: params.title, actionFile });
		return {
			content: [{ type: "text", text: `User action request saved for ${taskId}: ${params.title}` }],
			details: value,
			terminate: true,
		};
	},
});

const finishReview = defineTool({
	name: "finish_review",
	label: "Finish review",
	description: "Finish the independent read-only review with a machine-readable verdict.",
	promptSnippet: "Accept or reject the assigned task after independent verification",
	promptGuidelines: [
		"Call finish_review after independently checking the acceptance criteria.",
		"Set approved true only when focused verification passes.",
	],
	parameters: Type.Object({
		approved: Type.Boolean(),
		summary: Type.String(),
		issues: Type.Array(Type.String()),
		verification: Type.Array(Type.String()),
	}),
	async execute(_id, params) {
		const value = { kind: "review", taskId, at: new Date().toISOString(), ...params,
			...(bootstrapTask ? { planRevision: planningSnapshot(localPlan).proposal?.revision } : {}),
		};
		saveJson(resultFile, value);
		logActivity({ type: "finish_review", taskId, approved: params.approved });
		return {
			content: [{ type: "text", text: `Review saved for ${taskId}: ${params.approved ? "approved" : "rejected"}` }],
			details: value,
			terminate: true,
		};
	},
});

const finishReplan = defineTool({
	name: "finish_replan",
	label: "Finish recovery plan",
	description: "Return a narrow replacement plan for one stalled task.",
	promptSnippet: "Return a small, evidence-driven recovery plan",
	promptGuidelines: [
		"Use only after inspecting the stalled task's current evidence.",
		"Split the existing scope into independently verifiable steps; do not broaden scope.",
	],
	parameters: Type.Object({
		diagnosis: Type.String({ description: "Why the current task is stalled or ambiguous" }),
		steps: Type.Array(Type.Object({
			title: Type.String(),
			scope: Type.String(),
			acceptance: Type.Array(Type.String()),
		})),
	}),
	async execute(_id, params) {
		const value = { kind: "replan", taskId, at: new Date().toISOString(), ...params };
		saveJson(resultFile, value);
		logActivity({ type: "finish_replan", taskId, steps: params.steps.length });
		return {
			content: [{ type: "text", text: `Recovery plan saved for ${taskId}: ${params.steps.length} steps` }],
			details: value,
			terminate: true,
		};
	},
});

export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();
	const progress = new NoProgressGuard();
	const allowedTools = toolNames(role, bootstrapTask);
	if (!bootstrapTask || bootstrapPlanning) pi.registerTool(withRemoteScope(createReadTool(localCwd, { operations: createRemoteReadOps(localCwd) })));
	if (!bootstrapTask) pi.registerTool(withRemoteScope(createBashTool(localCwd, { operations: createRemoteBashOps(localCwd, progress) })));
	if (bootstrapTask) pi.registerTool(readPlan);

	if (bootstrapPlanning) {
		pi.registerTool(withRemoteScope(inspectProject));
		pi.registerTool(saveBootstrapPlan);
	} else if (role === "reviewer") {
		pi.registerTool(finishReview);
	} else if (role === "planner") {
		pi.registerTool(finishReplan);
	} else {
		pi.registerTool(withRemoteScope(createWriteTool(localCwd, { operations: createRemoteWriteOps(localCwd, progress) })));
		pi.registerTool(withRemoteScope(createEditTool(localCwd, { operations: createRemoteEditOps(localCwd, progress) })));
		pi.registerTool(finishStep);
		pi.registerTool(requestUserAction);
	}

	pi.on("before_agent_start", async (event) => {
		pi.setActiveTools(allowedTools);
		return { systemPrompt: process.env.LOCAL_AUTOPILOT_SYSTEM_PROMPT || event.systemPrompt };
	});

	let multiToolBatch = false;
	pi.on("message_end", event => {
		if (event.message.role === "assistant") multiToolBatch = event.message.content.filter(part => part.type === "toolCall").length > 1;
	});
	pi.on("session_before_compact", () => ({ cancel: true }));
	pi.on("session_shutdown", async () => {
		await Promise.all([...sshChildren].map(child => new Promise<void>(resolve => { child.once("close", () => resolve()); child.kill(); })));
	});
	pi.on("tool_call", async (event) => {
		logActivity({ type: "tool_call", role, taskId, tool: event.toolName, input: event.input });
		if (!allowedTools.includes(event.toolName)) return { block: true, reason: "This role has only these tools: " + allowedTools.join(", ") };
		if (resultFile && existsSync(resultFile)) return { block: true, reason: "This pass has already submitted its result. No further tools may run." };
		const finalizer = ["finish_step", "finish_review", "finish_replan", "request_user_action"].includes(event.toolName) || (event.toolName === "save_bootstrap_plan" && event.input.complete === true);
		if (finalizer && multiToolBatch) return { block: true, reason: "Submit the final result as the ONLY tool call in a separate assistant turn, after all other tools have completed." };

		if (isToolCallEventType("read", event)) {
			const path = String(event.input.path || "");
			if (/id_ed25519(?:\.|$)/i.test(path) || /^[A-Za-z]:\//.test(path.replace(/\\/g, "/"))) {
				return { block: true, reason: "Read only project files on the Debian VM. Private key contents and Windows files are unavailable." };
			}
			if (isRemoteControlPath(path, localCwd)) {
				return { block: true, reason: controlHint };
			}
		}

		if (isToolCallEventType("bash", event)) {
			const command = String(event.input.command || "");
			const blocked = dangerousCommand(command) || (/(?:^|[\s\"'`/])(?:\.agent(?:[\\/\s\"'`]|$)|PLAN\.md(?:[\s\"'`]|$))/i.test(command)
				? "Remote .agent and PLAN.md are reserved for the remote project. This run's plan and state are local only."
				: null);
			if (blocked) return { block: true, reason: blocked };
		}
	});

	pi.on("session_start", () => {
		pi.setActiveTools(allowedTools);
		saveJson(process.env.LOCAL_AUTOPILOT_READY_FILE || "", { protocol: PROTOCOL_VERSION, role, taskId, tools: pi.getActiveTools() });
		logActivity({
			type: "remote_session",
			role,
			taskId,
			host: remoteHost,
			cwd: remoteCwd,
			keyConfigured: existsSync(sshKeyPath),
		});
	});
}
