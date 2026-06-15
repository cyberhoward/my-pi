/**
 * TickTick Extension — Manage personal tasks via the tickrs CLI.
 *
 * Wraps `tickrs` (https://crates.io/crates/ticktickrs) with structured
 * tool calls. Results are parsed and trimmed to keep context usage low.
 *
 * Setup: see setup.md in the skill directory, or run `tickrs init`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateHead, formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

// ── Schema ──────────────────────────────────────────────────────────

const TickTickParams = Type.Object({
	action: StringEnum([
		"list_projects",
		"list_tasks",
		"get_task",
		"create_task",
		"update_task",
		"complete_task",
		"uncomplete_task",
		"delete_task",
		"move_task",
		"create_project",
		"load_config",
	] as const),
	project: Type.Optional(Type.String({ description: "Project name (required for task operations unless a default is set). For move_task, this is the source project." })),
	target_project: Type.Optional(Type.String({ description: "Target project name for move_task" })),
	task_id: Type.Optional(Type.String({ description: "Task ID (for get/update/complete/delete/move)" })),
	title: Type.Optional(Type.String({ description: "Task or project title (for create/update)" })),
	content: Type.Optional(Type.String({ description: "Task description (for create/update)" })),
	priority: Type.Optional(StringEnum(["none", "low", "medium", "high"] as const)),
	date: Type.Optional(Type.String({ description: "Natural language date like 'tomorrow', 'next friday', 'in 3 days'" })),
	tags: Type.Optional(Type.String({ description: "Comma-separated tags" })),
	items: Type.Optional(Type.String({ description: "Comma-separated subtask/checklist items" })),
});

type TickTickInput = Static<typeof TickTickParams>;

// ── Helpers ─────────────────────────────────────────────────────────

function buildArgs(input: TickTickInput): string[] {
	const args: string[] = [];

	switch (input.action) {
		case "list_projects":
			args.push("project", "list");
			break;

		case "create_project":
			args.push("project", "create");
			if (input.title) args.push("--name", input.title);
			break;

		case "list_tasks":
			args.push("task", "list");
			if (input.project) args.push("--project-name", input.project);
			break;

		case "get_task":
			args.push("task", "show", input.task_id!);
			if (input.project) args.push("--project-name", input.project);
			break;

		case "create_task":
			args.push("task", "create");
			if (input.title) args.push("--title", input.title);
			if (input.project) args.push("--project-name", input.project);
			if (input.content) args.push("--content", input.content);
			if (input.priority) args.push("--priority", input.priority);
			if (input.date) args.push("--date", input.date);
			if (input.tags) args.push("--tags", input.tags);
			if (input.items) args.push("--items", input.items);
			break;

		case "update_task":
			args.push("task", "update", input.task_id!);
			if (input.project) args.push("--project-name", input.project);
			if (input.title) args.push("--title", input.title);
			if (input.content) args.push("--content", input.content);
			if (input.priority) args.push("--priority", input.priority);
			if (input.date) args.push("--date", input.date);
			if (input.tags) args.push("--tags", input.tags);
			if (input.items) args.push("--items", input.items);
			break;

		case "complete_task":
			args.push("task", "complete", input.task_id!);
			if (input.project) args.push("--project-name", input.project);
			break;

		case "uncomplete_task":
			args.push("task", "uncomplete", input.task_id!);
			if (input.project) args.push("--project-name", input.project);
			break;

		case "delete_task":
			args.push("task", "delete", input.task_id!, "--force");
			if (input.project) args.push("--project-name", input.project);
			break;

		case "load_config":
			args.push("task", "list", "--project-name", "Config");
			break;
	}

	args.push("--json");
	return args;
}

/** Slim down a task object to the fields the LLM actually needs. */
function summarizeTask(t: any): any {
	if (!t) return t;
	const out: any = { id: t.id, title: t.title };
	if (t.content) out.content = t.content;
	if (t.priority !== undefined && t.priority !== 0) out.priority = t.priority;
	if (t.status !== undefined) out.status = t.status;
	if (t.dueDate) out.due = t.dueDate;
	if (t.startDate) out.start = t.startDate;
	if (t.tags?.length) out.tags = t.tags;
	if (t.items?.length) out.items = t.items.map((i: any) => ({ title: i.title, status: i.status }));
	if (t.projectId) out.projectId = t.projectId;
	return out;
}

function summarizeProject(p: any): any {
	if (!p) return p;
	return { id: p.id, name: p.name, ...(p.color ? { color: p.color } : {}) };
}

function unwrapTask(raw: any): any {
	return raw?.data?.task ?? raw?.data ?? raw;
}

function priorityToCli(priority: any): string | undefined {
	switch (priority) {
		case 1:
			return "low";
		case 3:
			return "medium";
		case 5:
			return "high";
		case 0:
			return "none";
		default:
			return undefined;
	}
}

function taskToCreateArgs(task: any, targetProject: string): string[] {
	const args = ["task", "create", "--title", task.title, "--project-name", targetProject];
	if (task.content) args.push("--content", task.content);
	const priority = priorityToCli(task.priority);
	if (priority) args.push("--priority", priority);
	if (task.startDate) args.push("--start", task.startDate);
	if (task.dueDate) args.push("--due", task.dueDate);
	if (task.isAllDay) args.push("--all-day");
	if (task.timeZone) args.push("--timezone", task.timeZone);
	if (task.tags?.length) args.push("--tags", task.tags.join(","));
	if (task.items?.length) args.push("--items", task.items.map((i: any) => i.title).filter(Boolean).join(","));
	args.push("--json");
	return args;
}

function formatResult(action: string, raw: any): string {
	if (!raw?.success && raw?.error) {
		return `Error: ${raw.error.message || JSON.stringify(raw.error)}`;
	}

	const data = raw?.data;

	switch (action) {
		case "list_projects": {
			const projects = Array.isArray(data) ? data.map(summarizeProject) : data;
			return JSON.stringify(projects, null, 2);
		}
		case "list_tasks": {
			const tasks = Array.isArray(data) ? data.map(summarizeTask) : data;
			return JSON.stringify(tasks, null, 2);
		}
		case "get_task":
			return JSON.stringify(summarizeTask(data), null, 2);
		case "create_task":
		case "update_task":
			return JSON.stringify(summarizeTask(data), null, 2);
		case "complete_task":
			return `Task completed.`;
		case "uncomplete_task":
			return `Task marked incomplete.`;
		case "delete_task":
			return `Task deleted.`;
		case "move_task":
			return JSON.stringify(data, null, 2);
		case "create_project":
			return JSON.stringify(summarizeProject(data), null, 2);
		case "load_config": {
			const tasks = Array.isArray(data?.tasks) ? data.tasks : Array.isArray(data) ? data : [];
			const notes = tasks.map((t: any) => ({
				title: t.title,
				content: t.content || "(empty)",
			}));
			return JSON.stringify(notes, null, 2);
		}
		default:
			return JSON.stringify(data, null, 2);
	}
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ticktick",
		label: "TickTick",
		description:
			"Manage the user's personal TickTick tasks and projects. " +
			"Actions: list_projects, list_tasks, get_task, create_task, update_task, complete_task, uncomplete_task, delete_task, move_task, create_project, load_config. " +
			"Supports natural language dates (e.g. 'tomorrow', 'next friday'). " +
			"Priority levels: none, low, medium, high. " +
			"Use load_config to fetch the Config project (tag taxonomy, project guide, review checklist, priorities, processing rules).",
		promptSnippet: "Manage TickTick tasks and projects (list, create, update, complete, delete, move, load_config)",
		promptGuidelines: [
			"Use this tool for the user's personal task management — NOT for agentic/coding task tracking.",
			"Always provide the `project` parameter for task operations unless the user has set a default project.",
			"For move_task, provide `project` as the source project and `target_project` as the destination; this recreates the task then deletes the original, so the task ID changes.",
			"If authentication fails, tell the user to run `tickrs init` in their terminal and refer them to ~/.my-pi/extensions/ticktick/setup.md.",
		],
		parameters: TickTickParams,

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const runTickrs = async (args: string[]) => {
				const result = await pi.exec("tickrs", args, { signal, timeout: 15000 });

				if (result.killed) {
					throw new Error("tickrs command timed out");
				}

				const output = (result.stdout + result.stderr).trim();

				if (result.code !== 0) {
					if (output.includes("Authentication required") || output.includes("AUTH_REQUIRED")) {
						throw new Error("TickTick authentication required. Run `tickrs init` in your terminal. See ~/.my-pi/extensions/ticktick/setup.md for setup instructions.");
					}
					throw new Error(output || `tickrs exited with code ${result.code}`);
				}

				try {
					return JSON.parse(output);
				} catch {
					return output;
				}
			};

			let text: string;
			if (params.action === "move_task") {
				if (!params.task_id) throw new Error("move_task requires task_id");
				if (!params.project) throw new Error("move_task requires project (source project name)");
				if (!params.target_project) throw new Error("move_task requires target_project");

				const sourceProject = params.project;
				const targetProject = params.target_project;
				const taskId = params.task_id;

				const rawTask = await runTickrs(["task", "show", taskId, "--project-name", sourceProject, "--json"]);
				const originalTask = unwrapTask(rawTask);
				const rawCreated = await runTickrs(taskToCreateArgs(originalTask, targetProject));
				const newTask = unwrapTask(rawCreated);
				await runTickrs(["task", "delete", taskId, "--project-name", sourceProject, "--force", "--json"]);

				text = formatResult("move_task", {
					data: {
						message: "Task moved by recreating it in the target project and deleting the original.",
						sourceProject,
						targetProject,
						originalTask: summarizeTask(originalTask),
						newTask: summarizeTask(newTask),
					},
				});
			} else {
				const parsed = await runTickrs(buildArgs(params));
				text = typeof parsed === "string" ? parsed : formatResult(params.action, parsed);
			}

			const truncation = truncateHead(text, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			if (truncation.truncated) {
				text = truncation.content;
				text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
				text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
			}

			return {
				content: [{ type: "text", text }],
				details: { action: params.action },
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ticktick "));
			text += theme.fg("muted", args.action);
			if (args.action === "load_config") text += " " + theme.fg("accent", "[Config]");
			if (args.title) text += " " + theme.fg("dim", `"${args.title}"`);
			if (args.project) text += " " + theme.fg("accent", `[${args.project}]`);
			if (args.target_project) text += " " + theme.fg("accent", `→ [${args.target_project}]`);
			if (args.task_id) text += " " + theme.fg("accent", `#${args.task_id.slice(0, 8)}`);
			if (args.date) text += " " + theme.fg("warning", `📅 ${args.date}`);
			if (args.priority && args.priority !== "none") text += " " + theme.fg("error", `!${args.priority}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			const content = text?.type === "text" ? text.text : "";
			const action = (result.details as any)?.action;

			if (result.isError) {
				return new Text(theme.fg("error", content), 0, 0);
			}

			// Short confirmations
			if (["complete_task", "uncomplete_task", "delete_task"].includes(action)) {
				return new Text(theme.fg("success", "✓ ") + theme.fg("muted", content), 0, 0);
			}

			// For lists/details, show trimmed content
			const lines = content.split("\n");
			const display = lines.length > 20 ? lines.slice(0, 20).join("\n") + `\n... ${lines.length - 20} more lines` : content;
			return new Text(theme.fg("muted", display), 0, 0);
		},
	});
}
