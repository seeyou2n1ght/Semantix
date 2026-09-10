# API 接口参考

Semantix 后端通过 REST API 提供服务。所有涉及数据的请求均需携带 `X-Vault-Id` 头部以支持多库隔离。

## 1. 基础系统 (System)

### `GET /health`
- **用途**：健康检查。
- **响应**：
  - `{"status": "ok"}`：系统完全正常。
  - `{"status": "loading"}`：系统正在初始化（通常是在加载权重模型）。

### `GET /ready`
- **用途**：就绪检查。
- **响应**：模型加载完成后返回 `200`，否则返回 `503`。

### `GET /ping`
- **用途**：活跃心跳。
- **功能**：由前端插件定期调用，用于更新后端的“最后活跃时间”。配合后端的“看门狗”监控线程，若 120 秒内未收到 ping 信号且父进程 PID 失效，后端将自动执行优雅退出。

### `GET /metrics`
- **用途**：获取当前运行指标，包括总索引文档数、最近搜索耗时等。

---

## 2. 索引管理 (Indexing)

### `GET /index/status`
- **参数**：`vault_id` (Query)
- **用途**：查询当前 Vault 已索引文档总数。
- **响应**（v0.7.0 新增 `vault_stopwords` 字段）：
  ```json
  { "total_notes": 232, "last_updated": "...", "vault_id": "...", "vault_stopwords": ["笔记", "内容", ...] }
  ```

### `POST /index/batch`
- **用途**：批量写入或更新文档。
- **Payload**：
  ```json
  { "documents": [{ "vault_id": "...", "path": "file.md", "text": "..." }] }
  ```

### `POST /index/delete`
- **用途**：按路径删除索引项。

### `POST /index/clear/request` & `/confirm`
- **功能**：两步确认清空整个索引库。

### `POST /index/compute-stopwords` (v0.7.0 新增)
- **用途**：触发仓库词频分析，识别高频噪音词。
- **Payload**：
  ```json
  { "vault_id": "..." }
  ```
- **响应**：
  ```json
  { "status": "success", "count": 42, "words": ["笔记", "内容", "工具", ...] }
  ```
- **说明**：分析结果会持久化到后端 `custom_stopwords.json`，后续通过 `/index/status` 自动同步到前端。

---

## 3. 语义雷达接口 (Radar Search)

### `POST /search/radar` (核心双流接口)
- **用途**：统一双流检索入口，无状态返回 Related（强相关）与 Discover（意外关联）双卡片集合。
- **Header**:
  - `X-Vault-Id`: `<vault-hash>`（必需）
  - `X-Semantix-Token`: `<token>`（可选，启用鉴权时必需）
- **Request Body**:
  ```json
  {
    "query": "当前聚焦的句子或段落文本",
    "vault_id": "8f3a12b4",
    "context": {
      "focus_text": "当前光标所在块内容",
      "active_heading": "当前三级标题",
      "note_title": "卡片盒笔记法实践",
      "note_path": "Inbox/Zettelkasten.md",
      "cursor_line": 42,
      "cursor_col": 15,
      "outgoing_links": ["写作方法", "卢曼"],
      "tags": ["pkm", "workflow"],
      "mode": "focus"
    },
    "context_id": "ctx-1725940000000-abcd",
    "top_k_related": 4,
    "top_k_discover": 4,
    "exclude_paths": ["Inbox/Zettelkasten.md"],
    "ranking_mode": "balanced"
  }
  ```
- **参数说明**:
  | 字段 | 类型 | 说明 |
  | :--- | :--- | :--- |
  | `query` | string | 查询主文本（自动拼接 BGE 检索前缀） |
  | `vault_id` | string | 逻辑仓库隔离哈希标识 |
  | `context` | object | 客户端采集的编辑器上下文（用于模式识别、结构加权与父子块回溯） |
  | `context_id` | string | 前端生成的唯一请求会话 ID，后端原样 Echo |
  | `top_k_related` | int | Related 流最大返回条数（默认 4） |
  | `top_k_discover` | int | Discover 流最大返回条数（默认 4） |
  | `exclude_paths` | list[str] | 排除路径列表（强制包含当前笔记路径） |
  | `ranking_mode` | string | 精排策略：`fast`（关闭精排）、`balanced`（Top 12 精排）、`high_quality`（Top 25 全量精排） |

- **Response Body**:
  ```json
  {
    "related": [
      {
        "path": "Notes/Luhmann_Slipbox.md",
        "title": "Luhmann_Slipbox",
        "snippet": "...卡片盒系统的核心在于给思考以物理外包，通过双向链接形成意料之外的网络...",
        "score": 0.88,
        "stream": "related",
        "labels": ["DIRECT_LINK", "HIGH_RELEVANCE"],
        "matched_chunk_index": 2
      }
    ],
    "discover": [
      {
        "path": "Philosophy/Emergence_Theory.md",
        "title": "Emergence_Theory",
        "snippet": "...简单规则在大量节点的局部互动下，自发涌现出全局层面的宏观有序结构...",
        "score": 0.65,
        "stream": "discover",
        "labels": ["CROSS_TOPIC", "SPARK"],
        "matched_chunk_index": 0
      }
    ],
    "context_id": "ctx-1725940000000-abcd",
    "meta": {
      "total_candidates": 45,
      "duration_ms": 32.5,
      "ranking_mode": "balanced"
    }
  }
  ```

---

## 4. 向后兼容接口 (Legacy Adapter)

### `POST /search/semantic`
- **用途**：单流检索兼容适配器，内部转发至 `RadarPipeline` 并映射为旧版结构。
- **参数**：`text`, `vault_id`, `top_k`, `min_similarity`, `exclude_paths`, `current_path`, `current_tags`, `current_links`, `rerank`
- **响应**：包含 `path`, `score`, `snippet`, `reasons`, `score_details`。

---

## 5. 运维与维护 (Maintenance)

### `POST /maintenance/run`
- **用途**：触发 LanceDB 碎片合并与多版本数据修剪。
- **参数**：
  ```json
  { "retention_days": 7, "vault_id": "default" }
  ```
- **响应**：`{"status": "ok", "message": "Database optimization completed."}`

---

## 6. 鉴权机制 (Authentication)

当设置环境变量 `SEMANTIX_API_TOKEN` 时，除 `/health`, `/ready`, `/ping` 外，所有接口强制要求携带 Header：
`X-Semantix-Token: <your-token>`
鉴权失败时返回 `401 Unauthorized`。
