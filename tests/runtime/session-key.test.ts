import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitiseBasename, createSessionKey, createSessionId, splitSessionKeyPath } from "../../src/runtime/sessionKey";

test("G8: lowercases the basename", () => {
	assert.equal(sanitiseBasename("Weekly Review"), "weekly-review");
});

test("G8: replaces any character outside a-z, 0-9, -, _ with -", () => {
	assert.equal(sanitiseBasename("weekly review (v2)!"), "weekly-review--v2--");
});

test("G8: a colon in the basename becomes a dash, not left as a colon", () => {
	assert.equal(sanitiseBasename("note:with:colons"), "note-with-colons");
	assert.ok(!sanitiseBasename("note:with:colons").includes(":"));
});

test("G8: unicode characters are replaced, not passed through", () => {
	assert.equal(sanitiseBasename("café résumé"), "caf--r-sum-");
});

test("G8: spaces become dashes", () => {
	assert.equal(sanitiseBasename("a b c"), "a-b-c");
});

test("G8: an empty basename falls back to 'note'", () => {
	assert.equal(sanitiseBasename(""), "note");
});

test("G8: every character sanitises to '-' (itself an allowed character), so a non-empty basename never hits the 'note' fallback", () => {
	// Only a literal empty-string basename can produce an empty result (see
	// above) — every disallowed character maps to "-", not to nothing, so a
	// basename made entirely of disallowed characters still sanitises to a
	// non-empty (if meaningless) key segment.
	assert.equal(sanitiseBasename(":::"), "---");
	assert.equal(sanitiseBasename("!!!"), "---");
});

test("G8: truncates to at most 40 characters", () => {
	const basename = "a".repeat(100);
	const result = sanitiseBasename(basename);
	assert.equal(result.length, 40);
	assert.equal(result, "a".repeat(40));
});

test("G8: already-valid characters pass through unchanged (aside from case)", () => {
	assert.equal(sanitiseBasename("already_valid-name123"), "already_valid-name123");
});

test("G8: createSessionKey builds inline:<sanitised basename>:<epoch ms>", () => {
	assert.equal(createSessionKey("Weekly Review", 1700000000000), "inline:weekly-review:1700000000000");
});

test("G8: the same basename and epoch ms always produce the same key (determinism)", () => {
	assert.equal(createSessionKey("note", 123), createSessionKey("note", 123));
});

test("splitSessionKeyPath splits the session key on ':' into path segments", () => {
	assert.deepEqual(splitSessionKeyPath("inline:weekly-review:1700000000000"), ["inline", "weekly-review", "1700000000000"]);
});

// --- createSessionId (G6, E10) ---------------------------------------

test("GP3: Weekly Review at epoch 1793618103221 gives the worked-example key and id", () => {
	const key = createSessionKey("Weekly Review", 1793618103221);
	assert.equal(key, "inline:weekly-review:1793618103221");
	assert.equal(createSessionId(key), "inline-weekly-review-1793618103221");
});

test("G6: createSessionId replaces every ':' with '-' and nothing else", () => {
	assert.equal(createSessionId("a:b:c"), "a-b-c");
	assert.equal(createSessionId("no-colons_here"), "no-colons_here");
	assert.equal(createSessionId(":::"), "---");
});

test("G6: the same key always gives the same id (determinism)", () => {
	assert.equal(createSessionId("inline:note:1"), createSessionId("inline:note:1"));
});

test("added: two clicks on one note in different milliseconds give different ids", () => {
	assert.notEqual(
		createSessionId(createSessionKey("Weekly Review", 1793618103221)),
		createSessionId(createSessionKey("Weekly Review", 1793618103222))
	);
});

const E10_BASENAMES: [string, string][] = [
	["plain", "Weekly Review"],
	["unicode", "café résumé 日本語 🎉"],
	["spaces", "  a  b  "],
	["colon in the name", "note:with:colons"],
	["only colons", ":::"],
	["40-char truncation boundary", "a".repeat(40)],
	["over-long, truncated to 40", "Very Long Name ".repeat(20)],
	["empty, falls back to note", ""],
	["punctuation", "weekly review (v2)!/\\?*"],
	["upper case and underscores", "MY_NOTE-Final"],
];

for (const [label, basename] of E10_BASENAMES) {
	test(`E10: id for basename (${label}) matches ^[a-z0-9_-]+$, has no ':' and is under 256 chars`, () => {
		const key = createSessionKey(basename, 1793618103221);
		const id = createSessionId(key);
		assert.match(id, /^[a-z0-9_-]+$/);
		assert.ok(!id.includes(":"));
		assert.ok(id.length < 256);
		// Same shape as the key, just with the separators swapped.
		assert.equal(id.length, key.length);
		assert.equal(id, key.split(":").join("-"));
	});
}

test("E10: an empty basename falls back to 'note' in the id", () => {
	assert.equal(createSessionId(createSessionKey("", 5)), "inline-note-5");
});
