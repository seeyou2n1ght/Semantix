import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
	{
		ignores: [
			"node_modules/**",
			"dist/**",
			"engine/**",
			"esbuild.config.mjs",
			"eslint.config.mts",
			"version-bump.mjs",
		],
	},
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	}
);
