# Semantix

Semantix is a local-first retrieval plugin for Obsidian. As you write, its dual-stream sidebar surfaces directly relevant notes (**Related**) and relevant, less repetitive candidates that may offer further connections (**Discover**).

[English](#english) | [中文说明](#中文说明)

---

## English

### Key Features

- **Dual-stream Inspiration**:
  - **Related**: Combines Vector embeddings and Full-Text Search (FTS) via Reciprocal Rank Fusion (RRF), refined with a Cross-Encoder reranker to surface directly relevant notes.
  - **Discover**: Relevance-gated candidate pool with duplicate suppression, relationship penalties, and Maximal Marginal Relevance (MMR) diversity to spark cross-topic serendipity.
- **Real-time Writing Companion**: Context gating, keystroke debouncing, stable card ordering, popover previews, and navigation to a uniquely matched passage in the current note source.
- **Local-First & Private**: All embeddings, indexing, and reranking run on your local machine. Notes never leave your device unless you explicitly configure a remote private server.
- **Robust Vault Indexing**: Strict vault isolation, incremental syncing on save, failure-safe index retention, and graceful error recovery.

### Requirements

- Obsidian `v1.7.2` or later.
- Desktop: Python `3.11+` with [`uv`](https://docs.astral.sh/uv/) for running the local engine.

Upgrading to **0.12.0**: update the companion Engine source to the `0.12.0` tag, run `uv sync --locked` in `engine/`, and restart it along with the plugin. The new path-inventory capability is required for complete reconciliation/rebuild; older engines leave that state visibly unverified. Existing embeddings remain valid. The first reconciliation without saved file signatures may queue all eligible notes.

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

Semantix uses a separate Python engine for embedding and retrieval. The three Obsidian release assets contain the plugin only. Obtain the companion source repository first, then run these commands from its root (or use your existing checkout):

```powershell
cd engine
uv sync --locked
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```

> **Note**: On first run, the engine will automatically download the local embedding model (`BAAI/bge-small-zh-v1.5`) and reranker model (`BAAI/bge-reranker-v2-m3`). No note contents are uploaded.
> For offline environments, you can pre-download models:
> ```powershell
> cd engine
> uv run python scripts/download_models.py --no-mirror
> ```

The pre-downloader uses the same model ID/revision and Hugging Face cache as the service; run it under the same user and cache environment (`HF_HOME`, if customized). The example uses the official endpoint; omit `--no-mirror` to request the mirror. For offline startup after a successful download, set `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` before starting the engine. The M3 safetensors weights alone are approximately 2.3 GB, so allow download time, disk space and additional runtime memory.

The reranker is pinned to official revision `953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e`, uses safetensors without remote code, and processes at most 512 tokens per query/passage pair (long pairs are truncated). It changes reranking only: existing embeddings and indexes remain valid, so no index rebuild is needed. M3 needs more memory and inference time than the previous base model; CPU fallback can be substantially slower.

For resource compatibility, explicitly select the previous model **before starting the engine or pre-downloader**:

```powershell
$env:SEMANTIX_RERANKER_MODEL = "BAAI/bge-reranker-base"
```

Only these two official model IDs are supported. The legacy base selection retains its original model revision behavior. The engine never silently substitutes base for M3. Download/load/inference failure returns semantic results with `reranker_unavailable`; `/health` reports the selected `reranker_model`, `reranker_revision`, `reranker_status` and `reranker_device`. Top-level `ok` means semantic retrieval is available, and does not guarantee reranker readiness. A permanent reranker failure requires correcting the cause and restarting the engine; the downloader exits unsuccessfully if either model fails.

You can also enable **Auto-start Local Engine** in the plugin settings on desktop. Set the backend project path to the checkout's `engine` directory and configure the Python/uv executable first. Auto-start is disabled by default.

#### 2. Verify Connection & Build Index

1. Go to Obsidian **Settings** > **Semantix**.
2. Verify that the backend status displays **Connected**.
3. Under **Index Management**, click **Build Full Index**.
4. The plugin will index your Markdown vault in batches. Progress is shown in the settings tab and status bar.

The current engine exposes `vault_indexed_paths` in health capabilities. Startup/reconnect reconciles local files against that inventory and queues missing, changed, removed or newly excluded notes; the first run without saved signatures may index all notes. Full rebuild replaces current notes before cleaning obsolete paths and preserves the old index of failed notes. An unavailable/older engine leaves consistency unverified; update the companion engine before using the complete rebuild workflow. File mtime/size checks cannot detect edits that preserve both values; use an explicit full rebuild for those cases.

Path exclusions apply to future indexing and immediately hide matching cards. Previously indexed excluded paths are removed through reconciliation. Clear waits for this plugin's pending writes, retains work if the request fails, and preserves later editing events. Clear is not a permanent indexing pause: later edits or a subsequent startup/reconnect may index notes again.

#### 3. Use the Radar Sidebar

1. Click the ribbon icon or run the command `Semantix: Open Radar View` (or `Semantix: Open side view`).
2. Position the Semantix sidebar where you prefer (e.g., the right sidebar).
3. Start editing or browsing notes! As your cursor moves and you type, Semantix automatically queries the engine and refreshes:
   - **Related**: Notes relevant to the captured selection, current line, or fallback paragraph.
   - **Discover**: Other relevant candidates selected for diversity; results may come from the same folder or topic.
4. Hover over any card for a quick popover preview, or click to jump directly to the referenced note.
5. **Scan whole note** shows partial results as sections finish. **Stop scan** stops subsequent sections; an in-flight search may still finish. Failed or stopped scans keep results visibly incomplete. A separate notice identifies degraded retrieval when a search capability is unavailable.

Navigation uses the complete matched text, including Markdown formatting and line breaks. If the passage changed or appears more than once, Semantix opens the note and reports that it cannot locate the match reliably.

Turn off **Update while writing** to stop automatic searches from typing, cursor moves and selections; switching files and explicit scans still work. Search setting changes refresh the current scope after a short input debounce. When the current text is too short, old cards are visibly stale. Hover the source breadcrumb to inspect a short excerpt of the captured query.

Related and Discover share the recalled candidates and, in balanced/high-quality mode, the successful rerank shortlist (up to 16/20 notes). Discover selects from candidates left after Related; it cannot recover useful extensions absent from that shortlist. Its labels describe structural evidence, and lexical highlights show shared terms; neither proves semantic usefulness. Whole-note scans merge per-part results and do not perform a new global semantic MMR pass. Real-Vault Discover usefulness remains to be evaluated independently.

---

### Privacy & Network Security

- **Local-first by default**: All note embeddings, indexing (LanceDB), and search run locally on `127.0.0.1`.
- **Zero telemetry**: Semantix contains no trackers, telemetry, or third-party cloud LLM/AI services.
- **Desktop process access**: Local mode runs the configured Python/uv executable and stops the plugin-owned process tree. These operations pass arguments directly with shell execution disabled. Remote mode does not start local processes.
- **Vault and clipboard access**: Full indexing enumerates Markdown notes and applies your exclusion rules before reading them. The Vault ID copy button writes that ID to the clipboard only when clicked; the plugin does not read clipboard contents.
- **Vault safety**: Indexing and retrieval do not modify, rename, or delete your Markdown notes. The explicit **Insert link** action inserts a link at the editor cursor. Vector and FTS indexes are stored in the engine's external data directory.
- **Optional Remote Mode**: If you explicitly configure a remote engine URL, note contents will be sent to that address. Remote deployments require setting a `SEMANTIX_API_TOKEN` and managing TLS/network security.

---

### Engine Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `SEMANTIX_API_TOKEN` | *empty* | When set, all requests must include the matching `X-Semantix-Token` header. Required for remote servers. |
| `SEMANTIX_RERANKER_MODEL` | `BAAI/bge-reranker-v2-m3` | Explicit compatibility option: `BAAI/bge-reranker-base`; applies to the engine and pre-downloader. |
| `SEMANTIX_DB_PATH` | `<engine>/semantix_lance` | Directory for LanceDB vector storage, anchored to the engine source directory by default. An explicit relative override resolves from the process working directory. |
| `SEMANTIX_ALLOWED_ORIGINS` | Localhost & Obsidian origins | Comma-separated CORS allowed origins. |
| `SEMANTIX_LOG_LEVEL` | `INFO` | Engine logging verbosity (`DEBUG`, `INFO`, `WARNING`, `ERROR`). |
| `SEMANTIX_PARENT_PID` | `0` | Process ID monitored by the local sidecar watchdog. |
| `SEMANTIX_WATCHDOG_TIMEOUT`| `600` | Inactivity timeout in seconds before auto-exit (`0` to disable). |
| `SEMANTIX_HOST` | `127.0.0.1` | Binding host when executing `main.py` directly. |
| `SEMANTIX_PORT` | `8000` | Port when executing `main.py` directly. |

---

### Troubleshooting

- **Engine Not Connected**: Verify the engine is running and accessible at `http://127.0.0.1:8000/health`. Check that the port in plugin settings matches. Automatic local recovery stops after three failed recovery attempts and reports the suspension once. Fix the cause and use **Force Restart Engine**, or start the engine externally; quiet health checks detect recovery. Pending incremental changes wait while offline and resume when connected.
- **Model downloading takes long**: Check network access to HuggingFace or ModelScope. Pre-run `scripts/download_models.py` if needed.
- **Port Conflict**: If the configured local port is occupied, the plugin selects a free loopback port and saves the new Engine URL. **Force Restart Engine** only restarts its own process. Disable the older `obsidian-semantix` plugin before enabling this `semantix` plugin: both register the same legacy view type and cannot run together.

---

## 中文说明

Semantix 是面向 Obsidian 的本地语义检索与灵感发现插件，在写作过程中提供强相关内容（Related）和跨主题关联（Discover）。

当前版本：`v0.12.0`。正式发布限定桌面端，支持本地 Sidecar 或用户配置的远程引擎；移动端相关代码保留用于后续支持工作，当前不属于已支持的发布能力。

升级至 **0.12.0** 时，请将配套 Engine 源码同步到 `0.12.0` 标签，在 `engine/` 执行 `uv sync --locked` 后重启 Engine 和插件。完整索引核对/重建需要新的路径清单能力，旧引擎会保留明确的未核对状态。现有嵌入仍有效；首次没有成功文件签名时，可能需要排队索引全部符合规则的笔记。

### 核心能力

- **Related**：Vector + FTS 双路召回，经可选 Cross-Encoder 精排输出高相关笔记。
- **Discover**：在相关性门控后排除 Related，通过关系特征和 MMR 提供不重复的跨主题线索。
- **整篇扫描**：逐段展示并标明部分结果，可停止后续段落；已发送的请求可能继续完成。失败、停止与检索能力降级均有明确提示。
- **命中定位**：按完整命中正文定位原始 Markdown 行；内容已变化或存在重复时打开笔记并提示，不猜测位置。
- **实时编辑体验**：上下文门控、迟到响应丢弃、稳定卡片排序、悬浮预览与原文定位。
- **可靠索引**：Vault 隔离、增量同步、失败文档保留旧索引、FTS 显式重建与有界重试。

Related 与 Discover 共用召回候选；balanced/high_quality 模式只在成功精排的前 16/20 个候选中分流。Discover 从 Related 选取后的其余候选中选择，无法找回没有进入该短名单的有用延伸，也不保证一定跨目录或跨主题。徽章表示结构性线索，高亮表示共同词项，均不等于语义有效性的证明。整篇扫描合并分段结果，不会重新执行整篇级的语义 MMR；真实 Vault 中的启发价值仍需独立评价。

### 隐私与网络边界

- 默认模式仅在本机插件与 `127.0.0.1` Sidecar 之间传输笔记内容；模型推理和索引存储在用户控制的环境中完成。
- 首次运行可能从模型注册源下载 `BAAI/bge-small-zh-v1.5` 和 `BAAI/bge-reranker-v2-m3`。这不会上传笔记内容。
- 精排默认固定官方 M3 revision `953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e`，使用 safetensors，禁用 remote code，每个 query/passage pair 最多 512 tokens（超长截断）；仅影响精排，无需重建索引。M3 的内存和推理开销更高，资源有限时可在启动前设置 `SEMANTIX_RERANKER_MODEL=BAAI/bge-reranker-base` 显式回选旧模型。不会静默替换模型；下载/加载/推理失败会通过 `reranker_unavailable` 明示语义降级，health 的顶层 `ok` 只保证语义检索可用，新增精排状态字段单独反映就绪情况。
- 只有用户显式配置私有远程 Engine 时，笔记数据才会发送至该地址。远程部署必须配置 API Token，并由操作者负责 TLS 或可信网络边界。
- 索引和检索不会修改、重命名或删除 Vault 内的 Markdown 原文；主动点击“插入链接”会在编辑器光标处插入链接。向量和 FTS 索引存储在 Vault 外部的 Engine 数据目录。
- 项目不包含遥测或第三方笔记处理服务。
- 桌面本地模式会运行配置的 Python/uv 程序并停止插件自己启动的进程树；这些操作直接传递参数并禁用 shell。远程模式不会启动本地进程。
- 全量索引会枚举 Markdown 笔记，并在读取前应用排除规则。Vault ID 的复制按钮仅在点击时写入该 ID，插件不读取剪贴板内容。

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

要求 Python 3.11+ 和 `uv`。Obsidian 的三个插件发布文件不包含 Python Engine；请先获取本项目源码，在源码根目录执行：

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

启用插件后配置 Engine 地址。桌面本地模式可选择自动启动；该选项默认关闭，启用前需将后端项目路径指向源码中的 `engine` 目录，并配置 Python/uv 可执行程序。

#### 3. 建立索引

Engine 连接成功后，在设置页启动全量索引。插件按文档数和字符数分批发送，并在批次间让出 UI 执行权。失败文档保留在增量队列中重试。

启动、恢复连接和修改排除规则时，插件会通过当前 Engine 的 `vault_indexed_paths` 能力核对索引路径，并结合按 Vault/引擎地址隔离保存的成功文件签名，排队处理离线期间的新增、修改、删除和移动。首次没有成功记录时，可能需要重新索引已有笔记。设置页区分待同步、核对中和未完成核对；连接成功或文档数大于零不代表索引最新。旧 Engine 或清单获取失败时不会据此推断删除；完整重建需要先更新或修复 Engine。外部工具若同时保留文件时间和大小，请显式全量重建。

全量重建先逐篇更新，再清理失效或排除路径；当前没有可索引笔记时仍会核对清理。失败笔记保留旧有效索引并排队重试。排除规则会立即隐藏匹配卡片，并阻止尚未提交的匹配笔记继续索引。清空会等待本插件在途写入结束；失败保留队列，成功仅丢弃清空边界之前的任务，之后发生的新编辑仍会同步。清空不等于永久暂停索引，后续编辑或下一次启动/恢复连接可能重新建立索引。

关闭“写作实时联想”后，打字、光标或段落移动、选择文字均不再自动检索；切换笔记和主动扫描仍有效。排序模式、数量、探索度、停用词及排除规则变化会使旧请求失效，连续输入合并后刷新当前范围。文字不足以检索时，旧卡片会标为过期；悬停来源栏可查看捕获的查询片段。

后端离线时，增量同步暂停提交并保留待处理队列，恢复连接后继续。本地自动恢复最多尝试三次，失败后只提示一次并暂停，不会因等待时间增加而重新循环启动。排除原因后可在设置中手动强制重启，或自行启动后端，由静默健康检查识别恢复。

---

### 文档导航

- [ARCHITECTURE](docs/ARCHITECTURE.md)：范围、架构、数据流、协议、检索与不变量。
- [PROGRESS](docs/PROGRESS.md)：当前状态、版本履历、问题、阻塞和下一步。
- [DECISION](docs/DECISION.md)：不可变 ADR 与取舍。
- [TESTING](docs/TESTING.md)：验证层级、命令和行为门。

### License

MIT
