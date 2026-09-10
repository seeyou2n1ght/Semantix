# Semantix

面向 Obsidian 的本地语义检索与灵感发现插件。核心能力：在写作过程中自动发现已有笔记中的高相关内容（Related）与意外跨主题关联（Discover）。

当前版本：`v0.8.0`（Desktop Only）

---

## 🔒 隐私与本地网络披露 (Privacy & Local Network Disclosure)

为符合 Obsidian 社区插件安全与开发者规范（Developer Policies），在此明确披露本插件的网络与文件读写行为：

1. **Localhost 网络通信**：
   - 本插件仅通过 `localhost`（默认 `http://127.0.0.1:8000`）与用户自行在本地运行的 **Semantix Engine** 伴生服务通信。
   - 所有的自然语言处理、文本切块与向量计算均 100% 在用户本地设备完成，**绝不将任何笔记内容或元数据发送给任何第三方云服务或外部网络**。
2. **Vault 外部数据存储**：
   - 语义向量索引与全文检索引擎由本地 Semantix Engine 管理，默认持久化保存在 Vault 外部目录（如 `./semantix_lance/` 或配置的自定义路径）。
   - 插件本身绝不会修改、重命名或删除 Vault 内的用户笔记文件。
3. **独立发布与依赖隔离**：
   - 本插件遵循社区规范，**绝不在运行时自动下载、安装或更新 Python、pip、PyTorch 等外部二进制依赖**。
   - 插件仅作为 Obsidian 前端客户端存在；计算引擎（Semantix Engine）作为独立的本地计算服务由用户安装并运行。

---

## 核心能力

1. **Related (强相关)**：检索与当前编辑光标或段落语义紧密相关的笔记片段，经由 Cross-Encoder 二次精排。
2. **Discover (意料之外)**：通过 Relevance Gate 门控、Related 强去重与 MMR（最大边际相关）打散算法，召回相关但不重复的跨主题灵感。
3. **沉浸式交互 (Anti-Jitter)**：
   - **单侧边栏设计**：卡片固定高度（78px），杜绝布局位移。
   - **Popover 悬浮预览**：悬浮展示父块完整上下文与 Markdown 链接快捷复制。
   - **原位段落定位**：点击卡片直接在主编辑区打开笔记并平滑滚动高亮对应命中块。

---

## 系统拓扑与双发布架构

```text
+──────────────────────────────────+           +─────────────────────────────────────────+
|   Semantix Plugin (Obsidian)     |           |        Semantix Engine (Local Sidecar)  |
|                                  |   HTTP    |                                         |
|  - UI / Context Engine           | localhost |  - FastAPI / BGE Embeddings (512d)      |
|  - Anti-Jitter State Machine     ├──────────►│  - BGE Reranker (Cross-Encoder)         |
|  - API Client (v1 Protocol)      | 127.0.0.1 |  - LanceDB Hybrid Index (Vector + FTS)  |
+──────────────────────────────────+           +─────────────────────────────────────────+
```

- **Semantix Plugin**：提交至 Obsidian Community Plugins（产物：`main.js`, `manifest.json`, `styles.css`）。
- **Semantix Engine**：独立的本地计算引擎（Python 3.11+, FastAPI, LanceDB, BGE）。

---

## 快速安装与使用

### 1. 运行本地计算引擎 (Semantix Engine)

```bash
cd backend
uv sync
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```
首次启动时引擎会自动缓存 `BAAI/bge-small-zh-v1.5` 与 `BAAI/bge-reranker-base` 模型。

### 2. 安装并启用插件 (Semantix Plugin)

在 Obsidian 社区插件市场搜索 **Semantix** 并安装（或手动解压 `main.js`, `manifest.json`, `styles.css` 至 `.obsidian/plugins/semantix/`）。

打开侧边栏，插件将自动检测并连接本地引擎（`● Local engine connected`），即可边写边发现已有知识。

---

## 文档索引

- **[部署与配置手册](docs/setup.md)**：引擎安装、Localhost 连接与排障
- **[架构与抗抖设计](docs/architecture.md)**：分层设计、抗抖状态机与竞态控制
- **[检索与算法详解](docs/retrieval.md)**：AST 切分、归一化、MMR 算法公式
- **[API 接口契约](docs/api.md)**：`GET /health` 协议协商与 `POST /search/radar` 双流接口

---

## 开发者工作流

版本号由 `frontend/package.json` 单一真实源驱动 (SSOT)：

```bash
cd frontend
npm run version [patch|minor|major]  # 自动同步版本至 manifest.json、versions.json 与 README.md
git add -A && git commit -m "chore(release): bump version"
git tag v<version> && git push --tags
```

---

## 开源协议

MIT


