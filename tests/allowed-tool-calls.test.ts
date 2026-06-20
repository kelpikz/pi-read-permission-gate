import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
	canRunToolCallInMode,
	isAllowedToolCall,
	isPermissionMode,
} from "../src/allowed-tool-calls.ts";

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
		assert.equal(isAllowedToolCall("bash", { command: "pwd; ls" }), false);
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
});
