# 部署与配置指南

本文档介绍如何本地部署 Semantix 后端并完成 Obsidian 插件的配置。

## 1. 快速启动后端

Semantix 后端基于高性能的 FastAPI 与 LanceDB。

### 环境要求
- **Python** >= 3.11
- **uv** (推荐) 或 `pip`
- **磁盘空间**：建议保留 2GB+ 用于模型缓存与索引存储

### 启动步骤
1. 克隆仓库进入后端目录：
   ```bash
   git clone https://github.com/seeyou2n1ght/Semantix.git
   cd Semantix/backend
   ```
2. 安装依赖并启动：
   ```bash
   uv sync
   uv run uvicorn main:app --host 127.0.0.1 --port 8000
   ```
3. **健康检查**：访问 `http://127.0.0.1:8000/health`。首次启动会下载模型（约 100MB），加载期间会返回 `{"status": "loading"}`。

---

## 2. 安装与配置插件

### 构建插件
1. 进入前端目录：
   ```bash
   cd Semantix/frontend
   npm install
   npm run build
   ```
2. 复制生成的 `main.js` 和 `manifest.json` 到 Vault 的插件目录：
   `<your-vault>/.obsidian/plugins/obsidian-semantix/`

### 插件配置
在 Obsidian 内部启用插件后，进入设置面板：
- **Backend API URL**: 填写后端地址（默认 `http://localhost:8000`）。
- **API token**: 如果后端配置了鉴权 Token，请在此填写。
- **初始化索引**：点击“初始化向量雷达”开始全量索引。

---

## 3. 环境变量说明

可通过环境变量精细化控制后端行为：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SEMANTIX_API_TOKEN` | 空 | 简单鉴权 Token，需在插件端同步填写 |
| `SEMANTIX_DB_PATH` | `./semantix.db` | 索引数据存储路径 |
| `SEMANTIX_ALLOWED_ORIGINS` | - | CORS 跨域白名单 |
| `SEMANTIX_LOG_LEVEL` | `INFO` | 控制输出日志精细度 |

---

## 4. 常见问题 (FAQ)

### 故障排除
- **插件无法连接**：
    1. 检查后端是否启动。
    2. 检查防火墙是否允许端口访问。
    3. 检查控制台报错，确认鉴权 Token 是否一致。
- **索引进度卡住**：
    通常是因为遇到了巨型文件 (50k+ 字符)。系统已内置截断保护，如果依然卡住，请检查后端 CPU 占用并尝试重启。

### 数据备份
Semantix 的数据存储在 `SEMANTIX_DB_PATH` 目录下。备份该目录即可迁移索引。**注意：升级版本前建议先备份此目录。**
