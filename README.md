# Semantix

Semantix 是面向 Obsidian 的本地语义检索与灵感发现插件，在写作过程中提供强相关内容（Related）和跨主题关联（Discover）。

当前版本：`v0.9.0`。桌面端本地 Sidecar 是主要工作流；代码中存在显式开启的移动端远程模式，其正式支持等级仍记录在 [PROGRESS](docs/PROGRESS.md) 中等待确认。

## 核心能力

- **Related**：Vector + FTS 双路召回，经可选 Cross-Encoder 精排输出高相关笔记。
- **Discover**：在相关性门控后排除 Related，通过关系特征和 MMR 提供不重复的跨主题线索。
- **实时编辑体验**：上下文门控、迟到响应丢弃、稳定卡片排序、悬浮预览与原文定位。
- **可靠索引**：Vault 隔离、增量同步、失败文档保留旧索引、FTS 显式重建与有界重试。

## 隐私与网络边界

- 默认模式仅在本机插件与 `127.0.0.1` Sidecar 之间传输笔记内容；模型推理和索引存储在用户控制的环境中完成。
- 首次运行可能从模型注册源下载 `BAAI/bge-small-zh-v1.5` 和 `BAAI/bge-reranker-base`。这不会上传笔记内容。
- 只有用户显式配置私有远程 Engine 时，笔记数据才会发送至该地址。远程部署必须配置 API Token，并由操作者负责 TLS 或可信网络边界。
- 插件不会修改、重命名或删除 Vault 内的 Markdown 原文；向量和 FTS 索引存储在 Vault 外部的 Engine 数据目录。
- 项目不包含遥测或第三方笔记处理服务。

## 架构

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

## 快速开始

### 1. 启动 Engine

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

### 2. 构建并安装插件

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

### 3. 建立索引

Engine 连接成功后，在设置页启动全量索引。插件按文档数和字符数分批发送，并在批次间让出 UI 执行权。失败文档保留在增量队列中重试。

## Engine 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SEMANTIX_API_TOKEN` | 空 | 设置后所有 API 请求都必须携带匹配 Token；远程部署必须设置 |
| `SEMANTIX_DB_PATH` | `./semantix_lance` | LanceDB 数据目录 |
| `SEMANTIX_ALLOWED_ORIGINS` | 本地及 Obsidian Origin | CORS 白名单，逗号分隔 |
| `SEMANTIX_LOG_LEVEL` | `INFO` | 日志级别 |
| `SEMANTIX_PARENT_PID` | `0` | 本地 Sidecar 监控的宿主进程 PID |
| `SEMANTIX_WATCHDOG_TIMEOUT` | `600` | 无活动退出阈值；`0` 禁用 |
| `SEMANTIX_HOST` | `127.0.0.1` | 直接执行 `main.py` 时的监听地址 |
| `SEMANTIX_PORT` | `8000` | 直接执行 `main.py` 时的监听端口 |

## 运维与排障

- **无法连接**：确认 Engine 正在运行、地址和 Token 一致，并检查 `/health`。
- **模型长期 loading**：检查模型缓存和下载网络；Engine 的 health 目前只表示 Embedding 模型状态，Reranker 降级语义仍在待办中。
- **索引卡住**：查看 Engine 日志中的失败路径；失败项不会从同步队列静默消失。
- **端口冲突或孤儿进程**：本地模式使用后端目录中的 `.semantix.pid` 识别受管进程，并通过父 PID、心跳和有界自愈处理异常退出。
- **备份**：停止写入后备份 `SEMANTIX_DB_PATH`。Schema 不兼容时系统应显式失败，不会自动删除重建。

## 开发与验证

完整验证命令和验收门见 [TESTING](docs/TESTING.md)。发布前执行 `npm run version -- patch`，提交版本变更后使用与 manifest 完全一致且不带 `v` 的标签，例如 `0.8.1`。

## 文档

- [ARCHITECTURE](docs/ARCHITECTURE.md)：范围、架构、数据流、协议、检索与不变量。
- [PROGRESS](docs/PROGRESS.md)：当前状态、版本履历、问题、阻塞和下一步。
- [DECISION](docs/DECISION.md)：不可变 ADR 与取舍。
- [TESTING](docs/TESTING.md)：验证层级、命令和行为门。

## License

MIT
