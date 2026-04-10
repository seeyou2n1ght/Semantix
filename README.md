# Semantix

Semantix 是一个面向 Obsidian 的本地语义关联引擎。它通过神经网络理解笔记内容，为你发现笔记之间隐藏的语义脉络。

项目当前版本：`v0.4.7`

---

## 🚀 核心功能

- **Whisperer (动态灵感)**：根据当前编辑内容推荐相关的笔记片段。
- **Orphan Radar (孤岛雷达)**：识别未链接的笔记并提供关联建议。
- **本地后端自动配置**: 填入路径后自动识别虚拟环境。支持一键创建环境并同步依赖。
- **端口冲突处理**: 自动检测 8000 端口占用，支持在 Windows 上手动清理。
- **启动状态追踪**: 在插件右上角实时显示后端启动进度（环境同步、模型加载等）。
- **进程生命周期管理**: 确保在插件卸载或 Obsidian 关闭时，后端进程（及其子进程）能完全退出。
- **智能同步**: 实时监听文件变更并执行增量搜索索引。

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
