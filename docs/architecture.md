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
- **Database Service**: 封装 LanceDB，处理向量搜索与 FTS 倒排索引的高性能混合查询。

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
- `backend/db_svc.py`: 检索算法与数据库交互。
- `backend/model_svc.py`: 模型生命周期管理。
- `backend/utils/chunker.py`: 文本切分策略。
