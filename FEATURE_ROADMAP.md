# Semantix Status and Roadmap

这份文档只记录两类内容：

- 当前代码已经实现了什么
- 下一阶段明确值得推进的方向

不再保留已经脱离代码的详细设计草案，避免文档继续误导实现状态。

## 当前状态

### 已完成

- `Whisperer` 实时语义推荐
  - `file-open`
  - `editor-change`
  - `cursor-activity`
- `Orphan Radar` 孤岛笔记扫描与展开推荐
- Vault 级隔离
  - 前端计算稳定 `vaultId`
  - 后端按 `vault_id` 索引与查询
- 增量同步
  - `create`
  - `modify`
  - `rename`
  - `delete`
- 全量初始化索引
  - 前端分批读取 Vault 文件
  - 批次调用 `/index/batch`
  - 侧栏展示进度并支持取消
- 结果可解释性
  - chunk 级索引
  - snippet 返回
  - 关键词高亮
  - 分数颜色标签
- Markdown 标题感知切块
- 查询侧 BGE instruction prefix
- 索引统计与基础指标接口
- 双步确认清空索引
- 移动端默认休眠

### 当前没有实现

- cross-encoder rerank
- 专门面向孤岛笔记的独立排序算法
- 图谱可视化
- 后端异步任务式全量索引接口
- 后端异步任务式全量索引接口

## 当前代码中的重要实现约束

### 全量索引是前端驱动的

当前没有 `/index/full`。全量索引由插件：

1. 枚举 Markdown 文件
2. 本地清洗文本
3. 每批 50 篇调用 `/index/batch`

因此：

- 进度是插件内状态，不是后端持久任务
- 关闭 Obsidian 或禁用插件后，进度不会保留

### 搜索升级为混合检索

当前检索链路是：

1. 基于 LanceDB 构建原生的全文倒排索引 (FTS)。
2. 查询文本经过模型编码，同时作为 BM25 Keyword 一并送入 LanceDB。
3. 执行 `query_type="hybrid"`，由 LanceDB Internal Reranker 进行合并算分。
4. 提供由于 FTS 重建耗时引发的 fallback 容灾方案（退回纯向量检索）。

这意味着即使含有罕见的特定名词或代码，也能优先召回。

### 规则支持完整 Glob

设置页里的 `Exclusion Rules` 支持标准的 Glob 语法机制（通过 `picomatch` 库），可以灵活写出 `**/*.canvas`, `Archive/**/*.md` 等复杂的断言。同时为了历史兼容处理做了无损扩充。

## 下一阶段路线



### P1

- cross-encoder rerank
  - 先粗召回，再精排
  - 提升 Top 5 结果排序稳定性
- 孤岛笔记专用推荐策略
  - 引入标题、标签、局部上下文等额外特征

### P2

- 知识图谱可视化
  - 基于现有链接与推荐关系展示关联网络
- 更细的运维与诊断能力
  - 索引耗时拆分
  - 文档数 / chunk 数监控
  - 失败批次定位

## 文档维护原则

以后这份文档只接受两种更新：

- 某项功能已经进入代码并可用
- 某项功能进入了明确、可执行、短期的 roadmap

如果只是探索方案，不应再直接写进主路线图文档。
