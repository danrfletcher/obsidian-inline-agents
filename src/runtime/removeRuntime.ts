import type { AgentRuntime } from "./types";

/** The settings fields `removeRuntime` reads and mutates. */
export interface RemovableSettings {
	runtimes: AgentRuntime[];
	defaultTarget: string;
}

/** Abstracts `app.secretStorage.setSecret` so this stays testable without Obsidian. */
export interface SecretClearer {
	clearSecret(name: string): void;
}

/**
 * Removing a runtime resets `defaultTarget` to Terminal if it pointed at the
 * removed one, and clears the runtime's token from secret storage —
 * SecretStorage exposes no delete call (only setSecret/getSecret/listSecrets),
 * so overwriting with an empty value is the closest available op. Skipped
 * when another runtime still in the list shares the same `tokenSecretName`
 * (the store is shared across plugins and runtimes by name, so clearing it
 * out from under a still-referencing runtime would break that one).
 */
export function removeRuntime(settings: RemovableSettings, index: number, clearer: SecretClearer): void {
	const runtime = settings.runtimes[index];
	if (!runtime) return;

	const removedName = runtime.name.trim().toLowerCase();
	const secretName = runtime.tokenSecretName;
	settings.runtimes.splice(index, 1);

	if (settings.defaultTarget.trim().toLowerCase() === removedName) {
		settings.defaultTarget = "terminal";
	}

	if (secretName && !settings.runtimes.some((r) => r.tokenSecretName === secretName)) {
		clearer.clearSecret(secretName);
	}
}
