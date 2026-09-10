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
3. **模型自动下载**：
   - 首次启动会拉取 `BAAI/bge-small-zh-v1.5` 与 `BAAI/bge-reranker-base`（共约 1.2GB）。
   - **国内加速**：系统内置了镜像探测，会自动使用 `hf-mirror.com` 加速下载。
   - **离线预装**：如需在完全离线环境下使用，请先在联网环境下运行 `uv run scripts/download_models.py` 预下载模型。
4. **健康检查**：访问 `http://127.0.0.1:8000/health`。

---

## 2. 安装与配置插件

### 插件安装
1. 进入前端目录：
   ```bash
   cd Semantix/frontend
   npm install
   npm run build
   ```
2. 复制生成的 `main.js`、`manifest.json` 和 `styles.css` 到 Vault 的插件目录：
   `<your-vault>/.obsidian/plugins/semantix/`

> [!NOTE]
> 样式的源文件位于 `src/styles.css`，构建过程会自动处理并输出到根目录。请勿直接修改根目录下的 `styles.css`。

### 插件配置
在 Obsidian 内部启用插件后，进入设置面板：

#### A. 本地引擎模式 (Local Engine)
适用于在电脑上本地运行 Semantix Engine。

1. **Backend mode**: 选择 `Local Sidecar`。
2. **连接探测**: 确保后台已启动 Engine（`uv run uvicorn main:app --host 127.0.0.1 --port 8000`）。
3. **Backend project path**: （可选）填入本地 `backend/` 项目目录绝对路径。
4. **启动控制**:
   - **Auto-start server**: 开启后，插件可在桌面端随 Obsidian 启动自动尝试拉起本地已安装的 Engine 进程。
   - **探测连接**: 手动检查服务活跃度与 API 协议匹配情况。

#### B. 远程服务模式 (Remote Service)
适用于后端部署在 NAS、服务器或 Docker 中的场景。
1. **Backend mode**: 选择 `Remote Service`。
2. **Backend API URL**: 填写远程后端地址（默认 `http://localhost:8000`）。
3. **API token**: 如果开启了鉴权，请在此填写。

---

### 指示灯状态说明
侧边栏和设置面板中包含实时状态指示灯：
- ⚪ **灰色 (Disabled)**: 插件未启用或本地服务未启动。
- 🟡 **脉冲 (Connecting)**: 正在尝试建立握手或拉起进程。
- 🟢 **绿色 (Connected)**: 服务就绪，可正常使用搜索与同步。
- 🔴 **红色 (Disconnected)**: 连接失败，请检查配置或后端状态。

---

## 3. 初始化索引
连接成功（绿灯）后，点击设置中的 **[开始索引]** 按钮。插件将扫描全库笔记并建立语义地图。进度将实时展示在侧边栏面板下方。

---

## 3. 环境变量说明

可通过环境变量精细化控制后端行为：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SEMANTIX_API_TOKEN` | 空 | 简单鉴权 Token，需在插件端同步填写 |
| `SEMANTIX_DB_PATH` | `./semantix_lance` | 索引数据存储路径 |
| `SEMANTIX_ALLOWED_ORIGINS` | - | CORS 跨域白名单 |
| `SEMANTIX_LOG_LEVEL` | `INFO` | 控制输出日志精细度 |
| `SEMANTIX_PARENT_PID` | `0` | 宿主父进程 PID（Obsidian 退出后自动回收伴生后端） |
| `SEMANTIX_WATCHDOG_TIMEOUT` | `600` | 空闲心跳超时秒数（0 表示禁用看门狗） |

---

## 4. 进程治理与自愈机制

### 本地伴生生命周期管理
- **自动伴生退出**: 插件启动本地 Engine 时会自动注入当前 Obsidian 进程 PID（`SEMANTIX_PARENT_PID`）。后端看门狗在 Windows 上通过 Win32 API `GetExitCodeProcess` 监控宿主退出码；一旦宿主关闭，伴生后端在 10 秒内安全退出并清理锁文件。
- **孤儿进程精准清理**: 本地模式在 Vault 目录生成 `.semantix.pid`。插件启动或重载时会自动识别并强杀残留的孤儿进程树，彻底杜绝端口冲突与句柄泄露。
- **自愈状态机与熔断**:
  - 当本地进程异常崩溃时，插件具备指数退避重试能力（3s / 6s / 15s）。
  - 若连续拉起失败达到 3 次，将触发三振出局熔断保护，停止盲目试错并弹窗提示。
  - 用户可在设置页的 **高级设置 -> Engine** 中点击 **「重置自愈状态并重启」** 手动恢复。

---

## 5. 常见问题 (FAQ)

### 故障排除
- **插件无法连接**：
    1. 检查后端是否启动或是否处于熔断状态。
    2. 检查防火墙是否允许端口访问。
    3. 检查控制台报错，确认鉴权 Token 是否一致。
- **索引进度卡住**：
    前端已内建自适应分片批处理（≤25 篇且 ≤150k 字符）与 `requestIdleCallback` 帧让渡机制。如果卡住，请检查后端终端日志排查是否有畸形二进制或锁定文件。

### 数据备份
Semantix 的数据存储在 `SEMANTIX_DB_PATH` 目录下。备份该目录即可迁移索引。**注意：升级版本前建议先备份此目录。**
