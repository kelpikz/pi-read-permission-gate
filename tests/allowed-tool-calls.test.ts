import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isAllowedToolCall } from "../src/allowed-tool-calls.ts";

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
