# Semantix Deployment Guide

本文档描述当前实现下的 Semantix 后端部署方式，重点是让 Obsidian 插件能稳定连接本地或局域网中的 FastAPI 服务。

## 推荐拓扑

默认建议：

- 后端部署在本机，监听 `127.0.0.1:8000`
- 或部署在可信的局域网设备中，再把插件 `Backend API URL` 指向该地址

不建议：

- 直接暴露到公网
- 在没有鉴权和反向代理限制的情况下开放 `0.0.0.0`

## 运行要求

- Python `>= 3.11`
- `uv`
- 足够的磁盘空间用于模型缓存与 LanceDB 数据目录

## 关键环境变量

| 变量 | 是否必需 | 说明 |
| --- | --- | --- |
| `SEMANTIX_API_TOKEN` | 推荐 | 启用请求头 `X-Semantix-Token` 校验 |
| `SEMANTIX_ALLOWED_ORIGINS` | 推荐 | CORS 白名单 |
| `SEMANTIX_DB_PATH` | 推荐 | LanceDB 数据目录 |
| `SEMANTIX_LOG_LEVEL` | 可选 | 日志级别，默认 `INFO` |

建议显式设置 `SEMANTIX_DB_PATH`，不要依赖默认值。当前代码默认是 `./semantix.db`，但从运维角度更推荐使用目录语义明确的路径，例如：

- Windows: `D:\Semantix\data\lancedb`
- Linux: `/var/lib/semantix/lancedb`

### Linux / macOS 示例

```bash
export SEMANTIX_API_TOKEN="your-strong-token"
export SEMANTIX_ALLOWED_ORIGINS="http://localhost,http://127.0.0.1,app://obsidian.md"
export SEMANTIX_DB_PATH="/var/lib/semantix/lancedb"
export SEMANTIX_LOG_LEVEL="INFO"
```

### Windows PowerShell 示例

```powershell
$env:SEMANTIX_API_TOKEN="your-strong-token"
$env:SEMANTIX_ALLOWED_ORIGINS="http://localhost,http://127.0.0.1,app://obsidian.md"
$env:SEMANTIX_DB_PATH="D:\Semantix\data\lancedb"
$env:SEMANTIX_LOG_LEVEL="INFO"
```

## 启动服务

```bash
cd backend
uv sync
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```

如果需要局域网访问：

```bash
uv run uvicorn main:app --host 0.0.0.0 --port 8000
```

但同时应配合：

- 防火墙限制来源
- API Token
- 仅在可信网络中使用

## 首次启动与健康检查

首次启动时，后端会异步加载 `BAAI/bge-small-zh-v1.5`。因此：

- `/health` 在模型加载完成前可能返回 `{"status":"loading"}`
- `/ready` 在模型未就绪前会返回 `503`
- 插件在这段时间里可能显示为未连接，等模型就绪后会自动恢复

建议依次检查：

```text
GET /health
GET /ready
GET /index/status?vault_id=<vault-id>
```

## systemd 示例

```ini
[Unit]
Description=Semantix Backend
After=network.target

[Service]
WorkingDirectory=/opt/semantix/backend
Environment=SEMANTIX_API_TOKEN=your-strong-token
Environment=SEMANTIX_ALLOWED_ORIGINS=http://localhost,http://127.0.0.1,app://obsidian.md
Environment=SEMANTIX_DB_PATH=/var/lib/semantix/lancedb
Environment=SEMANTIX_LOG_LEVEL=INFO
ExecStart=/usr/bin/uv run uvicorn main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## 数据与备份

Semantix 当前使用 LanceDB 本地目录作为索引存储。

备份建议：

1. 停止后端服务
2. 完整复制 `SEMANTIX_DB_PATH` 指向的目录
3. 备份时不要把该目录纳入 Git 仓库

如果需要重建索引：

- 可以直接在插件设置页执行“重建索引”
- 或删除 LanceDB 数据目录后重新启动并执行一次全量索引

## 升级建议

1. 停止后端
2. 备份 LanceDB 数据目录
3. 拉取最新代码
4. 在 `backend/` 下执行 `uv sync`
5. 启动服务并确认 `/ready`
6. 如涉及索引结构变化，执行一次手动重建索引

说明：当前代码在 `db_svc.py` 中会检查表结构。如果缺少 `child_text` 字段，会重建表。

## 常见问题

### 插件一直显示未连接

先检查：

- 后端是否已启动
- `Backend API URL` 是否正确
- 模型是否还在首次加载
- 如果开启了 `SEMANTIX_API_TOKEN`，插件里是否填写了同一 token

### 已连接但没有结果

常见原因：

- 还没做过全量索引
- 当前段落太短，前端不会触发搜索
- `Minimum Similarity Threshold` 设得过高
- 当前文件或已链接文件被排除

### 重命名后结果异常

当前实现里，重命名会被处理为：

- 删除旧路径索引
- 重新索引新路径

如果中途异常，执行一次全量索引即可恢复一致性。
