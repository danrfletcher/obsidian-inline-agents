import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTargetName, resolveClickTarget, computeIgnoredFields } from "../../src/runtime/targetResolve";
import type { AgentRuntime, SecretStore } from "../../src/runtime/types";

const openclaw: AgentRuntime = {
	id: "openclaw-id",
	name: "openclaw",
	kind: "openclaw-hook",
	baseUrl: "http://127.0.0.1:18789",
	agentId: "main",
	tokenRequired: true,
	tokenSecretName: "openclaw-secret",
	sendSessionKeyHeader: false,
};
const chatRuntime: AgentRuntime = {
	id: "chat-id",
	name: "MyChat",
	kind: "openai-chat",
	baseUrl: "https://api.example.com",
	agentId: "gpt-4o",
	tokenRequired: false,
	sendSessionKeyHeader: true,
};
const runtimes = [openclaw, chatRuntime];

/** Keyed by secret *name* (tokenSecretName), not runtime id — see runtime/types.ts. */
function fakeSecretStore(hasToken: Record<string, boolean>): SecretStore {
	return { hasToken: (name) => (name ? hasToken[name] === true : false) };
}

test("no target: line silently resolves via the configured default target", () => {
	const result = resolveTargetName(undefined, runtimes, "openclaw");
	assert.equal(result.kind, "runtime");
	if (result.kind === "runtime") assert.equal(result.runtime.id, "openclaw-id");
	assert.deepEqual(result.notices, []);
});

test("no target: line with default target terminal resolves to terminal, no notices", () => {
	const result = resolveTargetName(undefined, runtimes, "terminal");
	assert.deepEqual(result, { kind: "terminal", notices: [] });
});

test("target: terminal is always literal, regardless of the configured default target (F8)", () => {
	const result = resolveTargetName("terminal", runtimes, "openclaw");
	assert.deepEqual(result, { kind: "terminal", notices: [] });
});

test("target: <runtime name> matches case-insensitively, runtime's own name case is preserved", () => {
	const result = resolveTargetName("OPENCLAW", runtimes, "terminal");
	assert.equal(result.kind, "runtime");
	if (result.kind === "runtime") assert.equal(result.runtime.name, "openclaw");
});

test("E1: an unknown target name shows a notice, then the default target runs", () => {
	const result = resolveTargetName("does-not-exist", runtimes, "terminal");
	assert.equal(result.kind, "terminal");
	assert.equal(result.notices.length, 1);
	assert.match(result.notices[0], /Unknown target "does-not-exist"/);
});

test("E1: an unknown target name falls back to a runtime default target, not just terminal", () => {
	const result = resolveTargetName("does-not-exist", runtimes, "MyChat");
	assert.equal(result.kind, "runtime");
	if (result.kind === "runtime") assert.equal(result.runtime.name, "MyChat");
	assert.equal(result.notices.length, 1);
});

test("G11: computeIgnoredFields names exactly the terminal-only fields that were set", () => {
	assert.deepEqual(computeIgnoredFields({}), []);
	assert.deepEqual(computeIgnoredFields({ model: "sonnet" }), ["model"]);
	assert.deepEqual(
		computeIgnoredFields({ model: "sonnet", autoApprove: true, showTerminal: false }),
		["model", "autoApprove", "showTerminal"]
	);
});

test("resolveClickTarget: terminal target produces no ignored-fields or token notices", () => {
	const result = resolveClickTarget({ target: "terminal", model: "sonnet" }, { runtimes, defaultTarget: "terminal" }, fakeSecretStore({}));
	assert.deepEqual(result, { kind: "terminal", notices: [] });
});

test("G11: a runtime target with ignored fields set gets a one-line notice naming exactly those set", () => {
	const result = resolveClickTarget(
		{ target: "openclaw", model: "sonnet", autoApprove: true },
		{ runtimes, defaultTarget: "terminal" },
		fakeSecretStore({ "openclaw-secret": true })
	);
	assert.equal(result.kind, "runtime");
	assert.equal(result.notices.length, 1);
	assert.match(result.notices[0], /Ignored for runtime target "openclaw": model, autoApprove\./);
});

test("E6: a token-required runtime with no token on this device gets a token-missing notice before any request", () => {
	const result = resolveClickTarget({ target: "openclaw" }, { runtimes, defaultTarget: "terminal" }, fakeSecretStore({}));
	assert.equal(result.kind, "runtime");
	assert.equal(result.notices.length, 1);
	assert.match(result.notices[0], /Token not set on this device for "openclaw"/);
});

test("E6: a token-required runtime with a token present on this device gets no token-missing notice", () => {
	const result = resolveClickTarget({ target: "openclaw" }, { runtimes, defaultTarget: "terminal" }, fakeSecretStore({ "openclaw-secret": true }));
	assert.equal(result.kind, "runtime");
	assert.deepEqual(result.notices, []);
});

test("R1: token lookup is keyed by tokenSecretName, not runtime.id — a store entry under the id is ignored", () => {
	const result = resolveClickTarget(
		{ target: "openclaw" },
		{ runtimes, defaultTarget: "terminal" },
		fakeSecretStore({ "openclaw-id": true })
	);
	assert.equal(result.kind, "runtime");
	assert.equal(result.notices.length, 1);
	assert.match(result.notices[0], /Token not set on this device for "openclaw"/);
});

test("R1: a runtime with no tokenSecretName configured is always treated as missing a token", () => {
	const noSecretName: AgentRuntime = { ...openclaw, tokenSecretName: undefined };
	const result = resolveClickTarget(
		{ target: "openclaw" },
		{ runtimes: [noSecretName], defaultTarget: "terminal" },
		fakeSecretStore({ "openclaw-secret": true })
	);
	assert.equal(result.kind, "runtime");
	assert.match(result.notices[0], /Token not set on this device for "openclaw"/);
});

test("a runtime with tokenRequired: false never gets a token-missing notice", () => {
	const result = resolveClickTarget({ target: "MyChat" }, { runtimes, defaultTarget: "terminal" }, fakeSecretStore({}));
	assert.equal(result.kind, "runtime");
	assert.deepEqual(result.notices, []);
});

test("E1 + E6 + G11 can all surface together for one click", () => {
	const result = resolveClickTarget(
		{ target: "does-not-exist", model: "sonnet" },
		{ runtimes, defaultTarget: "openclaw" },
		fakeSecretStore({})
	);
	assert.equal(result.kind, "runtime");
	assert.equal(result.notices.length, 3);
	assert.match(result.notices[0], /Unknown target/);
	assert.match(result.notices[1], /Ignored for runtime target/);
	assert.match(result.notices[2], /Token not set on this device/);
});
