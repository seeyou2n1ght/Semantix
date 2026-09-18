# Semantix

Semantix is a local-first semantic retrieval and serendipity engine for Obsidian. As you write, it automatically surfaces highly relevant notes (**Related**) and unexpected cross-domain conceptual connections (**Discover**) directly in a dual-stream sidebar.

[English](#english) | [中文说明](#中文说明)

---

## English

### Key Features

- **Dual-stream Inspiration**:
  - **Related**: Combines Vector embeddings and Full-Text Search (FTS) via Reciprocal Rank Fusion (RRF), refined with a Cross-Encoder reranker to surface directly relevant notes.
  - **Discover**: Relevance-gated candidate pool with duplicate suppression, relationship penalties, and Maximal Marginal Relevance (MMR) diversity to spark cross-topic serendipity.
- **Real-time Writing Companion**: Context gating, keystroke debouncing, stable card ordering, popover previews, and one-click navigation to the exact paragraph.
- **Local-First & Private**: All embeddings, indexing, and reranking run on your local machine. Notes never leave your device unless you explicitly configure a remote private server.
- **Robust Vault Indexing**: Strict vault isolation, incremental syncing on save, failure-safe index retention, and graceful error recovery.

### Requirements

- Obsidian `v1.7.2` or later.
- Desktop: Python `3.11+` with [`uv`](https://docs.astral.sh/uv/) for running the local engine.

---

### Installation

#### Method 1: Obsidian Community Plugins (Recommended)

1. Open Obsidian **Settings** > **Community plugins**.
2. Make sure **Restricted mode** is turned off.
3. Click **Browse** and search for `Semantix`.
4. Click **Install**, then click **Enable**.

#### Method 2: Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [GitHub Releases](https://github.com/seeyou2n1ght/Semantix/releases).
2. In your vault, navigate to `.obsidian/plugins/` and create a folder named `semantix`.
3. Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/semantix/`.
4. Reload Obsidian and enable **Semantix** under **Community plugins**.

---

### Getting Started

#### 1. Start the Local Engine

Semantix uses a lightweight local Python sidecar for embedding and retrieval. In your terminal:

```powershell
cd engine
uv sync --locked
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```

> **Note**: On first run, the engine will automatically download the local embedding model (`BAAI/bge-small-zh-v1.5`) and reranker model (`BAAI/bge-reranker-base`). No note contents are uploaded.
> For offline environments, you can pre-download models:
> ```powershell
> cd engine
> uv run python scripts/download_models.py
> ```

You can also enable **Auto-start Local Engine** in the plugin settings to have Obsidian launch the sidecar automatically on desktop.

#### 2. Verify Connection & Build Index

1. Go to Obsidian **Settings** > **Semantix**.
2. Verify that the backend status displays **Connected**.
3. Under **Index Management**, click **Build Full Index**.
4. The plugin will index your Markdown vault in batches. Progress is shown in the settings tab and status bar.

#### 3. Use the Radar Sidebar

1. Click the ribbon icon or run the command `Semantix: Open Radar View` (or `Semantix: Open side view`).
2. Position the Semantix sidebar where you prefer (e.g., the right sidebar).
3. Start editing or browsing notes! As your cursor moves and you type, Semantix automatically queries the engine and refreshes:
   - **Related**: Notes directly connected to your current paragraph.
   - **Discover**: Notes from other folders and topics that share deep conceptual echoes.
4. Hover over any card for a quick popover preview, or click to jump directly to the referenced note.

---

### Privacy & Network Security

- **Local-first by default**: All note embeddings, indexing (LanceDB), and search run locally on `127.0.0.1`.
- **Zero telemetry**: Semantix contains no trackers, telemetry, or third-party cloud LLM/AI services.
- **Vault safety**: The plugin never modifies, renames, or deletes your Markdown notes. Vector and FTS indexes are stored in the engine's external data directory.
- **Optional Remote Mode**: If you explicitly configure a remote engine URL, note contents will be sent to that address. Remote deployments require setting a `SEMANTIX_API_TOKEN` and managing TLS/network security.

---

### Engine Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `SEMANTIX_API_TOKEN` | *empty* | When set, all requests must include a matching Bearer token. Required for remote servers. |
| `SEMANTIX_DB_PATH` | `./semantix_lance` | Directory for LanceDB vector storage. |
| `SEMANTIX_ALLOWED_ORIGINS` | Localhost & Obsidian origins | Comma-separated CORS allowed origins. |
| `SEMANTIX_LOG_LEVEL` | `INFO` | Engine logging verbosity (`DEBUG`, `INFO`, `WARNING`, `ERROR`). |
| `SEMANTIX_PARENT_PID` | `0` | Process ID monitored by the local sidecar watchdog. |
| `SEMANTIX_WATCHDOG_TIMEOUT`| `600` | Inactivity timeout in seconds before auto-exit (`0` to disable). |
| `SEMANTIX_HOST` | `127.0.0.1` | Binding host when executing `main.py` directly. |
| `SEMANTIX_PORT` | `8000` | Port when executing `main.py` directly. |

---

### Troubleshooting

- **Engine Not Connected**: Verify the engine is running and accessible at `http://127.0.0.1:8000/health`. Check that the port in plugin settings matches.
- **Model downloading takes long**: Check network access to HuggingFace or ModelScope. Pre-run `scripts/download_models.py` if needed.
- **Port Conflict**: The service manager automatically cleans up stale `.semantix.pid` locks. You can also click **Force Restart Engine** in settings.

---

## 中文说明

Semantix 是面向 Obsidian 的本地语义检索与灵感发现插件，在写作过程中提供强相关内容（Related）和跨主题关联（Discover）。

当前版本：`v0.9.0`。桌面端本地 Sidecar 是主要工作流；代码中存在显式开启的移动端远程模式，其正式支持等级仍记录在 [PROGRESS](docs/PROGRESS.md) 中等待确认。

### 核心能力

- **Related**：Vector + FTS 双路召回，经可选 Cross-Encoder 精排输出高相关笔记。
- **Discover**：在相关性门控后排除 Related，通过关系特征和 MMR 提供不重复的跨主题线索。
- **实时编辑体验**：上下文门控、迟到响应丢弃、稳定卡片排序、悬浮预览与原文定位。
- **可靠索引**：Vault 隔离、增量同步、失败文档保留旧索引、FTS 显式重建与有界重试。

### 隐私与网络边界

- 默认模式仅在本机插件与 `127.0.0.1` Sidecar 之间传输笔记内容；模型推理和索引存储在用户控制的环境中完成。
- 首次运行可能从模型注册源下载 `BAAI/bge-small-zh-v1.5` 和 `BAAI/bge-reranker-base`。这不会上传笔记内容。
- 只有用户显式配置私有远程 Engine 时，笔记数据才会发送至该地址。远程部署必须配置 API Token，并由操作者负责 TLS 或可信网络边界。
- 插件不会修改、重命名或删除 Vault 内的 Markdown 原文；向量和 FTS 索引存储在 Vault 外部的 Engine 数据目录。
- 项目不包含遥测或第三方笔记处理服务。

### 架构

```text
Obsidian Plugin (TypeScript)
  editor context -> query gate -> HTTP API -> result stabilizer -> sidebar
                                      |
                                      v
Semantix Engine (Python/FastAPI)
  embedding -> Vector + FTS -> rerank -> Related / Discover -> LanceDB
```

插件与 Engine 是独立交付物：

- Obsidian 插件：根目录 `manifest.json`、`versions.json`、`package.json`；构建产物：`main.js`、`styles.css`。
- Engine：Python 3.11+、FastAPI、LanceDB、Sentence Transformers，位于 `engine/` 目录。

详细边界和真实协议来源见 [ARCHITECTURE](docs/ARCHITECTURE.md)。

### 快速开始

#### 1. 启动 Engine

要求 Python 3.11+ 和 `uv`：

```powershell
cd engine
uv sync --locked
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```

健康检查地址为 `http://127.0.0.1:8000/health`。首次加载模型需要可访问模型注册源；离线环境可提前执行：

```powershell
cd engine
uv run python scripts/download_models.py
```

#### 2. 构建并安装插件

要求 Node.js 22：

```powershell
npm ci
npm run build
```

将根目录 `main.js`、`manifest.json`、`styles.css` 复制到：

```text
<vault>/.obsidian/plugins/semantix/
```

启用插件后配置 Engine 地址。桌面本地模式可选择自动启动；该选项默认关闭。

#### 3. 建立索引

Engine 连接成功后，在设置页启动全量索引。插件按文档数和字符数分批发送，并在批次间让出 UI 执行权。失败文档保留在增量队列中重试。

---

### 文档导航

- [ARCHITECTURE](docs/ARCHITECTURE.md)：范围、架构、数据流、协议、检索与不变量。
- [PROGRESS](docs/PROGRESS.md)：当前状态、版本履历、问题、阻塞和下一步。
- [DECISION](docs/DECISION.md)：不可变 ADR 与取舍。
- [TESTING](docs/TESTING.md)：验证层级、命令和行为门。

### License

MIT
