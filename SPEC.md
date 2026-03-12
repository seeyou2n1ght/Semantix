# 产品规格说明书 (SPEC)：Obsidian Semantix (语义雷达) 插件

**版本:** v0.2.0 Draft
**目标平台:** Obsidian Desktop (Windows/macOS/Linux), Mobile (iOS/Android 降级运行)
**核心定位:** 基于本地大模型与向量数据库的隐式知识链接发现工具。

---

## 1. 项目概述 (Overview)

Semantix 是一款 Obsidian 侧边栏插件。它通过打通 Obsidian 前端与本地部署的向量数据库（Vector DB）及大语言模型（LLM），在不干扰用户正常写作的前提下，自动发现笔记库中“语义相近但缺乏显式链接”的知识节点，提供动态灵感提示并拯救孤岛笔记。

---

## 2. 系统架构 (Architecture)

采用“端云分离（或端+本地服务器）”的 C/S 架构设计，确保 Obsidian 前端的轻量化。

### 2.1 前端 (Obsidian Plugin)
负责 UI 渲染、文档解析（Markdown 降噪）、事件监听（键盘输入防抖、文件变更、视图切换）以及 HTTP API 请求（使用 `requestUrl` 以避开 CORS 限制）。

### 2.2 后端 (Local AI Backend)
独立于 Obsidian 运行的 HTTP 服务（负责接收文本、调用模型、访问数据库）。**强烈推荐部署于 Raspberry Pi 5 等本地设备的方案：**
*   **API 框架**: 推荐使用 **FastAPI (Python)**。轻量、极速，与 AI 模型及向量数据库的 Python 生态无缝整合。
*   **Embedding 模型**: 推荐使用 **BGE (`bge-small-zh-v1.5`)**，专为中文语义优化，轻量且准确（树莓派 CPU 可流畅推理）。
*   **向量数据库**: 推荐使用 **LanceDB**。作为嵌入式 Serverless 向量库，无需后台驻留进程，纯 Python 环境下可跨平台（Windows/Linux/ARM）完美运行。

### 2.3 API 接口契约 (API Contract Draft)
*   **`GET /health`**: 探活接口，返回后端状态。
*   **`GET /ready`**: 就绪探针，返回模型是否加载完成。
*   **`GET /metrics`**: 运行指标输出（索引与检索计数、耗时）。
*   **`POST /index/batch`**: 批量写入/更新笔记 embedding。参数：`[{vault_id, path, text}]`。
*   **`POST /index/delete`**: 删除指定路径的 embedding。参数：`{vault_id, paths}`。
*   **`GET /index/status`**: 获取索引统计。参数：`vault_id` (query)。
*   **`POST /index/clear/request`**: 请求清空索引，返回确认 token（两步确认机制）。
*   **`POST /index/clear/confirm`**: 使用 token 确认清空索引。
*   **`POST /search/semantic`**: 语义检索。参数：`{vault_id, text, top_k, exclude_paths, min_similarity}`。

---

## 3. UI 与交互设计 (UI/UX Design)

插件的所有核心交互均集中在 Obsidian 的右侧边栏 (Right Sidebar `ItemView`) 中，包含三个主要视觉区域：

### 3.1 状态指示灯 (Connection Status Indicator)
*   **位置**: 侧边栏顶部常驻。
*   **视觉规范**:
    *   🟢 Connected: 后端 API 连通且模型就绪。
    *   🟡 Syncing/Connecting: 正在进行全量/增量索引，或正在建立连接。
    *   🔴 Disconnected: 后端服务不可用，插件主动挂起所有耗时请求。
*   **交互逻辑**: 启动时自动探活，随后通过轻量级轮询维持状态。断开时自动暂停下游核心功能的触发。

### 3.2 动态面板区 (Dynamic View Area)
使用 Tab 或手风琴折叠菜单 (Accordion) 在两个核心功能之间切换：**Real-time Whisperer** 和 **Orphan Radar**。

---

## 4. 核心功能规范 (Core Features)

### 4.1 模块一：动态灵感 (Real-time Whisperer)
**描述:** 根据用户当前阅读或编辑的内容，实时推荐语义相关的历史笔记。

*   **双重触发机制 (Dual Triggers)**:
    1.  **主动浏览 (`file-open`)**: 用户切换活动文件时立即提取当前全文/段落并触发检索。
    2.  **输入防抖 (`editor-change`)**: 用户在输入时，停止打字指定时间（如 2000ms）后触发检索。
*   **上下文提取范围 (Context Scope)**:
    根据用户设置，提取通过光标获取的当前段落 (Current Paragraph) 或当前全文 (Current File)。段落边界定义为连续的空行（即标准的 Markdown block）。
*   **降噪与预处理 (Markdown Cleaning)**:
    在发送 embedding 前在前端进行清洗。
    *   **去除**: YAML Header、代码块 (`````)、图片/嵌入语法 (`![[]]`)、Markdown 格式符 (`**`, `>` 等)。
    *   **转换**: 双向链接语法 `[[target|alias]]` 仅保留 `alias` 或 `target` 的纯文本。
    *   **保留**: 标签 (`#tag`) 作为重要语义关键词保留。
*   **展示与过滤**:
    *   列表形式展示后端返回的 Top N 结果（标题 + 分数 + 摘要）。
    *   分数语义为"相似度"，数值越大越相似。
    *   **相似度阈值截断**: 用户可设置 Minimum Similarity Threshold（默认 0.70），低于此分数的结果将被过滤，后端通过 LanceDB 原生 `distance_range()` 实现，宁缺毋滥。
    *   **分数颜色标签**: 每个结果卡片显示百分比分数，并根据阈值显示不同颜色：
        *   绿色 (>= 高分阈值，默认 0.85)：高度相关
        *   蓝色 (>= 中分阈值，默认 0.75)：中度相关
        *   黄色 (< 中分阈值)：边缘相关
    *   **已链接过滤**: 若设置中开启了过滤开关，插件需分析当前文件已拥有的内部链接，并在推荐结果中将其剔除。若有剔除，在列表底部显示小字提示（例：*已过滤 2 篇已知链接笔记*）。
    *   **操作**: 点击卡片调用 `app.workspace.openLinkText` 打开目标笔记。

### 4.2 模块二：孤岛笔记雷达 (Orphan Node Rescuer)
**描述:** 找出没有任何 `[[ ]]` 双向链接的笔记，并基于全文语义向用户推荐连接。

*   **孤岛判定标准**: 利用 `app.metadataCache`，兼顾 `links` (出度) 和 `backlinks` (入度) 属性。可适当提供“半孤岛”阈值设置（如总链接数 ≤ 1）。
*   **交互逻辑**:
    *   侧边栏列出所有孤岛笔记的标题。
    *   点击某篇孤岛笔记，展开显示 Top N 的推荐连接节点。
    *   **操作**: 提供点击跳转功能，便于用户前往孤岛笔记自行决定如何添加链接。（暂不提供自动化修改文档文本插入链接的功能）。

---

## 5. 索引与同步生命周期 (Indexing Lifecycle)

保持本地知识库与向量数据库的一致性是系统有效运转的核心。

### 5.1 首次全量索引 (Initial Full Indexing)
*   插件启动并首次成功连接后端时（例如安装后配置好 URL 时），需检测后端是否已有当前 Vault 的记录。
*   若无记录，**弹窗提示**用户：“Semantix 已连接，是否开始构建知识图谱语义索引？（耗时取决于笔记数量）”。用户点击确认后开始。

### 5.2 增量批量同步 (Batched Incremental Sync)
*   **监听事件**: `vault.on('modify')`, `'create'`, `'delete'`, `'rename'`。
*   **批量策略**: 监听触发后不立即发送请求，而是将变更推入队列（Queue）。利用防抖/定时器（如每隔 60 秒，取决于设置项 `syncInterval`）将队列中的操作打包（Batch）发给后端，降低 API 调用频次。

### 5.3 灵活的排除规则 (Flexible Exclusions)
*   利用 Glob 模式（或正则）匹配文件路径，排除不需要进行语义分析的文件。
*   **默认建议支持**: 特定文件夹（如附件目录、Templates 文件夹、配置文件夹）、特定前缀/后缀。匹配成功的文件会被跳过提取与索引。

---

## 6. 配置选项卡 (Settings Tab)

提供丰富的自定义选项（保存在 `data.json`）：

1.  **Backend API URL**: 本地或远程后端服务的接口地址。并提供 `[Test Connection]` 测试按钮。
2.  **API Token**: 后端鉴权令牌（可选，若后端开启则需填写）。
3.  **Whisperer Scope**: 动态灵感的作用域下拉菜单 (Current Paragraph 或 Current File)。
4.  **Debounce Delay**: 输入防抖延迟毫秒数 (500ms - 5000ms)。
5.  **Sync Batch Interval**: 增量同步批量发送的间隔秒数 (如 30s 到 300s)。
6.  **Exclusion Rules**: 多行文本框，每行一个需要排除索引的路径模式 (Glob)。
7.  **Filter Linked Notes**: Token 过滤开关，是否在推荐列表中隐藏当前笔记已链接过的文件。
8.  **Top N Results**: 呈现的最大相关笔记数量。
9.  **Minimum Similarity Threshold**: 最低相似度截断值（0.00-1.00，默认 0.70），低于此分数的结果将被后端过滤。
10. **High Score Threshold (Green)**: 高分颜色阈值（默认 0.85），相似度 >= 此值显示绿色。
11. **Medium Score Threshold (Blue)**: 中分颜色阈值（默认 0.75），相似度 >= 此值显示蓝色，否则显示黄色。
12. **Enable on Mobile**: 移动端强制工作开关。
13. **Vault ID**: 自动生成的 Vault 标识（基于 vault path 哈希）。

---

## 7. 多端与降级策略 (Cross-Platform Strategy)

实施严格的优雅降级，防止由于配置同步导致移动端耗电或报错。

*   **平台探针**: 使用 `Platform.isMobile` 检测设备属性。
*   **阻断逻辑**: 若处于移动端且 `Enable on Mobile` 为关闭状态：
    1.  不注册 `editor-change` 事件和文件监控事件。
    2.  不执行探活轮询。
    3.  侧边栏面板渲染静态提示语：“Semantix is hibernating on mobile.”。

---

## 8. 未来演进路线 (Roadmap)
以下功能不在 MVP (v0.2.0) 范围内，但作为未来版本的储备扩展点：

*   **高级后端管理接口（已实现）**:
    *   `GET /index/status`: 获取后端当前已索引的笔记总数、最终同步时间等统计信息，用于前端更精准的状态展示。
    *   `GET /ready`: 就绪探针，检测模型是否加载完成。
    *   **一键重建索引（两步确认）**: 通过 `/index/clear/request` + `/index/clear/confirm` 实现安全的清空操作。
*   **相似度过滤与可视化（已实现）**:
    *   `min_similarity` 参数支持后端通过 LanceDB 原生 `distance_range()` 过滤低相关结果。
    *   分数颜色标签：根据用户配置的阈值区间显示绿/蓝/黄三色。
*   **孤岛雷达专属检索优化**: 根据孤岛笔记的特性提供专属算法（`POST /search/recommend_links`），区分于普通由于防抖触发的语义相关的短文本检索，更偏向于长文本和关键词权重的分析。
*   **更细粒度的知识图谱可视化**: 在侧边栏提供小型局部关系网络图。
