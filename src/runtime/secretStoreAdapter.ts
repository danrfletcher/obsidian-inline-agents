import type { App } from "obsidian";
import type { SecretStore } from "./types";

/** Wraps Obsidian's real, per-device secret storage (G4) behind the SecretStore seam so click-time checks stay testable (see targetResolve.ts). */
export function createSecretStoreAdapter(app: App): SecretStore {
	return {
		hasToken(tokenSecretName: string | undefined): boolean {
			if (!tokenSecretName) return false;
			const value = app.secretStorage.getSecret(tokenSecretName);
			return typeof value === "string" && value.trim() !== "";
		},
	};
}
