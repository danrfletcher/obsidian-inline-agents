import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateSettings } from "../../src/runtime/settingsMigrate";
import { DEFAULT_SETTINGS } from "../../src/settingsModel";
import { validateBaseUrl, validateRuntimeName, validateThreadUrlTemplate } from "../../src/runtime/validation";
import type { AgentRuntime } from "../../src/runtime/types";

test("E13: null (brand-new vault) loads full defaults", () => {
	const result = migrateSettings(null);
	assert.deepEqual(result, DEFAULT_SETTINGS);
});

test("E13: a 0.2.1 save (no runtimes/defaultTarget/defaultOpen) gets runtimes: [], default target Terminal, open on", () => {
	const legacySave = {
		agent: "opencode" as const,
		autoApproveDefault: true,
		allowJsExpressions: false,
		claude: { binaryPath: "/custom/claude", models: [{ name: "fast", model: "sonnet" }] },
		opencode: { binaryPath: "opencode", models: [{ name: "", model: "" }] },
	};
	const result = migrateSettings(legacySave);
	assert.deepEqual(result.runtimes, []);
	assert.equal(result.defaultTarget, "terminal");
	assert.equal(result.defaultOpen, true);
	// Existing fields are untouched by the migration.
	assert.equal(result.agent, "opencode");
	assert.equal(result.autoApproveDefault, true);
	assert.equal(result.claude.binaryPath, "/custom/claude");
	assert.deepEqual(result.claude.models, [{ name: "fast", model: "sonnet" }]);
});

test("G2: a configured runtimes list and defaultTarget pointing at it survive migration unchanged", () => {
	const runtime: AgentRuntime = {
		id: "openclaw",
		name: "openclaw",
		kind: "openclaw-hook",
		baseUrl: "http://127.0.0.1:18789",
		agentId: "main",
		tokenRequired: true,
		sendSessionKeyHeader: false,
	};
	const result = migrateSettings({ runtimes: [runtime], defaultTarget: "openclaw", defaultOpen: false });
	assert.deepEqual(result.runtimes, [runtime]);
	assert.equal(result.defaultTarget, "openclaw");
	assert.equal(result.defaultOpen, false);
});

test("unknown default target falls to Terminal", () => {
	const result = migrateSettings({ defaultTarget: "some-deleted-runtime", runtimes: [] });
	assert.equal(result.defaultTarget, "terminal");
});

test("default target matching an existing runtime name case-insensitively is kept, case preserved", () => {
	const runtime: AgentRuntime = {
		id: "openclaw",
		name: "OpenClaw",
		kind: "openclaw-hook",
		baseUrl: "http://127.0.0.1:18789",
		agentId: "main",
		tokenRequired: true,
		sendSessionKeyHeader: false,
	};
	const result = migrateSettings({ defaultTarget: "openclaw", runtimes: [runtime] });
	assert.equal(result.defaultTarget, "openclaw");
});

test("an empty claude/opencode models list is backfilled with one placeholder row", () => {
	const result = migrateSettings({
		claude: { binaryPath: "x", models: [] },
		opencode: { binaryPath: "y", models: [] },
	});
	assert.deepEqual(result.claude.models, [{ name: "", model: "" }]);
	assert.deepEqual(result.opencode.models, [{ name: "", model: "" }]);
});

test("E14: validateRuntimeName refuses empty and duplicate (case-insensitive) names", () => {
	const runtimes: AgentRuntime[] = [
		{
			id: "a",
			name: "OpenClaw",
			kind: "openclaw-hook",
			baseUrl: "http://x",
			agentId: "",
			tokenRequired: true,
			sendSessionKeyHeader: false,
		},
	];
	assert.equal(validateRuntimeName("", runtimes, -1).ok, false);
	assert.equal(validateRuntimeName("   ", runtimes, -1).ok, false);
	assert.equal(validateRuntimeName("openclaw", runtimes, -1).ok, false);
	assert.equal(validateRuntimeName("OPENCLAW", runtimes, -1).ok, false);
	// Renaming a row to its own current name is allowed (selfIndex excluded).
	assert.equal(validateRuntimeName("OpenClaw", runtimes, 0).ok, true);
	assert.equal(validateRuntimeName("another-name", runtimes, -1).ok, true);
});

test("validateBaseUrl: URL scheme allow-list", () => {
	assert.equal(validateBaseUrl("http://127.0.0.1:18789").ok, true);
	assert.equal(validateBaseUrl("https://example.com").ok, true);
	assert.equal(validateBaseUrl("ftp://example.com").ok, false);
	assert.equal(validateBaseUrl("javascript:alert(1)").ok, false);
	assert.equal(validateBaseUrl("").ok, false);
	assert.equal(validateBaseUrl("not a url").ok, false);
});

test("validateBaseUrl: rejects embedded credentials and query strings (F5)", () => {
	assert.equal(validateBaseUrl("http://user:pass@example.com").ok, false);
	assert.equal(validateBaseUrl("http://example.com?token=secret").ok, false);
});

test("validateThreadUrlTemplate: URL scheme allow-list", () => {
	assert.equal(validateThreadUrlTemplate("").ok, true);
	assert.equal(validateThreadUrlTemplate("https://example.com/{sessionKey}").ok, true);
	assert.equal(validateThreadUrlTemplate("myapp://open/{agentId}").ok, true);
	assert.equal(validateThreadUrlTemplate("file:///etc/passwd").ok, false);
	assert.equal(validateThreadUrlTemplate("javascript:alert(1)").ok, false);
	assert.equal(validateThreadUrlTemplate("data:text/html,x").ok, false);
	assert.equal(validateThreadUrlTemplate("vbscript:msgbox(1)").ok, false);
});
