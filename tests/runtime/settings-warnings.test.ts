import { test } from "node:test";
import assert from "node:assert/strict";
import {
	BOTH_HEADERS_WARNING,
	HOOK_IGNORES_SESSION_ID_WARNING,
	SESSION_ID_TOGGLE_OFF_WARNING,
	runtimeWarnings,
} from "../../src/runtime/settingsWarnings";
import type { RuntimeKind } from "../../src/runtime/types";

// The exact strings the spec fixes (G2, G3), written out here rather than
// imported so a reworded constant can't silently pass.
const TOGGLE_OFF_LINE = "Hermes only uses this id when 'Send session id' is on.";
const HOOK_LINE = "OpenClaw ignores {sessionId}.";
const BOTH_HEADERS_LINE = 'The OpenClaw header sends a key containing ":" to Hermes. Both headers are still sent.';

const TEMPLATES = {
	empty: "",
	blank: "   ",
	noPlaceholder: "https://example.com/threads/static",
	sessionId: "hermes://open/{sessionId}",
	sessionKeyOnly: "hermes://open/{sessionKey}",
	mixedCase: "hermes://open/{SessionId}",
	spaced: "hermes://open/{ sessionId }",
	withOthers: "hermes://open/{agentId}/{sessionKeyPath}/{sessionId}",
} as const;

interface Row {
	kind: RuntimeKind;
	idToggle: boolean | undefined;
	keyToggle: boolean;
	template: keyof typeof TEMPLATES;
	line: string | undefined;
	both: string | undefined;
}

function expectedLine(kind: RuntimeKind, idToggle: boolean | undefined, template: keyof typeof TEMPLATES): string | undefined {
	if (!["sessionId", "withOthers"].includes(template)) return undefined;
	if (kind === "openclaw-hook") return HOOK_LINE;
	return idToggle === true ? undefined : TOGGLE_OFF_LINE;
}

function buildRows(): Row[] {
	const rows: Row[] = [];
	for (const kind of ["openai-chat", "openclaw-hook"] as RuntimeKind[]) {
		for (const idToggle of [true, false, undefined]) {
			for (const keyToggle of [true, false]) {
				for (const template of Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]) {
					rows.push({
						kind,
						idToggle,
						keyToggle,
						template,
						line: expectedLine(kind, idToggle, template),
						both: kind === "openai-chat" && keyToggle && idToggle === true ? BOTH_HEADERS_LINE : undefined,
					});
				}
			}
		}
	}
	return rows;
}

test("the exported constants are the spec's exact strings", () => {
	assert.equal(SESSION_ID_TOGGLE_OFF_WARNING, TOGGLE_OFF_LINE);
	assert.equal(HOOK_IGNORES_SESSION_ID_WARNING, HOOK_LINE);
	assert.match(BOTH_HEADERS_WARNING, /OpenClaw header sends a key containing ":" to Hermes/);
});

test("G2/G3/E3/E12: every kind x session-id toggle x OpenClaw toggle x template gives exactly the expected lines", () => {
	const rows = buildRows();
	assert.equal(rows.length, 2 * 3 * 2 * Object.keys(TEMPLATES).length);
	for (const row of rows) {
		const label = JSON.stringify(row);
		const warnings = runtimeWarnings({
			kind: row.kind,
			sendSessionKeyHeader: row.keyToggle,
			sendSessionIdHeader: row.idToggle,
			threadUrlTemplate: TEMPLATES[row.template],
		});
		assert.equal(warnings.template, row.line, label);
		assert.equal(warnings.bothHeaders, row.both, label);
		// At most one template line plus the both-on line, and nothing else.
		assert.deepEqual(Object.keys(warnings).sort(), [row.both ? "bothHeaders" : "", row.line ? "template" : ""].filter(Boolean).sort(), label);
	}
});

test("G2: chat kind, toggle off, {sessionId} template: exactly the 'Send session id' line", () => {
	assert.equal(
		runtimeWarnings({ kind: "openai-chat", sendSessionKeyHeader: false, sendSessionIdHeader: false, threadUrlTemplate: "hermes://open/{sessionId}" }).template,
		"Hermes only uses this id when 'Send session id' is on."
	);
});

test("G2: hook kind, {sessionId} template: exactly the OpenClaw line, whatever the stored toggle says", () => {
	for (const idToggle of [true, false, undefined]) {
		assert.equal(
			runtimeWarnings({ kind: "openclaw-hook", sendSessionKeyHeader: false, sendSessionIdHeader: idToggle, threadUrlTemplate: "hermes://open/{sessionId}" }).template,
			"OpenClaw ignores {sessionId}."
		);
	}
});

test("G2: chat kind, toggle on: no template warning with or without {sessionId}, and none for an empty template", () => {
	for (const template of ["", "hermes://open/{sessionId}", "hermes://open/{sessionKey}"]) {
		assert.deepEqual(
			runtimeWarnings({ kind: "openai-chat", sendSessionKeyHeader: false, sendSessionIdHeader: true, threadUrlTemplate: template }),
			{}
		);
	}
});

test("G3/E12: the both-on line is independent of the template and clears when either toggle goes off", () => {
	for (const template of [undefined, "", "hermes://open/{sessionId}"]) {
		const both = runtimeWarnings({ kind: "openai-chat", sendSessionKeyHeader: true, sendSessionIdHeader: true, threadUrlTemplate: template });
		assert.equal(both.bothHeaders, BOTH_HEADERS_LINE);
		assert.equal(both.template, undefined);
		assert.equal(
			runtimeWarnings({ kind: "openai-chat", sendSessionKeyHeader: false, sendSessionIdHeader: true, threadUrlTemplate: template }).bothHeaders,
			undefined
		);
		assert.equal(
			runtimeWarnings({ kind: "openai-chat", sendSessionKeyHeader: true, sendSessionIdHeader: false, threadUrlTemplate: template }).bothHeaders,
			undefined
		);
	}
});

test("added: the both-on line is for the chat kind only; a hook runtime with both stored toggles on gets none", () => {
	assert.deepEqual(runtimeWarnings({ kind: "openclaw-hook", sendSessionKeyHeader: true, sendSessionIdHeader: true, threadUrlTemplate: "" }), {});
});

test("added: a runtime saved before the toggle existed (field absent) is treated as off and gets no both-on line", () => {
	const chat = { kind: "openai-chat" as const, sendSessionKeyHeader: true };
	assert.deepEqual(runtimeWarnings({ ...chat, threadUrlTemplate: "" }), {});
	assert.deepEqual(runtimeWarnings({ ...chat, threadUrlTemplate: "https://example.com/{sessionKey}" }), {});
});

test("added: switching chat to hook with the same stored toggle moves the warning with the kind", () => {
	const stored = { sendSessionKeyHeader: false, sendSessionIdHeader: true as boolean | undefined };
	const withPlaceholder = "hermes://open/{sessionId}";
	assert.deepEqual(runtimeWarnings({ kind: "openai-chat", ...stored, threadUrlTemplate: withPlaceholder }), {});
	assert.deepEqual(runtimeWarnings({ kind: "openclaw-hook", ...stored, threadUrlTemplate: withPlaceholder }), { template: HOOK_LINE });
	assert.deepEqual(runtimeWarnings({ kind: "openclaw-hook", ...stored, threadUrlTemplate: "https://example.com/{sessionKey}" }), {});
});

test("added: an invalid template (disallowed scheme, no scheme) gets no warning, so it never hides the validation error", () => {
	for (const kind of ["openai-chat", "openclaw-hook"] as RuntimeKind[]) {
		for (const template of ["javascript:alert({sessionId})", "file:///tmp/{sessionId}", "data:text/html,{sessionId}", "open/{sessionId}"]) {
			assert.equal(runtimeWarnings({ kind, sendSessionKeyHeader: false, sendSessionIdHeader: false, threadUrlTemplate: template }).template, undefined, `${kind} ${template}`);
		}
	}
});

test("added: the placeholder is matched exactly as buildThreadUrl fills it: other casing or inner spaces are not {sessionId}", () => {
	for (const template of [TEMPLATES.mixedCase, TEMPLATES.spaced]) {
		assert.deepEqual(runtimeWarnings({ kind: "openclaw-hook", sendSessionKeyHeader: false, threadUrlTemplate: template }), {});
	}
});
