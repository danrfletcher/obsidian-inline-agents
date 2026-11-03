// Drives the real AgentConsoleSettingTab (src/settings.ts) against a stand-in
// `obsidian` module (tests/support/obsidian-stub.ts), because the Obsidian
// settings tab cannot be opened in the container (the renderer hangs on it,
// on the base commit too). Covers PR-1 G1 and G4 at the code level: where the
// session-id toggle sits, its default, that "Add runtime" stores false, that a
// flip is saved to data.json, that the hook kind hides it but keeps the value,
// and that a reload from data.json shows it as it was.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { migrateSettings } from "../../src/runtime/settingsMigrate";
import { DEFAULT_SETTINGS } from "../../src/settingsModel";
import type { AgentConsoleSettings } from "../../src/settingsModel";
import type { FakeEl, FakeSetting, FakeToggle } from "../support/obsidian-stub";

const SESSION_KEY_LABEL = "Send session key as x-openclaw-session-key";
const SESSION_ID_LABEL = "Send session id as X-Hermes-Session-Id";
const SESSION_ID_HELP = "Hermes needs API_SERVER_KEY set to accept it.";

// Send the bare "obsidian" import to the stub before settings.ts is loaded.
const stubUrl = pathToFileURL(resolve(import.meta.dirname, "../support/obsidian-stub.ts")).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "obsidian") return { url: stubUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});

type Tab = { display(): void; containerEl: FakeEl };
let TabClass: new (app: unknown, plugin: unknown) => Tab;

before(async () => {
	const mod = await import("../../src/settings");
	TabClass = mod.AgentConsoleSettingTab as unknown as typeof TabClass;
	// settings.ts adds and removes a document click listener on display()/hide().
	(globalThis as unknown as { document: unknown }).document = {
		addEventListener() {},
		removeEventListener() {},
	};
});

/** A plugin whose saveSettings() writes JSON like Obsidian's saveData does. */
function makePlugin(stored: unknown) {
	const plugin = {
		dataJson: stored === null ? null : JSON.stringify(stored),
		settings: migrateSettings(stored),
		saves: 0,
		app: { secretStorage: { getSecret: () => null, setSecret() {} } },
		getVaultBasePath(): string {
			throw new Error("no vault in this test");
		},
		async saveSettings(): Promise<void> {
			plugin.saves++;
			plugin.dataJson = JSON.stringify(plugin.settings);
		},
	};
	return plugin;
}

/** Open the tab the way Obsidian does: construct it, call display(). */
function openTab(plugin: ReturnType<typeof makePlugin>): Tab {
	const tab = new TabClass(plugin.app, plugin);
	tab.display();
	return tab;
}

function findSetting(root: FakeEl, match: (s: FakeSetting) => boolean): FakeSetting | undefined {
	const hit = root.settings.find(match);
	if (hit) return hit;
	for (const child of root.children) {
		const nested = findSetting(child, match);
		if (nested) return nested;
	}
	return undefined;
}

/** The Setting rows of the first runtime card, in screen order. */
function cardRows(tab: Tab): FakeSetting[] {
	const nameRow = findSetting(tab.containerEl, (s) => s.name === "Name");
	assert.ok(nameRow, "a runtime card is rendered");
	return nameRow.containerEl.settings;
}

function sessionIdToggle(tab: Tab): FakeToggle | undefined {
	return cardRows(tab).find((s) => s.name === SESSION_ID_LABEL)?.toggles[0];
}

async function addRuntime(tab: Tab): Promise<void> {
	const add = findSetting(tab.containerEl, (s) => s.buttons.some((b) => b.label === "Add runtime"));
	assert.ok(add, "Add runtime button exists");
	await add.buttons[0].onClickCb?.();
	// The click handler is `void (async () => {...})()`; let it finish.
	await new Promise((r) => setImmediate(r));
}

async function setKind(tab: Tab, kind: "openclaw-hook" | "openai-chat"): Promise<void> {
	const row = cardRows(tab).find((s) => s.name === "Kind");
	assert.ok(row);
	await row.dropdowns[0].select(kind);
}

function storedRuntime(plugin: ReturnType<typeof makePlugin>) {
	assert.ok(plugin.dataJson);
	return (JSON.parse(plugin.dataJson) as AgentConsoleSettings).runtimes[0];
}

test("G1: a chat runtime card shows the session-id toggle directly under the session-key toggle, off, with the helper text", async () => {
	const plugin = makePlugin(null);
	const tab = openTab(plugin);
	await addRuntime(tab);
	await setKind(tab, "openai-chat");

	const names = cardRows(tab).map((s) => s.name);
	const keyAt = names.indexOf(SESSION_KEY_LABEL);
	assert.notEqual(keyAt, -1);
	assert.equal(names[keyAt + 1], SESSION_ID_LABEL, "directly under the session-key toggle");

	const row = cardRows(tab)[keyAt + 1];
	assert.equal(row.desc, SESSION_ID_HELP);
	assert.equal(row.toggles.length, 1);
	assert.equal(row.toggles[0].value, false);
});

test("G1: Add runtime stores sendSessionIdHeader: false in data.json", async () => {
	const plugin = makePlugin(null);
	const tab = openTab(plugin);
	await addRuntime(tab);

	assert.equal(plugin.saves, 1);
	const runtime = storedRuntime(plugin);
	assert.equal(Object.prototype.hasOwnProperty.call(runtime, "sendSessionIdHeader"), true);
	assert.equal(runtime.sendSessionIdHeader, false);
});

test("G1: flipping the toggle persists true to data.json; a reload shows it still on", async () => {
	const plugin = makePlugin(null);
	const tab = openTab(plugin);
	await addRuntime(tab);
	await setKind(tab, "openai-chat");

	const savesBefore = plugin.saves;
	const toggle = sessionIdToggle(tab);
	assert.ok(toggle);
	await toggle.click(true);
	assert.equal(plugin.saves, savesBefore + 1);
	assert.equal(storedRuntime(plugin).sendSessionIdHeader, true);

	// Close and reopen: a fresh plugin loaded from the saved data.json, a fresh tab.
	const reopened = makePlugin(JSON.parse(plugin.dataJson as string));
	assert.equal(sessionIdToggle(openTab(reopened))?.value, true);
});

test("G4: chat -> hook hides the toggle but keeps the stored value; back to chat shows it as it was", async () => {
	const plugin = makePlugin(null);
	const tab = openTab(plugin);
	await addRuntime(tab);
	await setKind(tab, "openai-chat");
	await sessionIdToggle(tab)?.click(true);

	await setKind(tab, "openclaw-hook");
	assert.equal(storedRuntime(plugin).kind, "openclaw-hook");
	assert.equal(sessionIdToggle(tab), undefined, "no toggle for the hook kind");
	assert.equal(
		cardRows(tab).some((s) => s.name === SESSION_KEY_LABEL),
		false
	);
	assert.equal(storedRuntime(plugin).sendSessionIdHeader, true, "value kept in data.json");

	await setKind(tab, "openai-chat");
	assert.equal(sessionIdToggle(tab)?.value, true, "toggle returns in its previous state");
});

test("E9: a runtime saved before the field existed shows the toggle off and the render does not write the field", () => {
	const legacy = {
		...DEFAULT_SETTINGS,
		runtimes: [
			{
				id: "r1",
				name: "hermes",
				kind: "openai-chat",
				baseUrl: "http://127.0.0.1:8642/v1",
				agentId: "",
				tokenRequired: true,
				sendSessionKeyHeader: false,
			},
		],
	};
	const plugin = makePlugin(legacy);
	const tab = openTab(plugin);

	assert.equal(sessionIdToggle(tab)?.value, false);
	assert.equal(plugin.saves, 0);
	assert.equal(plugin.settings.runtimes[0].sendSessionIdHeader, undefined);
});
