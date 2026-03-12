# 生产部署指南 (Deployment)

本指南覆盖 Semantix 后端服务的生产级部署建议与运维要点。前端 Obsidian 插件安装请参见 `D:\Semantix\README.md`。

---

## 1. 推荐部署拓扑

- **默认建议**：后端部署在本机或局域网内设备，仅对局域网或本机开放。
- **不建议**：直接公网暴露后端服务（除非使用 VPN/零信任或反向代理加固）。

---

## 2. 环境准备

- Python >= 3.11
- uv（推荐）
- 充足的磁盘空间用于向量数据库

---

## 3. 配置项（生产必需）

建议通过环境变量配置：

- `SEMANTIX_API_TOKEN`：强烈建议设置。前端插件需填同一 Token。
- `SEMANTIX_ALLOWED_ORIGINS`：允许的来源，建议限制为本机或内网地址。
- `SEMANTIX_DB_PATH`：向量数据库路径（建议使用绝对路径）。
- `SEMANTIX_LOG_LEVEL`：日志级别（建议 `INFO` 或 `WARNING`）。

示例（Linux/macOS）：

```bash
export SEMANTIX_API_TOKEN="your-strong-token"
export SEMANTIX_ALLOWED_ORIGINS="http://localhost,http://127.0.0.1"
export SEMANTIX_DB_PATH="/var/lib/semantix/semantix.db"
export SEMANTIX_LOG_LEVEL="INFO"
```

示例（Windows PowerShell）：

```powershell
$env:SEMANTIX_API_TOKEN="your-strong-token"
$env:SEMANTIX_ALLOWED_ORIGINS="http://localhost,http://127.0.0.1"
$env:SEMANTIX_DB_PATH="D:\Semantix\data\semantix.db"
$env:SEMANTIX_LOG_LEVEL="INFO"
```

---

## 4. 启动服务

建议使用 `uv`：

```bash
cd D:\Semantix\backend
uv sync
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```

如果需要在局域网中访问，可将 `--host` 设为 `0.0.0.0`，并使用防火墙限制访问范围。

---

## 5. 作为系统服务运行（Linux systemd 示例）

```ini
[Unit]
Description=Semantix Backend
After=network.target

[Service]
WorkingDirectory=/opt/semantix/backend
Environment=SEMANTIX_API_TOKEN=your-strong-token
Environment=SEMANTIX_ALLOWED_ORIGINS=http://localhost,http://127.0.0.1
Environment=SEMANTIX_DB_PATH=/var/lib/semantix/semantix.db
Environment=SEMANTIX_LOG_LEVEL=INFO
ExecStart=/usr/bin/uv run uvicorn main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

---

## 6. 数据路径与备份

- 数据库为 LanceDB（目录形式），`SEMANTIX_DB_PATH` 指向目录。
- 备份方式：**停止服务后**，整体复制数据库目录。
- 建议定期备份并确保备份不进入 Git 仓库。

---

## 7. 健康检查与监控

- `/health`：探活（模型未加载完成会返回 `loading`）。
- `/ready`：就绪探针（模型加载完成返回 `ready`）。
- `/metrics`：索引与检索统计（可被日志系统或自建监控采集）。

---

## 8. 升级流程建议

1. 停止服务
2. 备份数据库目录
3. `git pull` 更新代码
4. `uv sync` 更新依赖
5. 启动服务并验证 `/ready`

