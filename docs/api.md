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

---

## 3. 搜索接口 (Search)

### `POST /search/semantic`
- **用途**：最核心的检索接口。
- **参数**：
  - `text`: 查询文本。
  - `vault_id`: 目标库哈希。
  - `top_k`: 返回结果数量。
  - `min_similarity`: 最低相似度阈值。
  - `exclude_paths`: 需要排除的文件路径列表。
  - `current_path`: [新] 当前活动笔记路径，用于开启目录亲和度加权 (Path Boost)。
  - `rerank`: [新] 是否开启 Cross-encoder 精排重排 (默认开启)。
- **响应**：包含 `path` (路径), `score` (分数), `snippet` (上下文片段) 的结果列表。

### `POST /maintenance/run`
- **用途**：手动触发数据库碎片整理与旧版本清理。
- **参数**：
    - `retention_days`: (int) 保留的历史版本天数。
- **响应**：`{"status": "ok", "message": "..."}`

---

## 4. 鉴权
如果后端环境变量设置了 `SEMANTIX_API_TOKEN`，所有非健康检查请求必须包含以下 Header：
`X-Semantix-Token: <your-token>`
