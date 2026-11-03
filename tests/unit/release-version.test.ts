import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

function readJson(file: string): Record<string, string> {
	return JSON.parse(readFileSync(resolve(root, file), "utf8")) as Record<string, string>;
}

const RELEASE = "0.3.2";

test("G12: manifest.json and package.json both carry the release version", () => {
	assert.equal(readJson("manifest.json").version, RELEASE);
	assert.equal(readJson("package.json").version, RELEASE);
});

test("G12: package-lock.json does not still record the previous version", () => {
	const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as {
		version: string;
		packages: Record<string, { version: string }>;
	};
	assert.equal(lock.version, RELEASE);
	assert.equal(lock.packages[""].version, RELEASE);
});

test("G12: the newest versions.json key is the release version and maps to the manifest's minAppVersion", () => {
	const versions = readJson("versions.json");
	const keys = Object.keys(versions);
	assert.equal(keys[keys.length - 1], RELEASE);
	assert.equal(versions[RELEASE], readJson("manifest.json").minAppVersion);
});

test("G12: minAppVersion stays 1.13.0 and earlier versions.json entries are kept", () => {
	const versions = readJson("versions.json");
	assert.equal(readJson("manifest.json").minAppVersion, "1.13.0");
	for (const earlier of ["0.1.0", "0.1.5", "0.2.0", "0.3.0", "0.3.1"]) {
		assert.equal(versions[earlier], "1.13.0", `versions.json lost ${earlier}`);
	}
});

test("G12: the release workflow's tag check passes for the tag that would be pushed", () => {
	// .github/workflows/release.yml fails the release unless the pushed tag
	// equals manifest.json's version; the tag for this release is the bare version.
	const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
	assert.match(workflow, /require\('\.\/manifest\.json'\)\.version/);
	assert.match(workflow, /\[ "\$TAG" != "\$VERSION" \]/);
	assert.equal(readJson("manifest.json").version, RELEASE);
});
