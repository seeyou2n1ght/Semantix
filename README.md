# Semantix

面向 Obsidian 的本地语义检索与发现引擎。核心功能：在写作时自动发现已有笔记中的高相关内容（Related）与意外跨主题关联（Discover）。

当前版本：`v0.7.0`

---

## 核心能力

1. **Related (强相关)**：检索与当前编辑光标或段落语义紧密相关的笔记片段，经由 Cross-Encoder 二次精排。
2. **Discover (意料之外)**：通过 Relevance Gate 门控、Related 强去重与 MMR（最大边际相关）打散算法，召回相关但不重复的跨主题灵感。
3. **沉浸式交互 (Anti-Jitter)**：
   - **单侧边栏设计**：卡片固定高度（78px），消除内容跳动。
   - **Popover 悬浮预览**：悬浮展示父块完整上下文与 Markdown 链接快捷复制。
   - **原位段落定位**：点击卡片直接在主编辑区打开笔记并滚动高亮对应命中块。
4. **纯本地与隐私优先**：向量化计算与 LanceDB 索引完全在本地完成，无外部网络请求。

---

## 技术架构

```text
Obsidian (UI / Context) <--- REST API (CORS) ---> FastAPI Sidecar (Computation)
         |                                                 |
  [ContextEngine]                                 [Storage: LanceDB]
  [QueryChangeGate]                               [Embedding: BGE-Small-zh-v1.5]
  [ResultStabilizer]                              [Reranker: BGE-Reranker-Base]
  [PopoverPreview]                                [Ranking Pipeline: Related + Discover MMR]
```

### 依赖模型
- **向量模型 (Embedding)**: `BAAI/bge-small-zh-v1.5`（512 维，首次启动自动拉取至本地缓存）
- **精排模型 (Reranker)**: `BAAI/bge-reranker-base`（Cross-Encoder，支持 fast / balanced / high_quality 模式）
- **向量存储**: LanceDB (物理表 `semantix_notes`, 混合向量 + FTS 全文索引)

---

## 快速开始

### 1. 后端伴生服务 (Python 3.11+)

```bash
cd backend
uv sync
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```

### 2. 前端插件 (Node 22+)

```bash
cd frontend
npm ci
npm run build
```

编译产物为 `main.js`、`manifest.json` 与 `styles.css`。将它们放入 Obsidian 仓库的 `.obsidian/plugins/semantix/` 即可。

---

## 文档索引

- **[部署与配置手册](docs/setup.md)**：依赖安装、自动拉起与环境配置
- **[架构与抗抖设计](docs/architecture.md)**：前端状态机、后端分层流水线与并发竞态控制
- **[检索与算法详解](docs/retrieval.md)**：AST 切分、相关性归一化、MMR 多样性公式与理由标签生成
- **[API 接口契约](docs/api.md)**：`POST /search/radar` 及全量 REST API 定义

---

## 开发者工作流与版本发布

版本号以 `frontend/package.json` 为单一真实源 (SSOT)：

```bash
cd frontend
npm run version [patch|minor|major]  # 自动同步版本至 manifest.json、versions.json 与 README.md
git add -A && git commit -m "chore(release): bump version"
git tag v<version> && git push --tags
```

---

## 开源协议

MIT

