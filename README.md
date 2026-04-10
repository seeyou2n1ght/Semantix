# Semantix

Semantix 是一个面向 Obsidian 的本地语义关联引擎。它通过神经网络理解笔记内容，为你发现笔记之间隐藏的语义脉络。

项目当前版本：`v0.4.1`

---

## 🚀 核心功能

- **Whisperer (动态灵感)**：在编辑时自动推荐相关的历史笔记片段。
- **Orphan Radar (孤岛雷达)**：智能识别断开连接的笔记并建议潜在的链接目标。
- **Zero-Config Sidecar**：深度联动本地 Python 环境。指定后端路径即可自动识别 `.venv` 虚拟环境，实现真正的“填完即启动”。
- **Smart Sync (智能同步)**：实时监听文件变更并执行增量语义索引。
- **Title-Aware Chunking**：针对 Markdown 优化的标题感知切块算法。

---

## 📖 文档中心

想要深入了解？请查阅以下专项手册：

### 🏁 快速开始
- **[部署与配置手册](./docs/setup.md)**：后端环境搭建、插件安装（支持一键环境探测）、常见问题排查与升级。

### ⚙️ 技术细节
- **[架构设计图](./docs/architecture.md)**：系统拓扑、代码组织、库隔离机制。
- **[检索逻辑详解](./docs/retrieval.md)**：Markdown 清洗、切块算法及排名策略 (Hit-boost)。
- **[API 参考](./docs/api.md)**：后端 REST 接口规范与数据模型。

### 🗺️ 项目演进
- **[路线图与状态](./docs/roadmap.md)**：施工进度、当前约束及未来计划。
- **[更新日志](./docs/changelog.md)**：记录功能迭代与 Bug 修复历程。

---

## 📦 简易安装 (快速入口)

1. **后端**：在 `backend/` 下初始化 Python 虚拟环境。
2. **插件**：安装后在设置中指定 `Backend project path`。
3. **零配置启动**：插件将自动探测 `.venv` 并拉起服务，点击 **开始索引** 即可起航。

> 详细步骤请访问 [部署与配置手册](./docs/setup.md)。

---

## 🛠️ 技术栈

- **Frontend**: TypeScript, Obsidian API.
- **Backend**: Python, FastAPI, Sentence-Transformers.
- **Database**: LanceDB (Next-gen vector database for local AI).

---

## License

MIT
