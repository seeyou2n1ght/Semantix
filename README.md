# Semantix · 语义雷达

> 一款基于本地大模型与向量数据库的 Obsidian 侧边栏插件，自动发现笔记库中语义相近但缺乏显式链接的知识节点。

[![版本](https://img.shields.io/badge/version-v0.2.0-blue)](https://github.com/seeyou2n1ght/Semantix/releases)
[![平台](https://img.shields.io/badge/platform-Obsidian%20Desktop%20%7C%20Mobile-purple)]()
[![后端](https://img.shields.io/badge/backend-FastAPI%20%2B%20LanceDB-green)]()

---

## 目录

- [功能概览](#功能概览)
- [系统架构](#系统架构)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [开发指南](#开发指南)
- [工作原理](#工作原理)
- [技术架构](#技术架构)
- [Roadmap](#roadmap)
- [贡献](#贡献)

---

## 功能概览

| 功能 | 描述 |
|---|---|
| Real-time Whisperer | 根据当前编辑或阅读内容，实时推荐语义相关的历史笔记 |
| Orphan Node Rescuer | 扫描无任何双向链接的孤岛笔记，并推荐适合建立连接的节点 |
| 增量同步 | 监听 Vault 文件变更，批量同步至本地向量数据库，保持索引常新 |
| 索引进度可见 | 侧边栏常驻显示索引进度与索引统计，用户可随时查看状态 |
| 骨架屏过渡 | 请求期间展示骨架占位并保留旧内容，减少闪烁 |
| 可解释结果 | 返回最匹配段落作为 snippet，关键词高亮，索引时分块存储无额外开销 |
| 悬浮提示 | 悬浮分数显示相似度含义，悬浮结果显示详细对比 |
| 移动端降级 | 移动端优雅休眠，不注册事件、不轮询，杜绝耗电 |

---

## 系统架构

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

## 快速开始

### 前置条件

- **Obsidian** >= 1.4.0
- **Python** >= 3.11（后端服务）
- **Node.js** >= 18（前端构建，可选）
- **uv**（推荐的 Python 环境管理工具）

### 1. 部署后端服务

推荐部署于本机或局域网内的 Raspberry Pi 5 等设备。

```bash
# 安装 uv（如尚未安装）
curl -LsSf https://astral.sh/uv/install.sh | sh   # macOS / Linux
# Windows PowerShell:
# powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# 克隆仓库并进入后端目录
git clone https://github.com/seeyou2n1ght/Semantix.git
cd Semantix/backend

# 使用 uv 创建虚拟环境并安装依赖
uv sync

# 启动服务（默认监听 0.0.0.0:8000）
uv run uvicorn main:app --host 0.0.0.0 --port 8000
```

### 2. 安装 Obsidian 插件

**方式一：从 Release 下载（推荐）**

1. 前往 [Releases](https://github.com/seeyou2n1ght/Semantix/releases) 页面
2. 下载最新版本的 `main.js` 和 `manifest.json`
3. 放置到 `<your-vault>/.obsidian/plugins/semantix/` 目录
4. 在 Obsidian 设置 → 第三方插件中启用 **Semantix**

**方式二：从源码构建**

```bash
cd Semantix/frontend
npm install
npm run build
```

将 `main.js`、`manifest.json`、`styles.css` 复制到 `<your-vault>/.obsidian/plugins/semantix/`。

### 3. 验证连接

进入 **Obsidian 设置 → Semantix**，点击 **[Test Connection]** 验证与后端的连通性。

---

## 配置说明

### 核心配置

| 配置项 | 说明 | 默认值 |
|---|---|---|
| Backend API URL | 后端服务地址 | `http://localhost:8000` |
| API Token | 后端鉴权令牌（可选） | — |
| Whisperer Scope | 触发检索的上下文范围 | `Current Paragraph` |
| Debounce Delay | 输入防抖时长 (ms) | `2000` |
| Sync Batch Interval | 增量同步间隔 (s) | `60` |
| Filter Linked Notes | 是否过滤已链接笔记 | `true` |
| Top N Results | 推荐结果最大数量 | `5` |
| Minimum Similarity Threshold | 最低相似度截断 | `0.70` |
| High Score Threshold | 高分颜色阈值 | `0.85` |
| Medium Score Threshold | 中分颜色阈值 | `0.75` |
| Enable on Mobile | 移动端是否启用 | `false` |
| Exclusion Rules | 不索引的路径（Glob） | — |

### 相似度分数说明

- 分数范围：`0.00-1.00`（数值越大越相似）
- 颜色标签：
  - 🟢 绿色 (>= 高分阈值)：高度相关
  - 🔵 蓝色 (>= 中分阈值)：中度相关
  - 🟡 黄色 (< 中分阈值)：边缘相关
- 悬浮提示：显示相似度含义和详细对比

### 环境变量

| 变量 | 说明 | 示例 |
|---|---|---|
| `SEMANTIX_API_TOKEN` | API 访问令牌校验 | `my-secret-token` |
| `SEMANTIX_ALLOWED_ORIGINS` | CORS Origin 白名单 | `http://localhost` |
| `SEMANTIX_LOG_LEVEL` | 日志级别 | `INFO` |

---

## 开发指南

### 前端构建

```bash
cd frontend
npm install           # 安装依赖
npm run dev           # 开发模式
npm run build         # 生产构建
npm run lint          # 代码检查
```

### 后端开发

```bash
cd backend
uv sync                                  # 安装依赖
uv run uvicorn main:app --reload         # 开发模式
```

### 项目结构

```
Semantix/
├── frontend/                # Obsidian 插件
│   ├── src/
│   │   ├── api/            # API 客户端
│   │   ├── core/           # 核心逻辑 (whisperer, radar, sync)
│   │   ├── ui/             # 视图组件
│   │   ├── utils/          # 工具函数
│   │   ├── main.ts         # 插件入口
│   │   └── settings.ts     # 设置面板
│   ├── manifest.json
│   └── package.json
└── backend/                 # Python 后端
    ├── main.py             # FastAPI 入口
    ├── model_svc.py        # Embedding 模型服务
    ├── db_svc.py           # LanceDB 服务
    └── utils/chunker.py    # 分块器
```

---

## 工作原理

### Real-time Whisperer

```
用户编辑 / 切换文件 / 点击段落
        │
        ▼
  防抖计时 (2000ms / 300ms)
        │
        ▼
  提取上下文（当前段落 or 全文）
        │
        ▼
  Markdown 降噪
        │
        ▼
  POST /search/semantic
        │
        ▼
  侧边栏渲染结果
    • 标题 + 相似度分数
    • 关键词高亮的 snippet
    • 悬浮提示
```

### Orphan Node Rescuer

通过 `app.metadataCache` 统计笔记的出度和入度，列出链接数为 0 的孤岛笔记，点击后展示语义推荐连接。

---

## 技术架构

<details>
<summary>点击展开详细架构说明</summary>

### 前端模块

#### API 契约层 (`frontend/src/api/`)
- 使用 `requestUrl` 解决跨域问题
- 完整的 TypeScript 类型定义
- 支持 `min_similarity` 相似度过滤

#### Whisperer (`frontend/src/core/whisperer.ts`)
- **三重触发机制**：
  - `file-open`: 文件切换时触发
  - `editor-change`: 编辑时防抖触发（2000ms）
  - `cursor-activity`: 光标活动触发（300ms，仅 paragraph 模式）
- **关键词高亮**：N-gram 算法 + 停用字过滤
- **Snippet 聚焦**：以匹配关键词为中心截取

#### Orphan Radar (`frontend/src/core/radar.ts`)
- 前端计算入度/出度，找出孤岛笔记
- 支持展开显示推荐连接

### 后端模块

#### 数据库服务 (`backend/db_svc.py`)
```python
Schema: [vault_id, path, chunk_index, vector, text]
# 索引时分块存储，检索时聚合
```

#### 分块器 (`backend/utils/chunker.py`)
- 按段落分块（空行分割）
- 超长段落按句子边界切分
- max 500 字符，min 50 字符

### 关键算法

#### N-gram 关键词提取
```
输入: "机器学习是人工智能"
输出: ["机器学", "器学习", "人工智", ...]  # 过滤含停用字的组合
```

#### Snippet 聚焦截取
```
以第一个匹配关键词为中心
前后各取 40 字符
超出边界添加省略号
```

</details>

---

## Roadmap

- [x] Real-time Whisperer（MVP）
- [x] Orphan Node Rescuer（MVP）
- [x] 增量批量同步
- [x] 索引统计面板
- [x] 一键重建索引
- [x] 相似度阈值过滤
- [x] 分数颜色标签
- [x] 索引时分块存储
- [x] 光标活动监听
- [x] 关键词高亮
- [x] 悬浮提示
- [x] BGE 查询指令补偿与 Chunking 上下文强化 (v0.2.x 优化)
- [ ] 混合检索与双路召回 (BM25 + Vector)
- [ ] Cross-encoder 深度重排支持
- [ ] 孤岛笔记专属推荐算法
- [ ] 侧边栏知识图谱可视化

---

## 贡献

欢迎提交 Issue 和 Pull Request。提交代码请遵循 Conventional Commits 规范：

```
feat(whisperer): 添加段落级语义触发逻辑
fix(sync): 修复 rename 事件导致的重复索引问题
```

---

## License

MIT © 2026 Semantix Contributors

---

## 致谢

感谢以下项目对本开发的帮助：

- **[Antigravity](https://github.com/antigravity)** - 代码启发与架构参考
- **[Codex](https://github.com/codex)** - 开发工具链支持
- **[OpenCode](https://github.com/opencode)** - AI 辅助编程，让开发更高效