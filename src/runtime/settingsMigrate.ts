import { AgentConsoleSettings, DEFAULT_SETTINGS } from "../settingsModel";

/**
 * Pure merge of whatever `loadData()` returned (anything from 0.2.1 onward,
 * including `null` on a brand-new vault) onto DEFAULT_SETTINGS — E13.
 *
 * A plain `{ ...DEFAULT_SETTINGS, ...saved }` would be a *shallow* merge: a
 * data.json saved before `runtimes` existed simply lacks the key, which
 * spreads in fine, but a `claude`/`opencode` object with only `binaryPath`
 * (pre-model-mappings) would wholesale replace DEFAULT_SETTINGS.claude —
 * dropping its `models` default. Each nested object is merged explicitly
 * instead.
 */
export function migrateSettings(saved: Partial<AgentConsoleSettings> | null | undefined): AgentConsoleSettings {
	const merged: AgentConsoleSettings = {
		...DEFAULT_SETTINGS,
		...saved,
		claude: { ...DEFAULT_SETTINGS.claude, ...saved?.claude },
		opencode: { ...DEFAULT_SETTINGS.opencode, ...saved?.opencode },
		runtimes: saved?.runtimes ? saved.runtimes.map((runtime) => ({ ...runtime })) : [],
	};

	// An empty mappings list (rather than a missing one) is also possible —
	// e.g. after removing every row in Settings. Always keep at least one
	// placeholder row so the "+" button has something to render next to.
	if (merged.claude.models.length === 0) merged.claude.models = [{ name: "", model: "" }];
	if (merged.opencode.models.length === 0) merged.opencode.models = [{ name: "", model: "" }];

	// Defensive, not just reactive: this keeps `defaultTarget` valid even if
	// data.json was hand-edited, or synced from a device where the runtime
	// still existed. The settings tab also resets this at the moment a
	// runtime is removed (see settings.ts) — this is the load-time backstop.
	if (
		merged.defaultTarget.trim().toLowerCase() !== "terminal" &&
		!merged.runtimes.some((r) => r.name.trim().toLowerCase() === merged.defaultTarget.trim().toLowerCase())
	) {
		merged.defaultTarget = "terminal";
	}

	return merged;
}
