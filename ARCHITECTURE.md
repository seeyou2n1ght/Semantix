# Semantix 核心架构与阶段交付演进 (Architecture & Delivery)

本文档归档了 Semantix 项目的前端核心架构设计与开发阶段的实现全貌。

## 1. 架构模块划分 (Architectural Breakdown)

### API 契约层 (`frontend/src/api/client.ts`, `frontend/src/api/types.ts`)
*   **通信方案**: 采用 Obsidian 原生的跨域 API `requestUrl` 全面接管了与本地/远程 Python 向量服务跨域通信的问题。
*   **接口映射**: 严格实现了 `/health` (探活)、`/ready` (就绪探针)、`/index/batch` (增量建立索引)、`/index/delete` (删除索引)、`/index/status` (索引统计)、`/index/clear/request` + `/index/clear/confirm` (两步确认清空索引) 和 `/search/semantic` (语义搜索) 核心接口以及对应的 TS 类型安全定义。
*   **Vault 维度**: 所有索引与检索请求均携带 `vault_id`，用于多 Vault 隔离与去重。
*   **安全策略**: 支持可选的 `SEMANTIX_API_TOKEN` 鉴权，以及 CORS Origin 白名单配置。
*   **相似度过滤**: 语义检索支持 `min_similarity` 参数，后端通过 LanceDB 原生 `distance_range()` 实现高效过滤。

### 设置面板 (`frontend/src/settings.ts`)
*   基于 `PluginSettingTab` 严格实现了 14 项核心配置的 UI 控制，且支持持久化存储到 `data.json`。
*   提供了交互式的 **[Test Connection]** 按钮，一键调通与 Python 后台的握手操作，结果将全局投递在侧边栏界面的指示灯上。
*   **相似度阈值配置**: 提供 Minimum Similarity Threshold 滑块（0.00-1.00），后端直接过滤低于阈值的结果。显示格式为小数（如 0.70）。
*   **颜色阈值配置**: 提供高分/中分阈值滑块，支持用户自定义分数颜色区间。
*   **可解释性配置**: Explainable Results 默认开启，因索引时分块存储已无额外性能开销。

### 增量同步调度器 (`frontend/src/core/sync.ts`)
*   **双向缓冲防抖队列**: 为 `modify`, `create`, `delete` 等操作设立独立缓冲池（`pendingUpdates`, `pendingDeletes`），并处理重命名场景。
*   **定频落盘**: 在设置中动态读取 `Sync Batch Interval` 从而不至于频繁卡死本地接口。
*   **文本一致性**: 索引端与检索端统一使用 `Markdown` 降噪后的纯文本，确保语义空间一致。

### 动态灵感发生器 - Whisperer (`frontend/src/core/whisperer.ts`)
*   **三重触发机制**:
    *   `file-open`: 文件切换时触发
    *   `editor-change`: 编辑时防抖触发（默认 2000ms）
    *   `cursor-activity`: 光标活动时触发（仅 paragraph 模式，300ms 防抖）
        *   通过 CodeMirror `ViewPlugin.fromClass` 监听 `selectionSet` 事件
        *   检测段落变化后触发检索
        *   解决阅读模式下无法触发检索的问题
*   **Markdown 去噪引擎** (`frontend/src/utils/markdown.ts`): 开发了一套纯正规的正则清理链，将复杂的 MDX/图像/前言属性摘掉，只保留最核心的内容和 `#tag` 交给后端。
*   **双链阻断 (Filtered Nodes)**: 利用 Obsidian `metadataCache.resolvedLinks`，自动识别当前文档已建立的锚点网络并不予展示。
*   **相似度过滤与颜色渲染**: 携带 `min_similarity` 参数，后端通过 LanceDB `distance_range()` 过滤；前端根据配置的阈值渲染分数颜色标签（绿/蓝/黄）。
*   **关键词高亮**: 使用 N-gram 算法提取关键词，过滤包含停用字的无意义组合，优先展示 3-gram。
*   **相似度分数显示**:
    *   分数格式：小数（0.00-1.00）
    *   分数颜色标签：绿/蓝/黄三色
    *   悬浮分数：显示简短说明（高度相关/相关/可能相关）
    *   悬浮结果：显示查询文本与匹配内容的详细对比

### 游离笔记雷达 - Orphan Radar (`frontend/src/core/radar.ts`)
*   **边缘孤岛算法**: 由于后端没有持有图谱的所有权，前端发挥主场优势，扫描 `metadataCache`，在内存里计算全局文章的**入度与出度**，找出绝对孤立块（出入度均为 0）。
*   利用主命令 `Semantix: 扫描并分析孤岛笔记` 激活雷达查询。并支持展开后发起二级语义查询。
*   **分数颜色渲染**: 与 Whisperer 共享相同的颜色阈值配置，保持视觉一致性。

### UI 视图层 (`frontend/src/ui/`)
*   **WhispererView**: 动态灵感侧边栏视图
    *   状态指示灯（连接状态）
    *   索引进度展示
    *   检索结果列表（分数标签、snippet、悬浮提示）
    *   骨架屏加载动画
*   **RadarView**: 孤岛雷达侧边栏视图
    *   孤岛笔记列表
    *   展开显示推荐连接

---

## 2. 后端架构 (Backend Architecture)

### 数据库服务 (`backend/db_svc.py`)
*   **Schema 设计**:
    ```python
    [vault_id, path, chunk_index, vector, text]
    # 复合主键: (vault_id, path, chunk_index)
    ```
*   **索引时分块存储**: 文档在 `upsert_documents` 时自动分块
    *   每个段落独立计算 embedding
    *   检索时按 path 聚合，返回最高分 chunk
*   **Snippet 处理**: 
    *   后端返回较长片段（200 字符）
    *   前端以匹配关键词为中心截取（前后各 40 字符）
    *   确保用户直接看到匹配上下文
*   **统计去重**: `count_notes` 按 path 去重，保持文档级别计数

### 分块器 (`backend/utils/chunker.py`)
*   **段落优先分块**: 按空行分割段落
*   **智能切分**: 超长段落按句子边界切分（max 500，min 50）
*   **返回结构**: `List[(chunk_text, paragraph_index)]`

### 模型服务 (`backend/model_svc.py`)
*   **异步加载**: 启动时异步加载 BGE embedding 模型
*   **懒初始化**: 首次请求时等待模型加载完成
*   **缓存优化**: 使用 normalize_embeddings 提升检索精度

---

## 3. 前端构建 (Frontend Build)

### 环境要求
- Node.js >= 18
- npm >= 9

### 构建命令

```bash
cd frontend

# 安装依赖
npm install

# 开发模式（监听文件变化，输出到 main.js）
npm run dev

# 生产构建（压缩优化）
npm run build

# 代码检查
npm run lint

# 类型检查
npx tsc --noEmit
```

### 构建配置 (`frontend/esbuild.config.mjs`)
*   使用 esbuild 进行打包
*   支持 sourcemap（开发模式）
*   自动排除 obsidian 和 electron 内置模块

### 目录结构

```
frontend/
├── src/
│   ├── api/           # API 客户端和类型定义
│   ├── core/          # 核心逻辑（whisperer, radar, sync）
│   ├── ui/            # 视图组件
│   ├── utils/         # 工具函数（markdown 降噪等）
│   ├── main.ts        # 插件入口
│   └── settings.ts    # 设置面板
├── manifest.json      # 插件清单
├── styles.css         # 样式文件
└── package.json       # 依赖配置
```

---

## 4. 交互测试验收方案

1. **环境准备**：启动 Python 端 `uv run uvicorn main:app` 后台进程。
2. **启用插件**：在 Obsidian `设置 -> 社区插件` 启用 **Semantix**。
3. **连通性校验**：点击雷达侧边栏，或在其设置中点击"测试连接"。您会看到提示气泡，并在侧栏看到圆点变为绿色 (Connected)。
4. **增量调度测试**：修改或新建文档，经过设定的 Interval 延迟后，Console 中会发出 `/index/batch` 请求。
5. **Whisperer 测试**：
    *   编辑测试：在一篇缺乏内部链接的笔记上进行编辑，右侧边栏会实时展示相近概念的历史笔记。
    *   阅读测试：点击跳转到新段落，300ms 后应触发检索（仅 paragraph 模式）。
    *   结果展示：带有相似度分数颜色标签（0.00-1.00）、关键词高亮的 snippet。
    *   悬浮提示：悬浮分数显示含义，悬浮结果显示详细对比。
6. **孤岛连通性测试**：使用 `Cmd/Ctrl + P` 呼出全局面板，输入 `Semantix Scan Orphan`。会在侧栏底部列出当前整个库的孤岛笔记（若无则显示空状态），点击展开推荐节点，分数同样带有颜色标签。

---

## 5. 关键实现细节

### N-gram 关键词提取算法

```typescript
// 提取中文 2-gram 和 3-gram，过滤包含停用字的组合
// 英文保留完整单词（>= 3 字符）
// 优先返回 3-gram，然后是 2-gram，最后是英文
```

**停用字过滤**：过滤包含"的"、"是"、"在"等停用字的 n-gram 组合，避免无意义高亮。

### Snippet 聚焦截取

```typescript
// 以第一个匹配关键词为中心
// 前后各取 40 字符
// 超出边界时添加省略号
```

### 三重触发机制

| 触发方式 | 事件 | 防抖时间 | 适用场景 |
|----------|------|----------|----------|
| 文件切换 | `file-open` | 无 | 打开新文件 |
| 编辑内容 | `editor-change` | 2000ms | 打字输入 |
| 光标活动 | CodeMirror `selectionSet` | 300ms | 阅读时点击段落 |