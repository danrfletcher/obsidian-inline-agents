import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeModelLoader } from "../../src/openCodeModelLoader";

/**
 * Simulates the settings tab: every "render" calls ensureLoaded, and a
 * changed model list triggers another render — the loop that pinned the
 * renderer when OpenCode returned no models (T1).
 */
function simulateTab(loader: OpenCodeModelLoader, maxRenders: number): { renders: number } {
	const state = { renders: 0 };
	const render = (): void => {
		state.renders++;
		if (state.renders > maxRenders) throw new Error("render loop");
		void loader.ensureLoaded(render);
	};
	render();
	return state;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("an empty result does not re-render or re-fetch (no render loop)", async () => {
	let fetches = 0;
	const loader = new OpenCodeModelLoader(async () => {
		fetches++;
		return [];
	});
	const state = simulateTab(loader, 50);
	await tick();
	await tick();
	assert.equal(fetches, 1);
	assert.equal(state.renders, 1);
});

test("a thrown fetch is treated as empty and does not loop", async () => {
	let fetches = 0;
	const loader = new OpenCodeModelLoader(async () => {
		fetches++;
		throw new Error("boom");
	});
	const state = simulateTab(loader, 50);
	await tick();
	assert.equal(fetches, 1);
	assert.equal(state.renders, 1);
	assert.equal(loader.isLoading, false);
});

test("a non-empty result re-renders once and is then stable", async () => {
	let fetches = 0;
	const loader = new OpenCodeModelLoader(async () => {
		fetches++;
		return ["a/b", "c/d"];
	});
	const state = simulateTab(loader, 50);
	await tick();
	await tick();
	assert.equal(fetches, 1);
	assert.equal(state.renders, 2);
	assert.deepEqual(loader.models, ["a/b", "c/d"]);
});

test("refresh always fetches again; reset lets ensureLoaded fetch once more", async () => {
	let fetches = 0;
	const loader = new OpenCodeModelLoader(async () => {
		fetches++;
		return [];
	});
	let updates = 0;
	await loader.ensureLoaded(() => updates++);
	await loader.ensureLoaded(() => updates++);
	assert.equal(fetches, 1);
	await loader.refresh(() => updates++);
	assert.equal(fetches, 2);
	loader.reset();
	await loader.ensureLoaded(() => updates++);
	assert.equal(fetches, 3);
	assert.equal(updates, 0);
});

test("concurrent calls share one in-flight fetch", async () => {
	let fetches = 0;
	const loader = new OpenCodeModelLoader(async () => {
		fetches++;
		await tick();
		return ["x/y"];
	});
	await Promise.all([loader.ensureLoaded(() => {}), loader.refresh(() => {}), loader.ensureLoaded(() => {})]);
	assert.equal(fetches, 1);
});
