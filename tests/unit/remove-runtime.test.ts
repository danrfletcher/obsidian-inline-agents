import { test } from "node:test";
import assert from "node:assert/strict";
import { removeRuntime } from "../../src/runtime/removeRuntime";
import type { AgentRuntime } from "../../src/runtime/types";
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

function fakeClearer(): { cleared: string[]; clearSecret: (name: string) => void } {
	const cleared: string[] = [];
	return { cleared, clearSecret: (name) => cleared.push(name) };
}

test("T1/T11/C17: removing a runtime clears its secret via SecretStorage.setSecret(name, '')", () => {
	const runtime = makeRuntime({});
	const settings: RemovableSettings = { runtimes: [runtime], defaultTarget: "terminal" };
	const clearer = fakeClearer();

	removeRuntime(settings, 0, clearer);

	assert.deepEqual(settings.runtimes, []);
	assert.deepEqual(clearer.cleared, ["openclaw-secret"]);
});

test("T11/C17: removing the runtime that is the default target resets defaultTarget to terminal", () => {
	const runtime = makeRuntime({ name: "OpenClaw" });
	const settings: RemovableSettings = { runtimes: [runtime], defaultTarget: "openclaw" };
	const clearer = fakeClearer();

	removeRuntime(settings, 0, clearer);

	assert.equal(settings.defaultTarget, "terminal");
});

test("removing a runtime that is not the default target leaves defaultTarget untouched", () => {
	const removed = makeRuntime({ name: "openclaw" });
	const kept = makeRuntime({ name: "hermes", id: "hermes-id", tokenSecretName: "hermes-secret" });
	const settings: RemovableSettings = { runtimes: [removed, kept], defaultTarget: "hermes" };
	const clearer = fakeClearer();

	removeRuntime(settings, 0, clearer);

	assert.equal(settings.defaultTarget, "hermes");
	assert.deepEqual(settings.runtimes, [kept]);
});

test("a runtime with no tokenSecretName set clears nothing", () => {
	const runtime = makeRuntime({ tokenSecretName: undefined });
	const settings: RemovableSettings = { runtimes: [runtime], defaultTarget: "terminal" };
	const clearer = fakeClearer();

	removeRuntime(settings, 0, clearer);

	assert.deepEqual(clearer.cleared, []);
});

test("clearing is skipped when another remaining runtime still references the same secret name", () => {
	const removed = makeRuntime({ name: "openclaw", tokenSecretName: "shared-secret" });
	const kept = makeRuntime({ name: "hermes", id: "hermes-id", tokenSecretName: "shared-secret" });
	const settings: RemovableSettings = { runtimes: [removed, kept], defaultTarget: "terminal" };
	const clearer = fakeClearer();

	removeRuntime(settings, 0, clearer);

	assert.deepEqual(clearer.cleared, []);
	assert.deepEqual(settings.runtimes, [kept]);
});

test("removing an out-of-range index is a no-op", () => {
	const settings: RemovableSettings = { runtimes: [], defaultTarget: "terminal" };
	const clearer = fakeClearer();

	removeRuntime(settings, 0, clearer);

	assert.deepEqual(settings.runtimes, []);
	assert.deepEqual(clearer.cleared, []);
});
