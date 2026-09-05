import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	addSessionAllowance,
	addSessionAllowances,
	canRunToolCallInMode,
	extractBashCommandSegments,
	getPermissionRequiredToolCalls,
	isAllowedToolCall,
	isPermissionMode,
	type SessionAllowances,
} from "../src/allowed-tool-calls.ts";
import {
	askPermissionForModeOverride,
	describeToolCall,
	describeToolCalls,
} from "../src/permission-dialog.ts";
import readPermissionGate from "../src/read-permission-gate.ts";

describe("isPermissionMode", () => {
	it("recognizes supported modes", () => {
		assert.equal(isPermissionMode("default"), true);
		assert.equal(isPermissionMode("write"), true);
		assert.equal(isPermissionMode("yolo"), true);
		assert.equal(isPermissionMode("invalid"), false);
	});
});

describe("canRunToolCallInMode", () => {
	it("keeps default mode read-only", () => {
		assert.equal(
			canRunToolCallInMode("default", "read", { path: "README.md" }).allowed,
			true,
		);
		assert.equal(
			canRunToolCallInMode("default", "write", { path: "notes.txt" }).allowed,
			false,
		);
		assert.equal(
			canRunToolCallInMode("default", "bash", { command: "pwd" }).allowed,
			true,
		);
		assert.equal(
			canRunToolCallInMode("default", "bash", { command: "npm test" }).allowed,
			false,
		);
	});

	it("allows write tools but not unsafe bash commands in write mode", () => {
		assert.equal(
			canRunToolCallInMode("write", "write", { path: "notes.txt" }).allowed,
			true,
		);
		assert.equal(
			canRunToolCallInMode("write", "edit", { path: "notes.txt" }).allowed,
			true,
		);
		assert.equal(
			canRunToolCallInMode("write", "bash", { command: "pwd" }).allowed,
			true,
		);
		assert.equal(
			canRunToolCallInMode("write", "bash", { command: "rm notes.txt" })
				.allowed,
			false,
		);
		assert.equal(
			canRunToolCallInMode("write", "bash", { command: "npm test" }).allowed,
			false,
		);
	});

	it("checks nested calls inside multi-tool batches", () => {
		assert.equal(
			canRunToolCallInMode("write", "multi_tool_use.parallel", {
				tool_uses: [
					{
						recipient_name: "functions.write",
						parameters: { path: "notes.txt" },
					},
				],
			}).allowed,
			true,
		);
		assert.equal(
			canRunToolCallInMode("write", "multi_tool_use.parallel", {
				tool_uses: [
					{
						recipient_name: "functions.bash",
						parameters: { command: "npm test" },
					},
				],
			}).allowed,
			false,
		);
	});

	it("allows every tool call in yolo mode", () => {
		assert.equal(
			canRunToolCallInMode("yolo", "bash", { command: "rm -rf dist" }).allowed,
			true,
		);
		assert.equal(
			canRunToolCallInMode("yolo", "custom_cli", { command: "deploy" }).allowed,
			true,
		);
	});
});

describe("permission dialog", () => {
	it("describes every tool that needs permission in a batch", () => {
		assert.equal(
			describeToolCalls([
				{ toolName: "write", input: { path: "notes.txt" } },
				{ toolName: "bash", input: { command: "npm test" } },
			]),
			"- write path: notes.txt\n- bash command: npm test",
		);
	});

	it("labels each command in a compound bash call", () => {
		assert.equal(
			describeToolCall("bash", {
				command: "cp source.txt target.txt && cmp source.txt target.txt",
			}),
			"bash commands:\n- cp source.txt target.txt\n- cmp source.txt target.txt",
		);
	});

	it("shows all permission-required tools in the question", async () => {
		let prompt = "";
		const context = {
			hasUI: true,
			ui: {
				select: async (title: string) => {
					prompt = title;
					return "Allow";
				},
			},
		} as unknown as ExtensionContext;

		await askPermissionForModeOverride(
			"default",
			"write",
			{ path: "notes.txt" },
			"Write tools are blocked in default mode.",
			context,
			[
				{ toolName: "write", input: { path: "notes.txt" } },
				{ toolName: "bash", input: { command: "npm test" } },
			],
		);

		assert.match(
			prompt,
			/Pi wants to run \(the "Allow for this session" option will allow these calls for the rest of this session\):\n\n- write path: notes\.txt/,
		);
		assert.match(prompt, /- bash command: npm test/);
		assert.match(
			prompt,
			/Pi wants to run \(the "Allow for this session" option will allow these calls for the rest of this session\):\n\n- write path: notes\.txt\n- bash command: npm test/,
		);
	});
});

describe("parallel permission dialog", () => {
	it("lists blocked sibling calls without listing safe siblings", async () => {
		let toolCallHandler:
			| ((event: unknown, ctx: ExtensionContext) => Promise<unknown>)
			| undefined;
		const extensionApi = {
			on: (eventName: string, handler: unknown) => {
				if (eventName === "tool_call") {
					toolCallHandler = handler as typeof toolCallHandler;
				}
			},
			registerCommand: () => {},
			registerShortcut: () => {},
			appendEntry: () => {},
		} as unknown as ExtensionAPI;
		readPermissionGate(extensionApi);

		let prompt = "";
		const context = {
			hasUI: true,
			ui: {
				select: async (title: string) => {
					prompt = title;
					return "Allow";
				},
				notify: () => {},
			},
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: {
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "read-call",
									name: "read",
									arguments: { path: "README.md" },
								},
								{
									type: "toolCall",
									id: "write-call",
									name: "write",
									arguments: { path: "notes.txt" },
								},
								{
									type: "toolCall",
									id: "bash-call",
									name: "bash",
									arguments: { command: "npm test" },
								},
							],
						},
					},
				],
			},
		} as unknown as ExtensionContext;

		assert.ok(toolCallHandler);
		await toolCallHandler(
			{
				type: "tool_call",
				toolCallId: "write-call",
				toolName: "write",
				input: { path: "notes.txt" },
			},
			context,
		);

		assert.match(prompt, /- write path: notes\.txt/);
		assert.match(prompt, /- bash command: npm test/);
		assert.doesNotMatch(prompt, /README\.md/);
	});
});

describe("permission mode status", () => {
	it("publishes the active mode through Pi's built-in status footer", () => {
		let sessionStartHandler:
			| ((event: unknown, ctx: ExtensionContext) => void)
			| undefined;
		let status: { key: string; text: string | undefined } | undefined;
		const extensionApi = {
			on: (eventName: string, handler: unknown) => {
				if (eventName === "session_start") {
					sessionStartHandler = handler as typeof sessionStartHandler;
				}
			},
			registerCommand: () => {},
			registerShortcut: () => {},
			appendEntry: () => {},
		} as unknown as ExtensionAPI;
		readPermissionGate(extensionApi);

		const context = {
			hasUI: true,
			ui: {
				setStatus: (key: string, text: string | undefined) => {
					status = { key, text };
				},
				theme: {
					fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
				},
			},
			sessionManager: {
				getEntries: () => [],
			},
		} as unknown as ExtensionContext;

		assert.ok(sessionStartHandler);
		sessionStartHandler({}, context);

		assert.deepEqual(status, {
			key: "read-permission-gate-mode",
			text: "<dim>Mode: </dim><accent>Default</accent>",
		});
	});
});

describe("extension shortcuts", () => {
	it("does not bind mode cycling to Enter-equivalent Ctrl+M", async () => {
		const extensionSource = await readFile(
			new URL("../src/read-permission-gate.ts", import.meta.url),
			"utf8",
		);

		assert.doesNotMatch(extensionSource, /registerShortcut\("ctrl\+m"/);
		assert.doesNotMatch(extensionSource, /registerShortcut\("ctrl\+shift\+m"/);
		assert.match(extensionSource, /registerShortcut\("alt\+m"/);
	});
});

describe("isAllowedToolCall", () => {
	it("allows the read tool without prompting", () => {
		assert.equal(isAllowedToolCall("read", { path: "README.md" }), true);
	});

	it("blocks write and edit tools", () => {
		assert.equal(isAllowedToolCall("write", { path: "notes.txt" }), false);
		assert.equal(isAllowedToolCall("edit", { path: "notes.txt" }), false);
	});

	it("allows conservative read-only bash commands", () => {
		assert.equal(isAllowedToolCall("bash", { command: "pwd" }), true);
		assert.equal(isAllowedToolCall("bash", { command: 'echo "---"' }), true);
		assert.equal(isAllowedToolCall("bash", { command: "ls src" }), true);
		assert.equal(
			isAllowedToolCall("bash", { command: "rg permission src" }),
			true,
		);
		assert.equal(
			isAllowedToolCall("bash", { command: "find src -type f" }),
			true,
		);
	});

	it("allows pipes inside quoted arguments", () => {
		assert.equal(
			isAllowedToolCall("bash", {
				command:
					'rg -n "\\bsetup\\s*\\(|main\\s*\\(|run\\.py|from main|import main" .',
			}),
			true,
		);
		assert.equal(
			isAllowedToolCall("bash", { command: 'rg "foo|bar" src' }),
			true,
		);
	});

	it("still validates pipelines outside quoted arguments", () => {
		assert.equal(
			isAllowedToolCall("bash", {
				command: 'rg "foo|bar" src | sort',
			}),
			true,
		);
		assert.equal(
			isAllowedToolCall("bash", {
				command: 'rg "foo|bar" src | rm results.txt',
			}),
			false,
		);
	});

	it("allows escaped pipe characters as arguments", () => {
		assert.equal(
			isAllowedToolCall("bash", { command: "rg foo\\|bar src" }),
			true,
		);
	});

	it("allows pipelines and boolean chains when every segment is read-only", () => {
		assert.equal(
			isAllowedToolCall("bash", { command: "find src -type f | sort" }),
			true,
		);
		assert.equal(
			isAllowedToolCall("bash", { command: "pwd && ls && rg gate src" }),
			true,
		);
		assert.equal(
			isAllowedToolCall("bash", { command: "rg missing src || true" }),
			true,
		);
	});

	it("blocks empty bash commands", () => {
		assert.equal(isAllowedToolCall("bash", { command: "" }), false);
		assert.equal(isAllowedToolCall("bash", {}), false);
	});

	it("allows semicolon-chained read-only commands", () => {
		assert.equal(isAllowedToolCall("bash", { command: "pwd; ls" }), true);
		assert.equal(
			isAllowedToolCall("bash", {
				command:
					'cat ~/.pi/agent/settings.json 2>/dev/null; echo "---"; ls ~/.pi/agent/ 2>/dev/null',
			}),
			true,
		);
		assert.equal(
			isAllowedToolCall("bash", {
				command: "find src -type f; sort | head -3",
			}),
			true,
		);
	});

	it("allows redirects that discard output into /dev/null", () => {
		assert.equal(
			isAllowedToolCall("bash", { command: "ls ~/.pi 2>/dev/null" }),
			true,
		);
		assert.equal(
			isAllowedToolCall("bash", { command: "cat README.md >/dev/null" }),
			true,
		);
		assert.equal(
			isAllowedToolCall("bash", { command: "cat README.md >> /dev/null" }),
			true,
		);
		assert.equal(
			isAllowedToolCall("bash", { command: "find src -type f &>/dev/null" }),
			true,
		);
		assert.equal(
			isAllowedToolCall("bash", {
				command: "find ~ -maxdepth 4 2>/dev/null | head -20",
			}),
			true,
		);
		assert.equal(
			isAllowedToolCall("bash", {
				command: 'find ~/.pi -iname "*01a02d67*" 2>/dev/null; ls ~/.pi',
			}),
			true,
		);
		assert.equal(
			isAllowedToolCall("bash", { command: "find src 2>/dev/null&& sort" }),
			true,
		);
	});

	it("still blocks redirects that write to real files", () => {
		assert.equal(
			isAllowedToolCall("bash", { command: "cat README.md > copy.md" }),
			false,
		);
		assert.equal(
			isAllowedToolCall("bash", { command: "cat README.md >> copy.md" }),
			false,
		);
		assert.equal(
			isAllowedToolCall("bash", { command: "find src -type f 2> errors.txt" }),
			false,
		);
		assert.equal(
			isAllowedToolCall("bash", { command: "ls >/dev/null/copy.md" }),
			false,
		);
	});

	it("blocks bash commands with unsafe shell syntax", () => {
		assert.equal(
			isAllowedToolCall("bash", { command: "cat README.md > copy.md" }),
			false,
		);
		assert.equal(
			isAllowedToolCall("bash", { command: "cat README.md >> copy.md" }),
			false,
		);
		assert.equal(isAllowedToolCall("bash", { command: "echo $(pwd)" }), false);
		assert.equal(isAllowedToolCall("bash", { command: "echo `pwd`" }), false);
	});

	it("blocks bash chains containing an unknown or dangerous command", () => {
		assert.equal(
			isAllowedToolCall("bash", { command: "ls | rm file.txt" }),
			false,
		);
		assert.equal(
			isAllowedToolCall("bash", { command: "pwd && npm test" }),
			false,
		);
		assert.equal(isAllowedToolCall("bash", { command: "ls; npm test" }), false);
	});

	it("blocks malformed or unsupported shell control syntax", () => {
		assert.equal(isAllowedToolCall("bash", { command: "ls |" }), false);
		assert.equal(isAllowedToolCall("bash", { command: "| ls" }), false);
		assert.equal(isAllowedToolCall("bash", { command: "ls ||" }), false);
		assert.equal(isAllowedToolCall("bash", { command: "ls & pwd" }), false);
		assert.equal(isAllowedToolCall("bash", { command: "; ls" }), false);
		assert.equal(isAllowedToolCall("bash", { command: "ls;" }), false);
		assert.equal(isAllowedToolCall("bash", { command: "ls ;; pwd" }), false);
	});
});

describe("extractBashCommandSegments", () => {
	it("returns every segment of the command verbatim", () => {
		assert.deepEqual(extractBashCommandSegments("npm run dev"), [
			"npm run dev",
		]);
		assert.deepEqual(
			extractBashCommandSegments('echo "---"; find src 2>/dev/null | head -20'),
			['echo "---"', "find src", "head -20"],
		);
		assert.deepEqual(extractBashCommandSegments('rg "foo|bar" src'), [
			'rg "foo|bar" src',
		]);
		assert.deepEqual(
			extractBashCommandSegments(
				"cp source.txt target.txt\nprintf 'done'\ncmp source.txt target.txt",
			),
			[
				"cp source.txt target.txt",
				"printf 'done'",
				"cmp source.txt target.txt",
			],
		);
	});

	it("returns undefined for empty or malformed commands", () => {
		assert.equal(extractBashCommandSegments(""), undefined);
		assert.equal(extractBashCommandSegments("ls & pwd"), undefined);
		assert.equal(extractBashCommandSegments("echo $(pwd)"), undefined);
		assert.equal(extractBashCommandSegments("cat f > copy.md"), undefined);
	});
});

describe("permission-required tool calls", () => {
	it("returns only blocked tools from a nested parallel batch", () => {
		assert.deepEqual(
			getPermissionRequiredToolCalls("default", "multi_tool_use.parallel", {
				tool_uses: [
					{
						recipient_name: "functions.read",
						parameters: { path: "README.md" },
					},
					{
						recipient_name: "functions.write",
						parameters: { path: "notes.txt" },
					},
					{
						recipient_name: "functions.bash",
						parameters: { command: "npm test" },
					},
				],
			}).map(({ toolName, input }) => ({ toolName, input })),
			[
				{ toolName: "write", input: { path: "notes.txt" } },
				{ toolName: "bash", input: { command: "npm test" } },
			],
		);
	});
});

describe("session allowances", () => {
	/** Creates an empty allowance store for a fresh session. */
	function createEmptyAllowances(): SessionAllowances {
		return {
			allowedTools: new Set<string>(),
			allowedBashCommandPrefixes: new Set<string>(),
		};
	}

	it("does not change decisions when nothing was approved yet", () => {
		assert.equal(
			canRunToolCallInMode(
				"default",
				"bash",
				{ command: "npm test" },
				createEmptyAllowances(),
			).allowed,
			false,
		);
		assert.equal(
			canRunToolCallInMode(
				"default",
				"write",
				{ path: "a.txt" },
				createEmptyAllowances(),
			).allowed,
			false,
		);
	});

	it("allows commands that extend an approved command line", () => {
		const allowances = createEmptyAllowances();
		assert.deepEqual(
			addSessionAllowance(allowances, "bash", { command: "npm run dev" }),
			["npm run dev"],
		);

		// The exact approved command line runs again without prompting.
		assert.equal(
			canRunToolCallInMode(
				"default",
				"bash",
				{ command: "npm run dev" },
				allowances,
			).allowed,
			true,
		);
		// Extra arguments after the approved command line are fine.
		assert.equal(
			canRunToolCallInMode(
				"default",
				"bash",
				{ command: "npm run dev -- --watch" },
				allowances,
			).allowed,
			true,
		);
		// Already-safe whitelist commands keep working alongside approvals.
		assert.equal(
			canRunToolCallInMode(
				"default",
				"bash",
				{ command: "npm run dev && ls src" },
				allowances,
			).allowed,
			true,
		);
	});

	it("does not approve sibling invocations of the same binary", () => {
		const allowances = createEmptyAllowances();
		addSessionAllowance(allowances, "bash", { command: "npm run dev" });

		assert.equal(
			canRunToolCallInMode(
				"default",
				"bash",
				{ command: "npm run test" },
				allowances,
			).allowed,
			false,
		);
		assert.equal(
			canRunToolCallInMode(
				"default",
				"bash",
				{ command: "npm install" },
				allowances,
			).allowed,
			false,
		);
		// A matching prefix alone is not enough: "debug" merely shares the
		// start of "dev" but is a different subcommand.
		assert.equal(
			canRunToolCallInMode(
				"default",
				"bash",
				{ command: "npm run debug" },
				allowances,
			).allowed,
			false,
		);
	});

	it("still blocks commands that were not part of the session approval", () => {
		const allowances = createEmptyAllowances();
		addSessionAllowance(allowances, "bash", { command: "npm test" });

		assert.equal(
			canRunToolCallInMode(
				"default",
				"bash",
				{ command: "npm install && rm -rf dist" },
				allowances,
			).allowed,
			false,
		);
	});

	it("does not let a session approval bypass unsafe shell syntax", () => {
		const allowances = createEmptyAllowances();
		addSessionAllowance(allowances, "bash", { command: "cat README.md" });

		assert.equal(
			canRunToolCallInMode(
				"default",
				"bash",
				{ command: "cat $(pwd)" },
				allowances,
			).allowed,
			false,
		);
		assert.equal(
			canRunToolCallInMode(
				"default",
				"bash",
				{ command: "cat README.md > copy.md" },
				allowances,
			).allowed,
			false,
		);
	});

	it("allows a tool for the whole session once approved", () => {
		const allowances = createEmptyAllowances();
		assert.deepEqual(
			addSessionAllowance(allowances, "write", { path: "notes.txt" }),
			["write"],
		);

		assert.equal(
			canRunToolCallInMode(
				"default",
				"write",
				{ path: "other.txt" },
				allowances,
			).allowed,
			true,
		);
		assert.equal(
			canRunToolCallInMode("default", "edit", { path: "other.txt" }, allowances)
				.allowed,
			false,
		);
	});

	it("applies session approvals inside multi-tool batches", () => {
		const allowances = createEmptyAllowances();
		addSessionAllowance(allowances, "bash", { command: "npm test" });

		assert.equal(
			canRunToolCallInMode(
				"default",
				"multi_tool_use.parallel",
				{
					tool_uses: [
						{
							recipient_name: "functions.bash",
							parameters: { command: "npm test -- --run" },
						},
					],
				},
				allowances,
			).allowed,
			true,
		);

		assert.equal(
			canRunToolCallInMode(
				"default",
				"multi_tool_use.parallel",
				{
					tool_uses: [
						{
							recipient_name: "functions.bash",
							parameters: { command: "npm run lint" },
						},
					],
				},
				allowances,
			).allowed,
			false,
		);
	});

	it("stores only blocked children when allowing a parallel batch for a session", () => {
		const allowances = createEmptyAllowances();
		const blockedTools = getPermissionRequiredToolCalls(
			"default",
			"multi_tool_use.parallel",
			{
				tool_uses: [
					{
						recipient_name: "functions.read",
						parameters: { path: "README.md" },
					},
					{
						recipient_name: "functions.write",
						parameters: { path: "notes.txt" },
					},
					{
						recipient_name: "functions.bash",
						parameters: { command: "npm test" },
					},
				],
			},
			allowances,
		);

		assert.deepEqual(addSessionAllowances(allowances, blockedTools), [
			"write",
			"npm test",
		]);
		assert.equal(allowances.allowedTools.has("multi_tool_use.parallel"), false);
		assert.equal(
			canRunToolCallInMode(
				"default",
				"multi_tool_use.parallel",
				{
					tool_uses: [
						{
							recipient_name: "functions.read",
							parameters: { path: "other.md" },
						},
						{
							recipient_name: "functions.write",
							parameters: { path: "other.txt" },
						},
						{
							recipient_name: "functions.bash",
							parameters: { command: "npm test -- --run" },
						},
					],
				},
				allowances,
			).allowed,
			true,
		);
	});
});
