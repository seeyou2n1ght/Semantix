# Semantix 核心架构与阶段交付演进 (Architecture & Delivery)

本文档归档了 Semantix 项目的前端核心架构设计与开发阶段的实现全貌。

## 1. 架构模块划分 (Architectural Breakdown)

### 📦 API 契约层 (`src/api/client.ts`, `src/api/types.ts`)
*   **通信方案**: 采用 Obsidian 原生的跨域 API `requestUrl` 全面接管了与本地/远程 Python 向量服务跨域通信的问题。
*   **接口映射**: 严格实现了 `/health` (探活)、`/index/batch` (增量建立索引)、`/index/delete` (删除索引) 和 `/search/semantic` (语义搜索) 四个核心接口以及对应的 TS 类型安全定义。

### ⚙️ 设置面板 (`src/settings.ts`)
*   基于 `PluginSettingTab` 严格实现了 8 项核心配置的 UI 控制，且支持持久化存储到 `data.json`。
*   提供了交互式的 **\[测试连接\]** 按钮，一键调通与 Python 后台的握手操作，结果将全局投递在侧边栏界面的指示灯上。

### 🔄 增量同步调度器 (`src/core/sync.ts`)
*   **双向缓冲防抖队列**: 为 `modify`, `create`, `delete` 等操作设立独立缓冲池（`pendingUpdates`, `pendingDeletes`），并处理重命名场景。
*   **定频落盘**: 在设置中动态读取 `Sync Batch Interval` 从而不至于频繁卡死本地接口。

### 🎙️ 动态灵感发生器 - Whisperer (`src/core/whisperer.ts`)
*   **打字机监听**: 与 Obsidian 第一公民事件 `editor-change` 双边挂载，在后台结合防抖（Debounce）执行。
*   **Markdown 去噪引擎** (`src/utils/markdown.ts`): 开发了一套纯正规的正则清理链，将复杂的 MDX/图像/前言属性摘掉，只保留最核心的内容和 `#tag` 交给后端。
*   **双链阻断 (Filtered Nodes)**: 利用 Obsidian `metadataCache.resolvedLinks`，自动识别当前文档已建立的锚点网络并不予展示。

### 📡 游离笔记雷达 - Orphan Radar (`src/core/radar.ts`)
*   **边缘孤岛算法**: 由于后端没有持有图谱的所有权，前端发挥主场优势，扫描 `metadataCache`，在内存里计算全局文章的**入度与出度**，找出绝对孤立块（出入度均为 0）。
*   利用主命令 `Semantix: 扫描并分析孤岛笔记 (Scan Orphan Notes)` 激活雷达查询。并支持展开后发起二级语义查询。

---

## 2. 交互测试验收方案

1. **环境准备**：启动 Python 端 `uv run uvicorn main:app` 后台进程。
2. **启用插件**：在 Obsidian `设置 -> 社区插件` 启用 **Semantix**。
3. **连通性校验**：点击雷达侧边栏，或在其设置中点击“测试连接”。您会看到提示气泡，并在侧栏看到圆点变为绿色 (Connected)。
4. **增量调度测试**：修改或新建文档，经过设定的 Interval 延迟后，Console 中会发出 `/index/batch` 请求。
5. **Whisperer 测试**：在一篇缺乏内部链接的笔记上进行编辑时，右侧边栏会实时展示相近概念的历史笔记，并带有相似度 Score，点击即可跳转打开。
6. **孤岛连通性测试**：使用 `Cmd/Ctrl + P` 呼出全局面板，输入 `Semantix Scan Orphan`。会在侧栏底部列出当前整个库的孤岛笔记（若无则显示空状态），点击💡展开推荐节点。
