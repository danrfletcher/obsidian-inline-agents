import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentCommand } from "../../src/agents";
import type { AgentKind } from "../../src/agents";
import { composePrompt } from "../../src/inputPrompt";
import { renderPromptTemplate } from "../../src/templating";
import type { AgentContext } from "../../src/context";

// The real renderer, with a small real context — the PR-1 composer and
// templating are not mocked, only the agent binary is never run.
const context: AgentContext = {
	file: {
		path: "Notes/Roadmap.md",
		basename: "Roadmap",
		name: "Roadmap.md",
		folder: "Notes",
		extension: "md",
		frontmatter: {},
		tags: [],
		ctime: "",
		mtime: "",
	},
	vault: { name: "v", basePath: "/v" },
	date: { today: "2026-11-03", now: "2026-11-03T00:00:00.000Z" },
};

function compose(template: string, typed: string): string {
	const composed = composePrompt(template, typed, (segment) => renderPromptTemplate(segment, context, { allowJs: false }));
	assert.equal(composed.error, undefined);
	return composed.text;
}

const agents: AgentKind[] = ["claude", "opencode"];

function lastArg(agent: AgentKind, prompt: string): string {
	const built = buildAgentCommand(agent, "/bin/stub", { prompt, cwd: "/vault", autoApprove: true, model: "m" });
	return built.args[built.args.length - 1];
}

for (const agent of agents) {
	test(`GP4/G7 (${agent}): the golden-path prompt is the last argument, unchanged`, () => {
		const prompt = compose("Merge this ticket into {{ input }} and archive it", "Obsidian Atlas dark mode");
		assert.equal(prompt, "Merge this ticket into Obsidian Atlas dark mode and archive it");
		assert.equal(lastArg(agent, prompt), "Merge this ticket into Obsidian Atlas dark mode and archive it");
	});

	test(`E2 (${agent}): multi-line typed text reaches the argument unchanged`, () => {
		const typed = "line one\n\nline three  with  spaces\n\tindented";
		const prompt = compose("Do this:", typed);
		assert.equal(prompt, `Do this:\n${typed}`);
		assert.equal(lastArg(agent, prompt), prompt);
	});

	test(`E2 (${agent}): a 10,000-character text reaches the argument unchanged`, () => {
		const typed = "x".repeat(4000) + "\n" + "é中".repeat(3000);
		assert.ok(typed.length >= 10000);
		const prompt = compose("Ticket: {{ input }}!", typed);
		assert.equal(prompt, `Ticket: ${typed}!`);
		assert.equal(lastArg(agent, prompt), prompt);
	});

	test(`E10/E1 (${agent}): $&, $1, {{ file.path }} and non-Latin text are passed as typed`, () => {
		const typed = "$& $1 $' {{ file.path }} {{= 1+1 }} {{ input }} 合并 票据";
		const prompt = compose("Merge into {{ input }} from {{ file.path }}", typed);
		assert.equal(prompt, `Merge into ${typed} from Notes/Roadmap.md`);
		assert.equal(lastArg(agent, prompt), prompt);
	});
}
