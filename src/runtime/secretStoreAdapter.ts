import type { App } from "obsidian";
import type { SecretStore } from "./types";

/** Wraps Obsidian's real, per-device secret storage (G4) behind the SecretStore seam so click-time checks stay testable (see targetResolve.ts). */
export function createSecretStoreAdapter(app: App): SecretStore {
	return {
		hasToken(runtimeId: string): boolean {
			const value = app.secretStorage.getSecret(runtimeId);
			return typeof value === "string" && value.trim() !== "";
		},
	};
}
