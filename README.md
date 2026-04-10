# Semantix

Semantix 是一个面向 Obsidian 的本地语义关联引擎。它通过神经网络理解笔记内容，为你发现笔记之间隐藏的语义脉络。

项目当前版本：`v0.4.0`

---

## 🚀 核心功能

- **Whisperer (动态灵感)**：在编辑时自动推荐相关的历史笔记片段。
- **Orphan Radar (孤岛雷达)**：智能识别断开连接的笔记并建议潜在的链接目标。
- **Smart Sync (智能同步)**：实时监听文件变更并执行增量语义索引。
- **Title-Aware Chunking**：针对 Markdown 优化的标题感知切块算法。
- **Hybrid Search**：向量召回与关键词检索的双路混合引擎。

---

## 📖 文档中心

想要深入了解？请查阅以下专项手册：

### 🏁 快速开始
- **[部署与配置手册](./docs/setup.md)**：后端环境搭建、插件安装、常见问题排查与升级。

### ⚙️ 技术细节
- **[架构设计图](./docs/architecture.md)**：系统拓扑、代码组织、库隔离机制。
- **[检索逻辑详解](./docs/retrieval.md)**：Markdown 清洗、切块算法及排名策略 (Hit-boost)。
- **[API 参考](./docs/api.md)**：后端 REST 接口规范与数据模型。

### 🗺️ 项目演进
- **[路线图与状态](./docs/roadmap.md)**：施工进度、当前约束及未来计划。

---

## 📦 简易安装 (快速入口)

1. **后端**：在 `backend/` 下运行 `uv run uvicorn main:app`。
2. **插件**：构建 `frontend/` 后将产物放入插件目录。
3. **连接**：在 Obsidian 设置中填入后端 URL 并完成 **全量索引**。

> 详细步骤请访问 [部署与配置手册](./docs/setup.md)。

---

## 🛠️ 技术栈

- **Frontend**: TypeScript, Obsidian API.
- **Backend**: Python, FastAPI, Sentence-Transformers.
- **Database**: LanceDB (Next-gen vector database for local AI).

---

## License

MIT
