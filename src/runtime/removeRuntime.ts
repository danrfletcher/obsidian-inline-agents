import type { AgentRuntime } from "./types";

/** The settings fields `removeRuntime` reads and mutates. */
export interface RemovableSettings {
	runtimes: AgentRuntime[];
	defaultTarget: string;
}

/**
 * Removing a runtime drops it from the list and resets `defaultTarget` to
 * Terminal if it pointed at the removed one. It deliberately does NOT touch
 * the runtime's token secret: the Token field picks (or creates) a named
 * secret in Obsidian's vault-wide SecretStorage, which is shared with other
 * plugins and with runtimes on other synced devices, and this plugin can't
 * tell a secret it created from one the user picked. SecretStorage also has
 * no delete call (only setSecret/getSecret/listSecrets), so the only way to
 * "clear" would be to overwrite the value with '' — silently blanking a
 * secret someone else may rely on. The secret stays in storage; the user can
 * remove it from Obsidian's own secret manager.
 */
export function removeRuntime(settings: RemovableSettings, index: number): void {
	const runtime = settings.runtimes[index];
	if (!runtime) return;

	const removedName = runtime.name.trim().toLowerCase();
	settings.runtimes.splice(index, 1);

	if (settings.defaultTarget.trim().toLowerCase() === removedName) {
		settings.defaultTarget = "terminal";
	}
}
