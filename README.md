# Semantix

Semantix 是一个面向 Obsidian 的本地语义关联插件。它由两个部分组成：

- `frontend/`: Obsidian 插件，负责监听编辑与文件事件、渲染侧边栏、发起索引与搜索请求
- `backend/`: FastAPI 后端，负责 Markdown 清洗后的文本向量化、LanceDB 索引存储、语义检索与结果聚合

项目当前版本：`v0.2.0`

## 当前能力

- 实时语义推荐 `Whisperer`
  当前文件打开、编辑或光标移动后，自动搜索语义相关的历史笔记
- 孤岛笔记扫描 `Orphan Radar`
  找出没有出链和入链的笔记，并为其推荐潜在连接目标
- 增量同步
  监听 `create / modify / rename / delete` 事件，按批次刷新索引
- 全量初始化索引
  在插件设置页触发对当前 Vault 的全量索引，并在两个侧栏展示进度
- 可解释结果
  后端按 chunk 建索引，前端展示高相关 snippet，并高亮关键词
- 已链接笔记过滤
  Whisperer 可排除当前笔记已链接的文件，减少重复推荐
- 移动端休眠
  默认在移动端停用，避免不必要的电量与性能开销

## 系统结构

```text
Obsidian Plugin (frontend)
  ├─ settings.ts             插件设置
  ├─ main.ts                 插件入口与生命周期
  ├─ core/whisperer.ts       实时搜索触发逻辑
  ├─ core/radar.ts           孤岛笔记扫描与推荐
  ├─ core/sync.ts            文件变更批量同步
  ├─ ui/whisperer-view.ts    Whisperer 侧栏
  ├─ ui/radar-view.ts        Radar 侧栏
  └─ api/client.ts           与后端通信

FastAPI Backend (backend)
  ├─ main.py                 API 入口
  ├─ models.py               请求/响应模型
  ├─ model_svc.py            SentenceTransformer 模型加载与编码
  ├─ db_svc.py               LanceDB 索引与检索
  └─ utils/chunker.py        标题感知切块
```

## 工作方式

### 1. 索引链路

1. 前端监听 Vault 文件变化
2. 前端读取 Markdown 并执行清洗
3. `SyncManager` 按批次调用 `POST /index/batch`
4. 后端按段落与标题层级切块
5. 后端用 `BAAI/bge-small-zh-v1.5` 生成 embedding
6. 后端写入 LanceDB，并按 `vault_id + path` 维护索引

### 2. 搜索链路

1. `Whisperer` 在 `file-open`、`editor-change`、`cursor-activity` 时触发
2. 前端抽取当前段落或全文，并排除当前文件与可选的已链接文件
3. 后端为查询文本补上 BGE 检索指令前缀后编码
4. LanceDB 执行向量检索
5. 后端把 chunk 结果聚合为文档结果，返回分数、路径、snippet
6. 前端渲染侧边栏、关键词高亮与分数颜色标签

### 3. 孤岛扫描链路

1. 前端直接读取 `app.metadataCache.resolvedLinks`
2. 统计每个 Markdown 文件的出链与入链
3. 选出总链接数为 `0` 的笔记
4. 展开某个孤岛项时，再调用语义搜索获取推荐连接目标

## API 概览

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查；模型未加载完时返回 `loading` |
| `GET` | `/ready` | 就绪检查；模型可用时返回 `ready` |
| `GET` | `/metrics` | 返回索引与搜索计数、最近耗时 |
| `GET` | `/index/status` | 返回某个 `vault_id` 的已索引笔记数 |
| `POST` | `/index/batch` | 批量写入或更新文档 |
| `POST` | `/index/delete` | 按路径删除索引 |
| `POST` | `/index/clear/request` | 请求清空索引确认 token |
| `POST` | `/index/clear/confirm` | 使用 token 确认清空索引 |
| `POST` | `/search/semantic` | 语义搜索 |

说明：

- 当前没有独立的 `/index/full` 接口。全量索引由前端分批调用 `/index/batch` 实现。
- 当前没有 BM25、混合检索、cross-encoder rerank。

## 快速开始

### 1. 启动后端

要求：

- Python `>= 3.11`
- `uv`

```bash
git clone https://github.com/seeyou2n1ght/Semantix.git
cd Semantix/backend
uv sync
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```

首次启动时，`sentence-transformers` 会下载 `BAAI/bge-small-zh-v1.5`，因此 `/health` 可能短时间返回 `loading`。

### 2. 构建并安装 Obsidian 插件

```bash
cd Semantix/frontend
npm install
npm run build
```

把以下文件复制到：

```text
<your-vault>/.obsidian/plugins/obsidian-semantix/
```

需要复制的文件：

- `frontend/main.js`
- `frontend/manifest.json`

说明：当前仓库没有单独的 `styles.css` 构建产物。

### 3. 配置插件

在 Obsidian 中启用插件后，进入设置页配置：

- `Backend API URL`
- `API Token`，如果后端启用了 `SEMANTIX_API_TOKEN`

然后点击 `Test Connection`。

### 4. 初始化当前 Vault 索引

在插件设置页点击“初始化向量索引”后，插件会：

- 枚举当前 Vault 的 Markdown 文件
- 按排除规则过滤
- 每批 `50` 篇调用一次 `/index/batch`
- 在两个侧栏同步展示索引进度

## 配置项

### 插件设置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `Backend API URL` | `http://localhost:8000` | 后端地址 |
| `API Token` | 空 | 对应后端 `SEMANTIX_API_TOKEN` |
| `Whisperer Scope` | `paragraph` | `paragraph` 或 `document` |
| `Debounce Delay` | `2000` | 编辑触发搜索的防抖时间，单位毫秒 |
| `Sync Batch Interval` | `60` | 增量同步批次间隔，单位秒 |
| `Exclusion Rules` | 空 | 每行一个前缀规则，例如 `Templates/` |
| `Filter Linked Notes` | `true` | 搜索时排除当前笔记已链接目标 |
| `Top N Results` | `5` | 返回结果数量 |
| `Minimum Similarity Threshold` | `0.70` | 最低相似度过滤 |
| `High Score Threshold` | `0.85` | 高分阈值，显示绿色 |
| `Medium Score Threshold` | `0.75` | 中分阈值，显示蓝色 |
| `Explainable Results` | `true` | 展示最相关 snippet |
| `Enable on Mobile` | `false` | 是否在移动端启用 |

### 后端环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SEMANTIX_API_TOKEN` | 空 | 启用简单 token 鉴权 |
| `SEMANTIX_ALLOWED_ORIGINS` | `http://localhost,http://127.0.0.1,app://obsidian.md,capacitor://localhost` | CORS 白名单 |
| `SEMANTIX_LOG_LEVEL` | `INFO` | 日志级别 |
| `SEMANTIX_DB_PATH` | `./semantix.db` | LanceDB 数据目录 |

说明：`SEMANTIX_DB_PATH` 建议使用明确的目录路径，例如 `D:\Semantix\data\semantix-lance` 或 `/var/lib/semantix/lancedb`。

## 当前实现细节

### Markdown 清洗

前端在发送文本前会做一次轻量清洗，去掉：

- YAML frontmatter
- 代码块与行内代码
- 图片与嵌入
- HTML 标签
- Markdown 格式符号

同时会保留普通链接文字与双链别名，以尽量保留语义内容。

### 切块策略

后端切块不是简单的全文 embedding：

- 按空行拆 parent chunk
- 识别最近的 Markdown 标题层级
- 将 `文件名 + 最近标题` 注入 child chunk 的 embedding 文本
- 结果存储为：
  - `text`: parent chunk
  - `child_text`: 实际用于定位的子块

搜索时先按 child chunk 找到最相关片段，再聚合回文档级结果。

### Vault 隔离

前端根据 `vault name + base path` 计算稳定的 `vaultId` 哈希值，并随所有请求发送。后端索引与查询都按 `vault_id` 做隔离。

## 开发

### 前端

```bash
cd frontend
npm install
npm run dev
npm run build
npm run lint
```

### 后端

```bash
cd backend
uv sync
uv run uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

## 已知边界

- 搜索目前是纯向量检索，不包含关键词倒排召回
- 排除规则当前是“按路径前缀匹配”，不是完整 glob 或正则
- 模型与数据库都运行在本地，首次模型加载可能较慢
- 文档中的“未来计划”以 [FEATURE_ROADMAP.md](./FEATURE_ROADMAP.md) 为准

## 相关文档

- [部署说明](./DEPLOYMENT.md)
- [路线图与当前状态](./FEATURE_ROADMAP.md)
- [前端开发说明](./frontend/README.md)

## License

MIT
