import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { removeRuntime } from "../../src/runtime/removeRuntime";
import type { AgentRuntime, SecretStore } from "../../src/runtime/types";
import type { RemovableSettings } from "../../src/runtime/removeRuntime";

function makeRuntime(overrides: Partial<AgentRuntime>): AgentRuntime {
	return {
		id: "id-" + (overrides.name ?? "x"),
		name: "openclaw",
		kind: "openclaw-hook",
		baseUrl: "http://127.0.0.1:18789",
		agentId: "main",
		tokenRequired: true,
		tokenSecretName: "openclaw-secret",
		sendSessionKeyHeader: false,
		...overrides,
	};
}

test("removing a runtime drops it from the list and keeps its token secret in storage", () => {
	const removed = makeRuntime({ name: "openclaw", tokenSecretName: "openai-key" });
	const kept = makeRuntime({ name: "hermes", tokenSecretName: "hermes-secret" });
	const settings: RemovableSettings = { runtimes: [removed, kept], defaultTarget: "terminal" };
	// A real in-memory SecretStore standing in for Obsidian's shared storage.
	const storage = new Map([["openai-key", "sk-shared"], ["hermes-secret", "h-token"]]);
	const store: SecretStore = {
		hasToken: (name) => !!name && (storage.get(name) ?? "").trim() !== "",
		getToken: (name) => (name ? storage.get(name) || undefined : undefined),
	};

	removeRuntime(settings, 0);

	assert.deepEqual(settings.runtimes, [kept]);
	// The secret the removed runtime pointed at (which another plugin or
	// device may use too) is still there, untouched.
	assert.equal(store.getToken("openai-key"), "sk-shared");
	assert.equal(store.getToken(kept.tokenSecretName), "h-token");
});

test("Remove never writes to SecretStorage: no setSecret call anywhere in settings.ts", () => {
	// removeRuntime takes no secret store, so the only way to blank a shared
	// secret on Remove is the settings tab calling setSecret itself.
	const source = readFileSync(join(process.cwd(), "src/settings.ts"), "utf8");
	assert.doesNotMatch(source, /setSecret\s*\(/);
});

test("T11/C17: removing the runtime that is the default target resets defaultTarget to terminal", () => {
	const runtime = makeRuntime({ name: "OpenClaw" });
	const settings: RemovableSettings = { runtimes: [runtime], defaultTarget: "openclaw" };

	removeRuntime(settings, 0);

	assert.equal(settings.defaultTarget, "terminal");
});

test("removing a runtime that is not the default target leaves defaultTarget untouched", () => {
	const removed = makeRuntime({ name: "openclaw" });
	const kept = makeRuntime({ name: "hermes", id: "hermes-id", tokenSecretName: "hermes-secret" });
	const settings: RemovableSettings = { runtimes: [removed, kept], defaultTarget: "hermes" };

	removeRuntime(settings, 0);

	assert.equal(settings.defaultTarget, "hermes");
	assert.deepEqual(settings.runtimes, [kept]);
});

test("removing an out-of-range index is a no-op", () => {
	const settings: RemovableSettings = { runtimes: [], defaultTarget: "terminal" };

	removeRuntime(settings, 0);

	assert.deepEqual(settings.runtimes, []);
});
