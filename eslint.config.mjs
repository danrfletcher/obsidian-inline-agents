import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*", "esbuild.config.mjs"],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		// Tests run under node:test, whose top-level `test(...)` calls
		// return a promise that the runner itself awaits — flagging each one
		// as a floating promise would only add `void` noise to every test.
		files: ["tests/**/*.ts"],
		rules: {
			"@typescript-eslint/no-floating-promises": "off",
			// Node-only code: there is no `window` under node:test.
			"obsidianmd/prefer-window-timers": "off",
		},
	},
]);
