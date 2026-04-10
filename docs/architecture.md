# 系统架构设计

Semantix 采用经典的「边缘监听 + 本地计算」架构，将复杂的自然语言处理（NLP）工作从 Obsidian 核心进程解耦到独立的后端服务中。

## 1. 整体结构 (Architecture)

```text
Obsidian (UI/Event) <--- REST API (CORS) ---> FastAPI (Computation)
        |                                       |
  [Plugin Logic]                          [Vector Logic]
        |                                       |
  [Local Files]                           [LanceDB Storage]
```

### 插件端 (Frontend)
- **Settings**: 管理连接、同步频率与排除规则。
- **SyncManager**: 维护增量同步队列，负责清洗并向后端推送数据。
- **Engines (Whisperer / Radar)**: 业务逻辑核心，处理光标追踪与孤岛分析。
- **Views**: 侧边栏 UI，基于 Vanilla JS/CSS 构建。

### 后端服务 (Backend)
- **FASTAPI**: 处理高并发请求。
- **Model Service**: 封装了 Sentence-Transformers，负责将文本转化为 512 维向量。
- **Reranker Service**: [新] 封装 Cross-encoder 模型，对初步召回结果进行精排。
- **Database Service**: 封装 LanceDB，处理向量搜索、FTS 以及支持父子块索引的复杂聚合。

---

## 2. 库隔离机制 (Vault Isolation)

为了支持在多个 Obsidian 仓库（Vault）中无缝切换且不干扰索引，我们实现了哈希隔离：
1. **标识生成**：前端根据 `Vault Name` + `Vault Base Path` 计算出稳定的 32 位 FNV-1a 哈希。
2. **请求绑定**：所有 API 请求头中均携带 `X-Vault-Id`。
3. **后端过滤**：LanceDB 在查询时会自动追加 `WHERE vault_id = '...'` 条件，实现逻辑层面的库隔离。

---

## 3. 代码组织

- `frontend/src/core/`: 存放无状态的业务逻辑算法。
- `frontend/src/ui/`: 存放视图渲染逻辑。
- `frontend/src/styles.css`: 样式源文件（由 esbuild 编译至根目录）。
- `backend/db_svc.py`: 检索算法、RRF 融合与数据库交互。
- `backend/model_svc.py`: 向量模型生命周期管理。
- `backend/reranker_svc.py`: [新] 精排模型生命周期管理。
- `backend/utils/chunker.py`: 基于 Markdown AST 的文本切分逻辑。

---

## 4. 性能与稳定性

### 并发行控制 (Race Condition Prevention)
在「Whisperer」实时检索场景下，为了防止用户快速输入或连跳光标导致的网络请求竞态冲突，我们实现了 **Search Versioning** 机制：
1. **版本标记**：每次触发 API 请求前，逻辑层递增 `currentSearchId`。
2. **闭包捕获**：异步请求通过闭包捕获发起时的 `searchId`。
3. **合法性检查**：当 Promise 返回后，对比捕获的 ID 与全局最新 ID。只有一致时才进行 UI 渲染，过时的结果将被静默丢弃。

### UI 渲染策略
- **样式解耦**：所有交互逻辑与视觉样式通过 CSS Class 解耦。状态切换（如 `is-connected`）由 CSS 动画驱动，避免了大量的 DOM 样板代码，提升了渲染性能。

