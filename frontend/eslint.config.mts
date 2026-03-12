import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// 项目级规则覆盖：将部分严格规则降级为 warning
		// 内联样式后续迁移至 CSS class 后可移除此覆盖
		rules: {
			// 内联样式 —— 后续迁移至 CSS class 后可恢复
			"obsidianmd/no-static-styles-assignment": "warn",
			// 中文 UI 文本不符合英文 sentence-case 规则
			"obsidianmd/ui/sentence-case": "warn",
			// Settings 面板中手动创建标题元素
			"obsidianmd/settings-tab/no-manual-html-headings": "warn",
			// TypeScript 严格类型
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/no-unsafe-assignment": "warn",
			"@typescript-eslint/no-unsafe-call": "warn",
			"@typescript-eslint/no-unsafe-member-access": "warn",
			"@typescript-eslint/no-unsafe-return": "warn",
			"@typescript-eslint/no-floating-promises": "warn",
			"@typescript-eslint/no-misused-promises": "warn",
			"@typescript-eslint/no-unnecessary-type-assertion": "warn",
			// console.log 限制
			"no-console": "warn",
			// confirm() 用于二次确认的合理场景
			"no-alert": "warn",
			"no-useless-escape": "warn",
			"@typescript-eslint/no-unsafe-argument": "warn",
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
