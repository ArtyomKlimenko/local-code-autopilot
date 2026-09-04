import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
const bootstrapPlanning = Boolean(bootstrapPlanFile && bootstrapTasksFile);
const role = process.env.LOCAL_AUTOPILOT_ROLE || "worker";
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
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
		const child = spawn(sshExecutable, [...sshArgs, command], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data) => chunks.push(data));
		child.stderr.on("data", (data) => errChunks.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

function remotePath(path: string, localCwd: string): string {
	const normalized = path.replace(/\\/g, "/");
	const localNormalized = localCwd.replace(/\\/g, "/");
	if (normalized === localNormalized) return remoteCwd;
	if (normalized.startsWith(`${localNormalized}/`)) return `${remoteCwd}${normalized.slice(localNormalized.length)}`;
	if (normalized === remoteCwd || normalized.startsWith(`${remoteCwd}/`)) return normalized;
	if (/^[A-Za-z]:\//.test(normalized)) {
		throw new Error(`Local Windows path is outside the remote project: ${path}`);
	}
	return `${remoteCwd}/${normalized.replace(/^\.\//, "")}`;
}

function isRemoteControlPath(path: string, localCwd: string): boolean {
	const target = remotePath(path, localCwd).replace(/\/+$/, "");
	return target === `${remoteCwd}/PLAN.md` || target === `${remoteCwd}/.agent` || target.startsWith(`${remoteCwd}/.agent/`);
}

function assertRemoteProjectPath(path: string, localCwd: string): string {
	if (isRemoteControlPath(path, localCwd)) {
		throw new Error("Remote .agent and PLAN.md are reserved for the remote project. This run's plan and state are local only.");
	}
	return remotePath(path, localCwd);
}

function createRemoteReadOps(localCwd: string): ReadOperations {
	return {
		readFile: (path) => sshExec(`cat ${JSON.stringify(assertRemoteProjectPath(path, localCwd))}`),
		access: (path) => sshExec(`test -r ${JSON.stringify(assertRemoteProjectPath(path, localCwd))}`).then(() => {}),
		detectImageMimeType: async (path) => {
			try {
				const result = await sshExec(`file --mime-type -b ${JSON.stringify(assertRemoteProjectPath(path, localCwd))}`);
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
			await sshExec(`printf %s ${JSON.stringify(encoded)} | base64 -d > ${JSON.stringify(assertRemoteProjectPath(path, localCwd))}`);
			progress.markProjectChange();
		},
		mkdir: (path) => sshExec(`mkdir -p ${JSON.stringify(assertRemoteProjectPath(path, localCwd))}`).then(() => progress.markProjectChange()),
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
				const child = spawn(sshExecutable, [...sshArgs, `cd ${JSON.stringify(remoteWorkingDirectory)} && ${command}`], {
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				const output: Buffer[] = [];
				let timedOut = false;
				const effectiveTimeout = Math.min(timeout || defaultBashTimeoutSeconds, maxBashTimeoutSeconds);
				const timer = effectiveTimeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, effectiveTimeout * 1000)
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
	description: "Save the new run's plan and task list to the local control directory after remote inspection.",
	promptSnippet: "Persist the new local control plan without editing the remote project's legacy control files",
	promptGuidelines: [
		"Use this only for bootstrap planning after bounded remote inspection.",
		"Do not write PLAN.md or .agent/tasks.json through remote write/edit tools during bootstrap.",
		"The task list must be valid JSON with a non-empty tasks array and must not include task 0.1.",
	],
	parameters: Type.Object({
		planMarkdown: Type.String({ description: "Full markdown content for the local PLAN.md" }),
		tasksJson: Type.String({ description: "Full JSON content for the local .agent/tasks.json" }),
		summary: Type.String({ description: "Concise description of the plan" }),
	}),
	async execute(_id, params) {
		let tasksDocument: { tasks?: Array<{ id?: string }> };
		try {
			tasksDocument = JSON.parse(params.tasksJson) as { tasks?: Array<{ id?: string }> };
		} catch (error) {
			throw new Error(`tasksJson is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!Array.isArray(tasksDocument.tasks) || tasksDocument.tasks.length === 0) {
			throw new Error("tasksJson must contain a non-empty tasks array");
		}
		if (tasksDocument.tasks.some((task) => task?.id === "0.1")) {
			throw new Error("tasksJson must not retain the bootstrap 0.1 task");
		}
		mkdirSync(dirname(bootstrapPlanFile), { recursive: true });
		mkdirSync(dirname(bootstrapTasksFile), { recursive: true });
		writeFileSync(bootstrapPlanFile, `${params.planMarkdown.trim()}\n`, "utf8");
		writeFileSync(bootstrapTasksFile, `${JSON.stringify(tasksDocument, null, 2)}\n`, "utf8");
		const value = {
			kind: "worker",
			taskId,
			at: new Date().toISOString(),
			status: "complete",
			summary: params.summary,
			changedFiles: ["PLAN.md", ".agent/tasks.json"],
			verification: ["Validated and saved the local bootstrap plan and task list"],
			evidence: [`${tasksDocument.tasks.length} planned tasks saved outside the remote project`],
			blocker: "",
		};
		saveJson(resultFile, value);
		logActivity({ type: "save_bootstrap_plan", taskId, tasks: tasksDocument.tasks.length });
		return {
			content: [{ type: "text", text: `Bootstrap plan saved for ${taskId}: ${tasksDocument.tasks.length} tasks` }],
			details: value,
			terminate: true,
		};
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
		const value = { kind: "review", taskId, at: new Date().toISOString(), ...params };
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
	pi.registerTool(createReadTool(localCwd, { operations: createRemoteReadOps(localCwd) }));
	pi.registerTool(createBashTool(localCwd, { operations: createRemoteBashOps(localCwd, progress) }));

	if (bootstrapPlanning) {
		pi.registerTool(saveBootstrapPlan);
	} else if (role === "reviewer") {
		pi.registerTool(finishReview);
	} else if (role === "planner") {
		pi.registerTool(finishReplan);
	} else {
		pi.registerTool(createWriteTool(localCwd, { operations: createRemoteWriteOps(localCwd, progress) }));
		pi.registerTool(createEditTool(localCwd, { operations: createRemoteEditOps(localCwd, progress) }));
		pi.registerTool(finishStep);
		pi.registerTool(requestUserAction);
	}

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: event.systemPrompt.replace(
			`Current working directory: ${localCwd}`,
			`Current working directory: ${remoteCwd} on Debian VM (all file and bash tools run there through SSH). Individual bash commands have a ${defaultBashTimeoutSeconds}s default watchdog. A timeout exit 124 only proves that a foreground server was stopped; it is not a health check. For server checks, start the server in the background, retain its PID, poll health with a bounded client, then clean it up with a trap. Do not use bare pkill -f patterns: use a recorded PID or a port-specific cleanup command.`,
		),
	}));

	pi.on("tool_call", async (event) => {
		logActivity({ type: "tool_call", role, taskId, tool: event.toolName, input: event.input });

		if (isToolCallEventType("read", event)) {
			const path = String(event.input.path || "");
			if (/id_ed25519(?:\.|$)/i.test(path) || /^[A-Za-z]:\//.test(path.replace(/\\/g, "/"))) {
				return { block: true, reason: "Read only project files on the Debian VM. Private key contents and Windows files are unavailable." };
			}
			if (isRemoteControlPath(path, localCwd)) {
				return { block: true, reason: "Remote .agent and PLAN.md are reserved for the remote project. This run's plan and state are local only." };
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
