import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default tseslint.config(
	{
		ignores: [
			"node_modules/**",
			"dist/**",
			"esbuild.config.mjs",
			"eslint.config.mts",
			"version-bump.mjs",
			"versions.json",
			"main.js",
		],
	},
	...tseslint.configs.recommended,
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: {
			obsidianmd: obsidianmd,
		},
		rules: {
			"obsidianmd/commands/no-command-in-command-id": "warn",
			"obsidianmd/commands/no-command-in-command-name": "warn",
			"obsidianmd/commands/no-default-hotkeys": "warn",
			"obsidianmd/commands/no-plugin-id-in-command-id": "warn",
			"obsidianmd/commands/no-plugin-name-in-command-name": "warn",
			"obsidianmd/settings-tab/no-manual-html-headings": "warn",
			"obsidianmd/settings-tab/no-problematic-settings-headings": "warn",
			"obsidianmd/vault/iterate": "warn",
			"obsidianmd/detach-leaves": "warn",
			"obsidianmd/hardcoded-config-path": "warn",
			"obsidianmd/no-forbidden-elements": "warn",
			"obsidianmd/no-plugin-as-component": "warn",
			"obsidianmd/no-sample-code": "warn",
			"obsidianmd/no-tfile-tfolder-cast": "warn",
			"obsidianmd/no-view-references-in-plugin": "warn",
			"obsidianmd/no-static-styles-assignment": "warn",
			"obsidianmd/object-assign": "warn",
			"obsidianmd/platform": "warn",
			"obsidianmd/prefer-file-manager-trash-file": "warn",
			"obsidianmd/prefer-abstract-input-suggest": "warn",
			"obsidianmd/regex-lookbehind": "warn",
			"obsidianmd/sample-names": "warn",
			"obsidianmd/validate-manifest": "warn",
			"obsidianmd/validate-license": "warn",
			"obsidianmd/ui/sentence-case": ["warn", { "enforceCamelCaseLower": true }],
			"no-console": "warn",
			"no-alert": "warn",
			"no-useless-escape": "warn",
			"@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
			"@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
		},
	}
);