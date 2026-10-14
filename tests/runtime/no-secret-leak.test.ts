import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandoffRunner } from "../../src/runtime/handoff";
import type { HandoffHooks, HandoffInput } from "../../src/runtime/handoff";
import { buildHookRequest } from "../../src/runtime/hookRequest";
import { buildChatRequest } from "../../src/runtime/chatRequest";
import type { AgentRuntime, HttpFn, HttpOutcome, HttpRequest } from "../../src/runtime/types";

const SECRET = "tok-SECRET-123";
const BEARER = `Bearer ${SECRET}`;

function hookRuntime(): AgentRuntime {
	return {
		id: "openclaw-id",
		name: "openclaw",
		kind: "openclaw-hook",
		baseUrl: "http://127.0.0.1:18789",
		agentId: "main",
		tokenRequired: true,
		tokenSecretName: "openclaw-secret",
		sendSessionKeyHeader: false,
		threadUrlTemplate: "hermes://thread/{sessionKeyPath}",
	};
}

function chatRuntime(): AgentRuntime {
	return {
		id: "hermes-id",
		name: "hermes",
		kind: "openai-chat",
		baseUrl: "https://api.example.com",
		agentId: "gpt-4o",
		tokenRequired: true,
		tokenSecretName: "hermes-secret",
		sendSessionKeyHeader: true,
		threadUrlTemplate: "hermes://thread/{sessionKeyPath}",
	};
}

function baseInput(runtime: AgentRuntime): HandoffInput {
	return {
		runtime,
		prompt: "Run the weekly review.",
		notePath: "/vault/weekly.md",
		noteBasename: "weekly",
		openRequested: true,
		token: SECRET,
	};
}

/** Every string this run could show the user — notices, thread URLs, opened URLs — for the leak sweep. */
function makeSweepingHooks(httpFn: HttpFn): { hooks: HandoffHooks; surface: string[] } {
	const surface: string[] = [];
	const hooks: HandoffHooks = {
		httpFn,
		nowMs: () => 1000,
		openUrl: (url) => surface.push(url),
		notify: (message) => surface.push(message),
		onSending: () => {},
		onSent: (threadUrl) => {
			if (threadUrl) surface.push(threadUrl);
		},
		fallbackToTerminal: () => {},
	};
	return { hooks, surface };
}

function fixtures(): HttpOutcome[] {
	return [
		{ kind: "response", status: 200, body: JSON.stringify({ ok: true, runId: "r1" }) }, // success
		{ kind: "response", status: 401 }, // E3
		{ kind: "response", status: 403 }, // E3
		{ kind: "response", status: 400, body: JSON.stringify({ error: "allowRequestSessionKey disabled" }) }, // E12
		{ kind: "response", status: 400, body: `oops ${BEARER} leaked in a library error` }, // malformed/misbehaving upstream
		{ kind: "response", status: 503 }, // E4
		{ kind: "response", status: 200, body: "not json" }, // malformed response
		{ kind: "timeout" }, // E2
		{ kind: "refused" }, // E2
		{ kind: "error", reason: `request failed with ${BEARER}` }, // a transport error that tried to misuse the token
	];
}

test("F5: no notice, thread URL, opened URL or button-facing string ever contains the token, across every outcome, both runtime kinds", async () => {
	for (const runtimeFactory of [hookRuntime, chatRuntime]) {
		for (const outcome of fixtures()) {
			const runner = createHandoffRunner();
			const captured: HttpRequest[] = [];
			const httpFn: HttpFn = async (request) => {
				captured.push(request);
				return outcome;
			};
			const { hooks, surface } = makeSweepingHooks(httpFn);
			await runner.runHandoff(baseInput(runtimeFactory()), hooks);

			for (const s of surface) {
				assert.ok(!s.includes(SECRET), `leaked raw token in surface string: ${s}`);
				assert.ok(!s.includes(BEARER), `leaked Bearer token in surface string: ${s}`);
			}
			// And the token must only ever appear in the Authorization header.
			for (const request of captured) {
				for (const [name, value] of Object.entries(request.headers)) {
					if (name.toLowerCase() === "authorization") continue;
					assert.ok(!value.includes(SECRET), `token leaked into header "${name}"`);
				}
				assert.ok(!request.url.includes(SECRET), "token leaked into request URL");
				if (request.body) {
					const parsedBody = JSON.parse(request.body) as Record<string, unknown>;
					assert.ok(
						!Object.values(parsedBody).some((v) => typeof v === "string" && v.includes(SECRET)),
						"token leaked into request body"
					);
				}
			}
		}
	}
});

test("F5: the token travels only in the Authorization header, never in the body or x-openclaw-session-key", () => {
	const hookRequest = buildHookRequest({
		baseUrl: "http://x",
		token: SECRET,
		agentId: "main",
		name: "n",
		sessionKey: "inline:n:1",
		message: "m",
	});
	assert.equal(hookRequest.headers.Authorization, BEARER);
	assert.ok(!(hookRequest.body ?? "").includes(SECRET));

	const chatRequest = buildChatRequest({
		baseUrl: "http://x",
		token: SECRET,
		model: "m",
		message: "m",
		sessionKey: "inline:n:1",
		sendSessionKeyHeader: true,
	});
	assert.equal(chatRequest.headers.Authorization, BEARER);
	assert.ok(!(chatRequest.body ?? "").includes(SECRET));
	assert.notEqual(chatRequest.headers["x-openclaw-session-key"], SECRET);
});

test("F5: an outcome whose body tries to smuggle the token back in never reaches a notice (hook kind reduces to status/ok/runId only)", async () => {
	const runner = createHandoffRunner();
	const { hooks, surface } = makeSweepingHooks(async () => ({
		kind: "response",
		status: 400,
		body: JSON.stringify({ error: `token leaked: ${BEARER}` }),
	}));
	await runner.runHandoff(baseInput(hookRuntime()), hooks);
	for (const s of surface) {
		assert.ok(!s.includes(SECRET));
	}
});
