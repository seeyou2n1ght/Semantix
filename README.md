# Semantix · 语义雷达

> 一款基于本地大模型与向量数据库的 Obsidian 侧边栏插件，自动发现笔记库中语义相近但缺乏显式链接的知识节点。

[![版本](https://img.shields.io/badge/version-v0.2.0--draft-blue)](./SPEC.md)
[![平台](https://img.shields.io/badge/platform-Obsidian%20Desktop%20%7C%20Mobile-purple)]()
[![后端](https://img.shields.io/badge/backend-FastAPI%20%2B%20LanceDB-green)]()

---

## ✨ 功能概览

| 功能 | 描述 |
|---|---|
| 🔍 **Real-time Whisperer** | 根据当前编辑内容，实时推荐语义相关的历史笔记 |
| 🏝️ **Orphan Node Rescuer** | 扫描无任何双向链接的孤岛笔记，并推荐适合建立连接的节点 |
| ⚡ **增量同步** | 监听 Vault 文件变更，批量同步至本地向量数据库，保持索引常新 |
| 📊 **索引进度可见** | 侧边栏常驻显示索引进度与索引统计，用户可随时查看状态 |
| 🧱 **骨架屏过渡** | 请求期间展示骨架占位并保留旧内容，减少闪烁 |
| 📱 **移动端降级** | 移动端优雅休眠，不注册事件、不轮询，杜绝耗电 |

---

## 🏗️ 系统架构

```
┌─────────────────────────┐         ┌───────────────────────────────┐
│   Obsidian Plugin (前端) │  HTTP   │   Local AI Backend (后端)     │
│                         │ ──────► │                               │
│  • UI 渲染 / 事件监听    │         │  • FastAPI                    │
│  • Markdown 降噪处理     │         │  • BGE bge-small-zh-v1.5      │
│  • 增量同步队列          │ ◄────── │  • LanceDB (嵌入式向量库)     │
└─────────────────────────┘         └───────────────────────────────┘
```

### API 接口

| 方法 | 路径 | 描述 |
|---|---|---|
| `GET` | `/health` | 探活，检测后端状态 |
| `GET` | `/ready` | 就绪探针，检测模型是否加载完成 |
| `GET` | `/metrics` | 运行指标（索引与检索计数、耗时） |
| `POST` | `/index/batch` | 批量写入 / 更新笔记 embedding |
| `POST` | `/index/delete` | 删除指定路径的 embedding |
| `GET` | `/index/status` | 获取索引统计（按 vault_id） |
| `POST` | `/index/clear/request` | 请求清空索引，返回确认 token |
| `POST` | `/index/clear/confirm` | 使用 token 确认清空索引 |
| `POST` | `/search/semantic` | 语义相关笔记检索（支持 `min_similarity` 阈值） |

---

## 🚀 快速开始

### 前置条件

- **Obsidian** >= 1.4.0
- **Python** >= 3.11（后端服务）
- **uv**（推荐的 Python 环境管理工具）

### 1. 部署后端服务

推荐部署于本机或局域网内的 Raspberry Pi 5 等设备。

```bash
# 安装 uv（如尚未安装）
curl -LsSf https://astral.sh/uv/install.sh | sh   # macOS / Linux
# Windows PowerShell:
# powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# 克隆仓库并进入后端目录
git clone https://github.com/your-org/semantix.git
cd semantix/backend

# 使用 uv 创建虚拟环境并安装依赖（一步完成）
uv sync

# 启动服务（默认监听 0.0.0.0:8000）
uv run uvicorn main:app --host 0.0.0.0 --port 8000
```

> **为什么推荐 uv？**
> `uv` 是由 Astral 开发的极速 Python 包管理器（Rust 实现），比 `pip` + `venv` 快 10-100x，内置锁文件支持，一条命令完成环境创建与依赖安装，非常适合本地 AI 服务的快速部署。

### 2. 安装 Obsidian 插件

**手动安装**
```bash
# 在插件目录下克隆
cd <your-vault>/.obsidian/plugins/
git clone https://github.com/your-org/semantix.git semantix
```
然后在 Obsidian 设置 → 第三方插件中启用 **Semantix**。

### 3. 配置插件

进入 **Obsidian 设置 → Semantix**，填写以下核心配置：

| 配置项 | 说明 | 默认值 |
|---|---|---|
| Backend API URL | 后端服务地址 | `http://localhost:8000` |
| API Token | 后端鉴权令牌（可选） | — |
| Whisperer Scope | 触发检索的上下文范围 | `Current Paragraph` |
| Debounce Delay | 输入防抖时长 (ms) | `2000` |
| Sync Batch Interval | 增量同步间隔 (s) | `60` |
| Filter Linked Notes | 是否过滤已链接笔记 | `true` |
| Top N Results | 推荐结果最大数量 | `5` |
| Minimum Similarity Threshold | 最低相似度截断（0.00-1.00） | `0.70` |
| High Score Threshold (Green) | 高分颜色阈值 | `0.85` |
| Medium Score Threshold (Blue) | 中分颜色阈值 | `0.75` |
| Enable on Mobile | 移动端是否启用 | `false` |
| Exclusion Rules | 不索引的路径（Glob，每行一个） | — |
| Vault ID | 自动生成的 Vault 标识（基于 vault path 哈希） | — |

点击 **\[Test Connection\]** 验证与后端的连通性。

> **关于相似度分数**
> - 语义检索结果返回的是"相似度"（数值越大越相似）
> - 每个结果卡片显示百分比分数，并根据阈值显示不同颜色：
>   - 🟢 绿色 (>= 高分阈值)：高度相关
>   - 🔵 蓝色 (>= 中分阈值)：中度相关
>   - 🟡 黄色 (< 中分阈值)：边缘相关
> - 低于 Minimum Similarity Threshold 的结果会被后端过滤，宁缺毋滥

### 4. 后端安全与环境变量

可选配置以下环境变量以提高安全性与可观测性：

| 变量 | 说明 | 示例 |
|---|---|---|
| `SEMANTIX_API_TOKEN` | 启用 API 访问令牌校验 | `my-secret-token` |
| `SEMANTIX_ALLOWED_ORIGINS` | 允许的 CORS Origin 列表（逗号分隔） | `http://localhost,http://127.0.0.1` |
| `SEMANTIX_LOG_LEVEL` | 日志级别 | `INFO` |

---

## ⚙️ 工作原理

### Real-time Whisperer

```
用户编辑 / 切换文件
        │
        ▼
  防抖计时 (2000ms)
        │
        ▼
  提取上下文（当前段落 or 全文）
        │
        ▼
  Markdown 降噪（剔除 YAML、代码块、图片语法等）
        │
        ▼
POST /search/semantic  →  后端 BGE embedding + LanceDB 检索（distance_range 过滤）
         │
         ▼
   侧边栏渲染 Top N 相关笔记（标题 + 分数颜色标签 + 摘要）
```

### Orphan Node Rescuer

通过 `app.metadataCache` 统计笔记的出度 (`links`) 与入度 (`backlinks`)，列出链接数为 0（或低于阈值）的孤岛笔记，点击后展示语义推荐连接。

> 💡 **详细架构说明与组件剖析，请参阅：[ARCHITECTURE.md](./ARCHITECTURE.md)**

---

## 🗺️ Roadmap

- [x] Real-time Whisperer（MVP）
- [x] Orphan Node Rescuer（MVP）
- [x] 增量批量同步
- [x] `GET /index/status` 索引统计面板
- [x] 一键重建索引（两步确认机制）
- [x] 相似度阈值过滤（LanceDB `distance_range()` 原生支持）
- [x] 分数颜色标签（可自定义阈值区间）
- [ ] 孤岛笔记专属长文本推荐算法（`POST /search/recommend_links`）
- [ ] 侧边栏局部知识图谱可视化

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。提交代码请遵循 Conventional Commits 规范：

```
feat(whisperer): 添加段落级语义触发逻辑
fix(sync): 修复 rename 事件导致的重复索引问题
```

---

## 📄 License

MIT © 2026 Semantix Contributors
