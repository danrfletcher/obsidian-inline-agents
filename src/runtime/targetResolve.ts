import type { AgentRuntime, SecretStore } from "./types";

/** The subset of a button's parsed fields the resolver and the ignored-fields notice (G11) need. */
export interface ClickSpecFields {
	target?: string;
	model?: string;
	autoApprove?: boolean;
	agentOutput?: string;
	completion?: string;
	showTerminal?: boolean;
}

export interface ClickSettingsFields {
	runtimes: AgentRuntime[];
	defaultTarget: string;
}

export type TargetResolution =
	| { kind: "terminal"; notices: string[] }
	| { kind: "runtime"; runtime: AgentRuntime; notices: string[] };

function findRuntimeByName(runtimes: AgentRuntime[], name: string): AgentRuntime | undefined {
	const needle = name.trim().toLowerCase();
	return runtimes.find((r) => r.name.trim().toLowerCase() === needle);
}

/** Resolves `defaultTarget` itself to a target — used both for "no target: line" and as the unknown-target fallback (E1). */
function resolveByConfiguredName(name: string, runtimes: AgentRuntime[], notices: string[]): TargetResolution {
	if (name.trim().toLowerCase() === "terminal") return { kind: "terminal", notices };
	const match = findRuntimeByName(runtimes, name);
	// Settings keep defaultTarget valid (see settingsMigrate.ts and the
	// settings tab's remove handler), but fail safe to terminal rather than
	// silently drop the click if it's ever out of sync.
	return match ? { kind: "runtime", runtime: match, notices } : { kind: "terminal", notices };
}

/**
 * G5: `target: terminal` or `target: <runtime name>` (case-insensitive
 * match, name case preserved on the runtime side). No `target:` line uses
 * the configured default target silently. An unknown name shows a notice,
 * then falls back to the default target (E1) — `target: terminal` itself is
 * never redirected by the default-target setting (F8: it always behaves
 * exactly as before).
 */
export function resolveTargetName(
	targetRaw: string | undefined,
	runtimes: AgentRuntime[],
	defaultTarget: string
): TargetResolution {
	const requested = (targetRaw ?? "").trim();
	if (requested === "") return resolveByConfiguredName(defaultTarget, runtimes, []);
	if (requested.toLowerCase() === "terminal") return { kind: "terminal", notices: [] };

	const match = findRuntimeByName(runtimes, requested);
	if (match) return { kind: "runtime", runtime: match, notices: [] };

	return resolveByConfiguredName(defaultTarget, runtimes, [
		`Unknown target "${requested}" — running the default target instead.`,
	]);
}

const IGNORED_FIELD_NAMES: ReadonlyArray<keyof ClickSpecFields> = [
	"model",
	"autoApprove",
	"agentOutput",
	"completion",
	"showTerminal",
];

/** G11: exactly the terminal-only fields this button actually set, in declaration order. */
export function computeIgnoredFields(spec: ClickSpecFields): string[] {
	return IGNORED_FIELD_NAMES.filter((field) => spec[field] !== undefined);
}

/**
 * The full click-time resolution: target routing (G5/E1) plus, for a
 * runtime target, the ignored-fields notice (G11) and the token-missing
 * check (E6 — read from secret storage at click time, not at settings-save
 * time). `secretStore` is injected so this stays testable under Node (see
 * tests/unit/target-resolve.test.ts) without touching Obsidian's real
 * secretStorage.
 */
export function resolveClickTarget(
	spec: ClickSpecFields,
	settings: ClickSettingsFields,
	secretStore: SecretStore
): TargetResolution {
	const base = resolveTargetName(spec.target, settings.runtimes, settings.defaultTarget);
	if (base.kind === "terminal") return base;

	const notices = [...base.notices];
	const ignored = computeIgnoredFields(spec);
	if (ignored.length > 0) {
		notices.push(`Ignored for runtime target "${base.runtime.name}": ${ignored.join(", ")}.`);
	}
	if (base.runtime.tokenRequired && !secretStore.hasToken(base.runtime.id)) {
		notices.push(`Token not set on this device for "${base.runtime.name}".`);
	}
	return { kind: "runtime", runtime: base.runtime, notices };
}
