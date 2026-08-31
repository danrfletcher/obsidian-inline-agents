import { App, TFile } from "obsidian";

export interface AgentFileContext {
	path: string;
	basename: string;
	name: string;
	folder: string;
	extension: string;
	frontmatter: Record<string, unknown>;
	tags: string[];
	ctime: string;
	mtime: string;
}

export interface AgentVaultContext {
	name: string;
	basePath: string;
}

export interface AgentDateContext {
	today: string;
	now: string;
}

/** What a prompt template (`{{ }}` lookups and `{{= }}` expressions, see
 * templating.ts) can reference. Deliberately a plain data snapshot taken
 * once at click time, not a live handle onto `App` — a button's prompt
 * shouldn't be able to reach arbitrary vault/plugin internals, only the
 * fields explicitly surfaced here. */
export interface AgentContext {
	file: AgentFileContext;
	vault: AgentVaultContext;
	date: AgentDateContext;
}

/** Vault-relative folder of `path` ("" for a root-level file), computed
 * from the string directly rather than requiring a resolved TFile — kept
 * available as a fallback for the (practically never hit) case where
 * `sourcePath` doesn't resolve to a real file in the vault. */
function folderOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

/** Union of frontmatter's own `tags` field (string, comma-separated string,
 * or array — Obsidian accepts all three) and inline `#tag`s the metadata
 * cache has already parsed out of the note body, deduped and without the
 * leading `#`. */
function collectTags(app: App, file: TFile, frontmatter: Record<string, unknown>): string[] {
	const tags = new Set<string>();
	const fmTags = frontmatter.tags;
	if (Array.isArray(fmTags)) {
		fmTags.forEach((t) => tags.add(String(t)));
	} else if (typeof fmTags === "string") {
		fmTags
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean)
			.forEach((t) => tags.add(t));
	}
	const cache = app.metadataCache.getFileCache(file);
	cache?.tags?.forEach((t) => tags.add(t.tag.replace(/^#/, "")));
	return [...tags];
}

/**
 * Snapshots everything a prompt template is allowed to see, as of the
 * moment a button is clicked. `sourcePath` is the code block's own source
 * note (`ctx.sourcePath`), not whichever pane happens to be focused, so
 * this is correct even with split panes viewing different notes.
 */
export function buildAgentContext(app: App, sourcePath: string, vaultBasePath: string): AgentContext {
	const abstractFile = app.vault.getAbstractFileByPath(sourcePath);
	const file = abstractFile instanceof TFile ? abstractFile : null;
	const frontmatter = file ? (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) : {};

	const now = new Date();

	return {
		file: {
			path: sourcePath,
			basename: file?.basename ?? sourcePath.replace(/\.[^/.]+$/, "").split("/").pop() ?? sourcePath,
			name: file?.name ?? sourcePath.split("/").pop() ?? sourcePath,
			folder: file?.parent?.path ?? folderOf(sourcePath),
			extension: file?.extension ?? (sourcePath.split(".").pop() ?? ""),
			// Frontmatter is exposed as-is (not deep-cloned) — templates only
			// ever read from it via lookupPath/JS eval, never mutate it, and
			// it's a fresh object from getFileCache() each call regardless.
			frontmatter,
			tags: file ? collectTags(app, file, frontmatter) : [],
			ctime: file ? new Date(file.stat.ctime).toISOString() : "",
			mtime: file ? new Date(file.stat.mtime).toISOString() : "",
		},
		vault: {
			name: app.vault.getName(),
			basePath: vaultBasePath,
		},
		date: {
			today: now.toISOString().slice(0, 10),
			now: now.toISOString(),
		},
	};
}
