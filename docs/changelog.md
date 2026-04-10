# 更新日志 (Changelog)

所有对 Semantix 的重要改动都将记录在此文档中。

## [0.4.0] - 2026-04-10

### 🚀 新功能 (Features)
- **并发检索控制 (Search Versioning)**: 引入版本号校验机制，彻底解决光标快速移动导致的结果跳闪和竞态冲突。
- **孤岛雷达交互增强**: 增加侧边栏 Hover 态高亮反馈，提示可点击区域。

### 🛠️ 架构与工程 (Engineering)
- **文档体系重塑**: 建立 `docs/` 专项文档目录，实现“README 门户化 + 专项手册深度化”。
- **样式系统重构**: 弃用 TS 硬编码样式，全面切换至 `styles.css` 并适配 Obsidian 原生 CSS 变量。
- **构建链路集成**: 升级 `esbuild` 配置以支持多入口构建，实现样式表的自动压缩与输出。
- **CI/CD 修复**: 解决了 `npm ci` 依赖不一致导致的构建阻塞，并修复了全量 Lint 错误。

### 🩹 修复 (Fixes)
- **UI 规范调整**: 按照 Obsidian 官方规范，将所有设置项改为 Sentence case。
- **类型安全**: 修复了 `client.ts` 和 `sync.ts` 中多处 TypeScript 类型错误（处理 `any` 与 `unknown` 类型）。
- **正则表达式修复**: 修正了 `markdown.ts` 中多余的正则转义字符警告。

---

## [0.3.0] - 2026-04-05

### 🚀 新功能 (Features)
- **Hybrid Search**: 实现向量检索与关键词检索的双路混合召回。
- **Hit-boost 算法**: 引入文档级聚合重排序算法，显著提升 Top 5 的相关度。
- **Vault 隔离机制**: 基于 Vault 路径哈希实现 LanceDB 数据的逻辑隔离。

### 🛠️ 架构与工程 (Engineering)
- **后端模型热加载**: 实现 Sentence-Transformers 模型的异步加载与健康检查。
- **增量同步策略**: 通过 `SyncManager` 实现基于文件指纹的增量索引更新。

---

## [0.1.0] - 2026-03-20

### 🏗️ 初始版本
- 建立插件基础框架（Obsidain + TypeScript）。
- 实现基础语义检索原型与后端 FastAPI 接口。
- 支持简单的侧边栏视图展示结果。
