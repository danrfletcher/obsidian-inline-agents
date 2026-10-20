/**
 * Holds OpenCode's fetched model list for the settings tab and decides when
 * to fetch it. Kept free of Obsidian/DOM imports so the decision logic is
 * unit-testable.
 *
 * Why this exists: the settings tab used to fetch whenever it rendered with
 * an empty list, and re-rendered whenever a fetch finished. If the fetch
 * legitimately yields [] (OpenCode not installed, no providers configured,
 * timeout) that was an endless render → fetch → render loop, which spawned a
 * process per iteration and pinned the Obsidian renderer (T1). So:
 *
 *  - `ensureLoaded` (called on every render) fetches at most once per tab
 *    open, whatever the result;
 *  - `refresh` (the user's re-check button) always fetches;
 *  - `onUpdate` fires only when the list actually changed, so an unchanged
 *    or still-empty result never triggers another render.
 */
export class OpenCodeModelLoader {
	models: string[] = [];
	private loading = false;
	private attempted = false;

	constructor(private readonly fetchModels: () => Promise<string[]>) {}

	get isLoading(): boolean {
		return this.loading;
	}

	/** Fetch once per tab open; later calls are no-ops until `reset`. */
	ensureLoaded(onUpdate: () => void): Promise<void> {
		if (this.attempted || this.loading) return Promise.resolve();
		return this.refresh(onUpdate);
	}

	/** Fetch now (unless one is already in flight). */
	async refresh(onUpdate: () => void): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.attempted = true;
		let next: string[] = [];
		try {
			next = await this.fetchModels();
		} catch {
			next = [];
		} finally {
			this.loading = false;
		}
		const changed = next.length !== this.models.length || next.some((m, i) => m !== this.models[i]);
		this.models = next;
		if (changed) onUpdate();
	}

	/** Forget that a fetch happened, so the next render fetches again. */
	reset(): void {
		this.attempted = false;
	}
}
