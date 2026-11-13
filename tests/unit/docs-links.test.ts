import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const docsRoot = resolve(import.meta.dirname, "../../docs/docs");

function markdownFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...markdownFiles(full));
		else if (entry.name.endsWith(".md")) out.push(full);
	}
	return out;
}

const files = markdownFiles(docsRoot);

test("G11: the docs tree is actually found and read", () => {
	assert.ok(files.length > 5, `expected the docs pages, found ${files.length}`);
	assert.ok(files.some((f) => f.endsWith(join("agents", "runtimes.md"))));
});

test("G11: no docs page links to the retired Hermes anchor or says there is no thread link yet", () => {
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		const name = relative(docsRoot, file);
		assert.ok(!text.includes("hermes-has-no-thread-link-yet"), `${name} links to the retired anchor`);
		assert.ok(!/no thread link yet/i.test(text), `${name} still says "no thread link yet"`);
	}
});

test("G11: runtimes.md lists {sessionId} in its placeholder table", () => {
	const text = readFileSync(join(docsRoot, "agents", "runtimes.md"), "utf8");
	const rows = text.split("\n").filter((line) => line.startsWith("|") && line.includes("`{sessionId}`"));
	assert.ok(
		rows.some((row) => /^\|\s*`\{sessionId\}`\s*\|/.test(row)),
		"no placeholder-table row starting with `{sessionId}`"
	);
});

const slug = (heading: string): string =>
	heading
		.toLowerCase()
		.replace(/`/g, "")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-");

function headingAnchors(text: string): Set<string> {
	return new Set(
		text
			.split("\n")
			.filter((line) => /^#{1,6}\s/.test(line))
			.map((line) => slug(line.replace(/^#+\s+/, "")))
	);
}

test("G11: every in-page anchor link in runtimes.md points at a real heading", () => {
	const text = readFileSync(join(docsRoot, "agents", "runtimes.md"), "utf8");
	const anchors = headingAnchors(text);
	const links = [...text.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
	assert.ok(links.length > 0);
	for (const link of links) assert.ok(anchors.has(link), `runtimes.md links to #${link}, which is not a heading`);
});

test("G11: every cross-page link with an anchor, in any docs page, points at a real heading in the target page", () => {
	let checked = 0;
	for (const file of files) {
		const name = relative(docsRoot, file);
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(/\]\(([^)#\s]+\.md)#([^)\s]+)\)/g)) {
			const [, target, anchor] = match;
			const targetFile = resolve(dirname(file), target);
			assert.ok(files.includes(targetFile), `${name} links to ${target}, which is not a docs page`);
			const anchors = headingAnchors(readFileSync(targetFile, "utf8"));
			assert.ok(anchors.has(anchor), `${name} links to ${target}#${anchor}, which is not a heading there`);
			checked++;
		}
	}
	assert.ok(checked > 0, "expected at least one cross-page anchor link");
});

test("G11: the cross-page anchor check catches a missing heading", () => {
	assert.ok(!headingAnchors("# One\n## Two words\n").has("three"));
	assert.ok(headingAnchors("# One\n## Two `words`\n").has("two-words"));
});
