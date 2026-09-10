# 系统架构设计

Semantix 采用「边缘监听 + 本地伴生计算 (Local Sidecar)」架构，将重量级自然语言处理 (NLP) 计算解耦至独立的 FastAPI 后端进程。

---

## 1. 系统拓扑 (System Topology)

```text
+-----------------------------------------------------------------------+
|                         Obsidian 前端 (TypeScript)                    |
|                                                                       |
|  [Active Editor]                                                      |
|         │ (Cursor / Selection)                                        |
|         ▼                                                             |
|  [ContextEngine] ──────► [QueryChangeGate] ──(400ms/Punct/Len)───────┐|
|  (Focus / Note Mode)                                                 │|
|                                                                      ▼|
|  [WhispererView] ◄────── [ResultStabilizer] ◄── [Versioning / Echo] ──┤|
|  (Fixed 78px Card)       (IN_NOTE / CROSS_NOTE)                       │|
|         │                                                             │|
|  [PopoverPreview] (Hover Context / Link Copy)                         │|
+───────────────────────────────────┬───────────────────────────────────+
                                    │ HTTP REST (X-Vault-Id, context_id)
                                    ▼
+───────────────────────────────────────────────────────────────────────+
|                         FastAPI 后端 (Python 3.11+)                   |
|                                                                       |
|  [main.py] ── POST /search/radar (Stateless Echo: context_id)         |
|      │                                                                |
|      ▼                                                                |
|  [RadarPipeline] (services/radar_service.py)                          |
|      │                                                                |
|      ├──► [RetrievalService] (粗排: Vector + FTS Top 45 -> Top 25)    |
|      │        └──► [LanceDBStorage] (物理引擎: LanceDB)                |
|      │                                                                |
|      ├──► [Ranking Pipeline] (services/ranking/)                      |
|      │        ├── [ScoreNormalizer] (Min-Max 动态极值与量纲校准)       |
|      │        ├── [RelatedRanker]   (Cross-Encoder 精排 + 结构提权)   |
|      │        ├── [DiscoverRanker]  (Relevance Gate + 排除 Related)   |
|      │        ├── [MMRSelector]     (贪心最大边际相关内部打散)         |
|      │        └── [LabelGenerator]  (动态生成推荐依据标签)             |
|      │                                                                |
|      ├──► [EmbeddingService] (BGE-Small-zh-v1.5 单例服务)             |
|      └──► [RerankerService]  (BGE-Reranker-Base 弹性精排单例)          |
+-----------------------------------------------------------------------+
```

---

## 2. 核心模块分层

### 前端分层 (`frontend/src/`)
- `core/context.ts`: **ContextEngine**。提取 Focus 模式（光标当前块 + 标题）与 Note 模式（前 N 块代表向量），输出 `RadarContext` 与 `ContextTransitionType`。
- `core/query-gate.ts`: **QueryChangeGate**。400ms 防抖门控，过滤空白与标点变动，保障 1500ms 最大等待时间（MaxWait）。
- `core/result-stabilizer.ts`: **ResultStabilizer**。双策略抗抖：
  - `IN_NOTE`: 保持旧卡片顺序，微调分数，锁定标题与元数据，禁止卡片乱跳。
  - `CROSS_NOTE`: 立即清空并重置结果集。
- `core/whisperer.ts`: 整合调度单调递增的 `currentSearchId` 与 `activeContextId`，拦截网络迟到响应。
- `ui/whisperer-view.ts`: 单侧栏渲染双流卡片，固定高度 78px 避免布局位移，点击原位打开并定位高亮段落。
- `ui/popover-preview.ts`: 悬浮卡片触发浮层上下文预览与链接复制。

### 后端分层 (`backend/`)
- `storage/lancedb_storage.py`: LanceDB 物理存储引擎，提供基于 `X-Vault-Id` 的多库隔离与 FTS 索引管理。
- `services/embedding_service.py`: 文本向量化单例，自动注入检索前缀 `为这个句子生成表示以用于检索相关文章：`。
- `services/reranker_service.py`: Cross-Encoder 精排模型单例，支持 fast/balanced/high_quality 运行时策略。
- `services/retrieval_service.py`: 粗排混合召回服务（Vector + FTS Top 45 -> 聚合为 Top 25 候选）。
- `services/index_service.py`: 笔记 Markdown AST 切分与批处理入库。
- `services/ranking/`: 归一化、Related 精排、Discover MMR 打散与标签生成。
- `db_svc.py`, `model_svc.py`, `reranker_svc.py`: 保持轻量 Facade，保证向后兼容。

---

## 3. 库隔离机制 (Vault Isolation)

1. **标识生成**：前端根据 `Vault Name` + `Vault Base Path` 计算 32 位 FNV-1a 稳定哈希。
2. **请求绑定**：所有 API 请求头携带 `X-Vault-Id: <hash>`。
3. **数据隔离**：后端 LanceDB 在全部写入与检索语句中强制拼接 `vault_id = '...'` 条件，实现物理表内的逻辑库隔离。

---

## 4. 并发与竞态控制 (Concurrency Control)

1. **Search Versioning**: 每次发起检索时前端递增 `currentSearchId`，响应返回时必须与当前活跃 ID 强匹配，迟到响应直接废弃。
2. **Stateless Echo**: 前端生成全局唯一 `context_id` 传递给后端，后端计算完成后原样 Echo，前端用于校验上下文归属。
3. **Watchdog 伴生保活**: 后端内置看门狗线程，监控心跳（`GET /ping`）与 Obsidian 父进程 PID。心跳超时或宿主异常终止时，伴生进程执行优雅自毁。


