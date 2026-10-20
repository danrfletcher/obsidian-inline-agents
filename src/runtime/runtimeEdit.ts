import type { AgentRuntime } from "./types";
import { validateBaseUrl, validateRuntimeName } from "./validation";
import type { ValidationResult } from "./validation";

/** The settings fields `renameRuntime` reads and mutates. */
export interface RenameableSettings {
	defaultTarget: string;
}

/**
 * A "new" runtime row in Settings: held in memory as a draft, never written
 * to data.json, until it passes `validateRuntimeCommit`. `tokenRequired`
 * starts on, like every other new runtime (a missing token blocks a click).
 */
export function createBlankRuntime(id: string): AgentRuntime {
	return {
		id,
		name: "",
		kind: "openclaw-hook",
		baseUrl: "",
		agentId: "",
		tokenRequired: true,
		sendSessionKeyHeader: false,
		threadUrlTemplate: "",
	};
}

/**
 * E14: whether a draft may be saved — it needs a valid, unique name and a
 * valid base URL, so a blank or half-filled row can't reach data.json.
 * `runtimes` is the list of already-saved runtimes; the draft isn't in it,
 * so its own index is -1 and every saved runtime counts for the uniqueness
 * check.
 */
export function validateRuntimeCommit(draft: AgentRuntime, runtimes: AgentRuntime[]): ValidationResult {
	const name = validateRuntimeName(draft.name, runtimes, runtimes.indexOf(draft));
	if (!name.ok) return name;
	return validateBaseUrl(draft.baseUrl);
}

/**
 * Renames a runtime (the caller has already validated `newName` with
 * `validateRuntimeName`). If the runtime being renamed is the current
 * Default target (compared the way the resolver does: trimmed,
 * case-insensitive), `defaultTarget` follows the rename — otherwise it would
 * name a runtime that no longer exists, the dropdown would show Terminal, the
 * resolver would silently run the terminal, and the next load's migration
 * would reset it for good.
 */
export function renameRuntime(settings: RenameableSettings, runtime: AgentRuntime, newName: string): void {
	const oldName = runtime.name.trim().toLowerCase();
	const trimmed = newName.trim();
	runtime.name = trimmed;
	if (oldName !== "" && settings.defaultTarget.trim().toLowerCase() === oldName) {
		settings.defaultTarget = trimmed;
	}
}
