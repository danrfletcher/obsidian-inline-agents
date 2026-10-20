import { test } from "node:test";
import assert from "node:assert/strict";
import { createBlankRuntime, renameRuntime, validateRuntimeCommit } from "../../src/runtime/runtimeEdit";
import { migrateSettings } from "../../src/runtime/settingsMigrate";
import type { AgentConsoleSettings } from "../../src/settingsModel";
import type { AgentRuntime } from "../../src/runtime/types";

function runtime(name: string, overrides: Partial<AgentRuntime> = {}): AgentRuntime {
	return { ...createBlankRuntime(`id-${name}`), name, baseUrl: "http://127.0.0.1:18789", ...overrides };
}

// --- R4: a rename follows the Default target -------------------------------

test("R4: renaming the runtime that is the Default target carries the rename to defaultTarget", () => {
	const hermes = runtime("hermes");
	const settings = { runtimes: [runtime("openclaw"), hermes], defaultTarget: "hermes" };
	renameRuntime(settings, hermes, "hermes-prod");
	assert.equal(hermes.name, "hermes-prod");
	assert.equal(settings.defaultTarget, "hermes-prod");
});

test("R4: the rename survives the next load — migrateSettings keeps it, instead of resetting the Default target to terminal", () => {
	const hermes = runtime("hermes");
	const settings = { runtimes: [hermes], defaultTarget: "hermes" };
	renameRuntime(settings, hermes, "Hermes Prod");
	const reloaded = migrateSettings(JSON.parse(JSON.stringify({ ...migrateSettings(null), ...settings })) as Partial<AgentConsoleSettings>);
	assert.equal(reloaded.defaultTarget, "Hermes Prod");
});

test("R4: the match is case-insensitive and trimmed, like the resolver's", () => {
	const hermes = runtime("Hermes");
	const settings = { runtimes: [hermes], defaultTarget: " hermes " };
	renameRuntime(settings, hermes, "  agent2 ");
	assert.equal(hermes.name, "agent2");
	assert.equal(settings.defaultTarget, "agent2");
});

test("R4: renaming a runtime that is not the Default target leaves defaultTarget alone", () => {
	const hermes = runtime("hermes");
	const settings = { runtimes: [runtime("openclaw"), hermes], defaultTarget: "openclaw" };
	renameRuntime(settings, hermes, "other");
	assert.equal(settings.defaultTarget, "openclaw");
});

test("R4: a Default target of terminal is never touched by a rename", () => {
	const hermes = runtime("hermes");
	const settings = { runtimes: [hermes], defaultTarget: "terminal" };
	renameRuntime(settings, hermes, "x");
	assert.equal(settings.defaultTarget, "terminal");
});

// --- R5: a new row stays a draft until it is valid --------------------------

test("R5: a blank new row is not committable", () => {
	const result = validateRuntimeCommit(createBlankRuntime("new"), []);
	assert.equal(result.ok, false);
});

test("R5: a name without a base URL is not committable, and neither is a base URL without a name", () => {
	const named = createBlankRuntime("a");
	named.name = "openclaw";
	assert.equal(validateRuntimeCommit(named, []).ok, false);

	const withUrl = createBlankRuntime("b");
	withUrl.baseUrl = "http://127.0.0.1:18789";
	assert.equal(validateRuntimeCommit(withUrl, []).ok, false);
});

test("R5: a valid name and base URL are committable", () => {
	assert.deepEqual(validateRuntimeCommit(runtime("openclaw"), []), { ok: true });
});

test("R5/E14: a draft whose name duplicates a saved runtime (case-insensitively) is not committable", () => {
	const draft = runtime("OpenClaw");
	assert.equal(validateRuntimeCommit(draft, [runtime("openclaw")]).ok, false);
});

test("R5: a base URL with credentials or a query string is not committable", () => {
	assert.equal(validateRuntimeCommit(runtime("a", { baseUrl: "http://user:pw@host" }), []).ok, false);
	assert.equal(validateRuntimeCommit(runtime("a", { baseUrl: "http://host?token=x" }), []).ok, false);
});

test("R5: a new row starts with token required on and is otherwise empty", () => {
	const blank = createBlankRuntime("new");
	assert.equal(blank.id, "new");
	assert.equal(blank.tokenRequired, true);
	assert.equal(blank.name, "");
	assert.equal(blank.baseUrl, "");
});
