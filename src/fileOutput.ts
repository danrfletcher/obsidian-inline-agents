import { App, TFile } from "obsidian";
import type { MarkdownSectionInformation } from "obsidian";

export type AppendPosition = "top" | "bottom" | "belowButton";

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function formatBlock(buttonText: string, content: string): string {
	const stamp = new Date().toLocaleString();
	return `**Agent output** (${buttonText}, ${stamp})\n\n${content}\n`;
}

/**
 * Writes captured agent output into the note the button lives in.
 *
 * `sectionInfo` is a snapshot of the button block's line range taken at
 * click time (`ctx.getSectionInfo`) — by the time the agent run finishes
 * and this actually runs, the note may have been edited and those line
 * numbers may no longer point at the block. `belowButton` sanity-checks
 * the anchor (the line it expects to be the block's closing fence) before
 * trusting it, and falls back to appending at the bottom rather than
 * risking inserting content into the middle of an unrelated paragraph.
 */
export async function writeAgentOutputToFile(
	app: App,
	path: string,
	buttonText: string,
	content: string,
	position: AppendPosition,
	sectionInfo: MarkdownSectionInformation | null
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		throw new Error(`Could not find "${path}" to write agent output into.`);
	}
	const block = formatBlock(buttonText, content);

	await app.vault.process(file, (data) => {
		if (position === "top") {
			const fmMatch = data.match(FRONTMATTER_RE);
			if (fmMatch) {
				const fm = fmMatch[0];
				const rest = data.slice(fm.length);
				return fm + block + "\n" + rest;
			}
			return block + "\n" + data;
		}

		if (position === "belowButton" && sectionInfo) {
			const lines = data.split("\n");
			const fenceLine = lines[sectionInfo.lineEnd];
			if (fenceLine !== undefined && fenceLine.trim().startsWith("```")) {
				const insertAt = sectionInfo.lineEnd + 1;
				const before = lines.slice(0, insertAt).join("\n");
				const after = lines.slice(insertAt).join("\n");
				return before + "\n\n" + block + (after.trim() ? "\n" + after : "");
			}
			// The note changed shape since click time — fall through to bottom
			// rather than guess.
		}

		return data.replace(/\s+$/, "") + "\n\n" + block;
	});
}
