import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitiseBasename, createSessionKey, splitSessionKeyPath } from "../../src/runtime/sessionKey";

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

test("R8: an astral character (emoji) becomes one '-', not two", () => {
	assert.equal(sanitiseBasename("a😀b"), "a-b");
	assert.equal(sanitiseBasename("😀😀"), "--");
});

test("R8: a basename that is empty falls back to 'note' (judgement call, not in the ticket)", () => {
	assert.equal(sanitiseBasename(""), "note");
});
