# Semantix Status and Roadmap

这份文档只记录两类内容：

- 当前代码已经实现了什么
- 接下来明确要推进什么

不再保留脱离当前实现的长篇设计草案，避免文档和代码继续分叉。

## Current Status

### Implemented

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
  - 每批调用 `/index/batch`
  - 侧栏展示进度并支持取消
- 基于 LanceDB FTS 的混合检索
  - 向量召回
  - FTS 关键词召回
  - LanceDB rerank / fallback 到纯向量检索
- 结果可解释性
  - chunk 级索引
  - snippet 返回
  - 关键词高亮
  - 分数颜色标签
- Markdown 标题感知切块
- BGE query instruction prefix
- 索引统计与基础指标接口
- 双步确认清空索引
- 移动端默认休眠

### Not Implemented

- cross-encoder rerank
- 面向孤岛笔记的独立排序算法
- 知识图谱可视化
- 后端异步任务式全量索引
- 检索质量的离线评测集与自动回归

## Current Constraints

### Full indexing is frontend-driven

当前没有 `/index/full`。全量索引由插件：

1. 枚举 Markdown 文件
2. 本地清洗文本
3. 每批调用 `/index/batch`

这意味着：

- 进度属于插件内状态，不是后端持久任务
- 关闭 Obsidian 或禁用插件后，进度不会保留

### Search quality depends heavily on pre-index text shape

后端虽然做了标题感知切块和 chunk 级检索，但前端送入后端的文本如果丢掉标题、段落和局部结构，后续切块和 rerank 都会一起失真。

### Search latency is currently affected by both query path and index-maintenance path

当前延迟不只是查询本身造成的，还包括：

- 索引阶段的重复 embedding
- 高频 FTS rebuild 带来的额外 CPU / IO 压力
- 对所有查询一律尝试 hybrid 检索的策略

## Retrieval Optimization Plan

### Goals

- 提升实时检索响应速度，优先改善编辑态查询体验
- 提升 Top 5 结果的主题相关性，降低“字面匹配但语义不对”的比例
- 建立稳定可迭代的检索质量基线，而不是只靠体感调参

### Phase 1: Preserve structure before indexing

问题：

- 前端清洗阶段如果把标题、换行和段落边界抹平，后端的 header-aware chunking 基本失效

改进：

- 清洗时只去掉噪声，不再把全文压成单行
- 保留标题文本和段落边界
- 保留对切块有价值的局部结构

预期收益：

- chunk 语义边界更稳定
- 标题上下文真正进入召回链路
- snippet 更贴近用户当前话题

### Phase 2: Remove avoidable indexing overhead

问题：

- 当前索引链路存在重复 embedding
- 每批写入后都尝试 rebuild FTS，会拉高索引成本并干扰查询

改进：

- 删除无效的整文 embedding
- 只保留真正入库所需的 chunk embedding
- 对 FTS rebuild 做节流或延后策略

预期收益：

- 降低全量索引耗时
- 降低增量同步对查询响应的影响
- 为实时搜索释放 CPU 时间

### Phase 3: Tighten query strategy

问题：

- 当前默认对所有请求尝试 hybrid search
- document 模式下查询文本偏长，既慢也容易把 lexical 信号污染掉

改进：

- 只对更适合的短查询启用 hybrid
- 对长查询优先走向量检索
- 为文档模式引入更紧凑的 lexical query 或 query compression

预期收益：

- 降低平均搜索延迟
- 提升长文档模式下的结果稳定性
- 降低“不相关关键词把结果拉偏”的概率

### Phase 4: Improve candidate aggregation and ranking

问题：

- 当前候选集过小，去重前就截断
- 多个相似 chunk 容易挤占其他文档的候选位置

改进：

- 放大 chunk 候选池
- 先做文档级聚合再截断 Top K
- 后续为标题、标签、header 提供结构化 boost

预期收益：

- 文档级召回更稳
- Top K 结果多样性更好
- 结果排序更符合用户的“找相关笔记”预期

### Phase 5: Add evaluation and observability

问题：

- 目前缺少系统化的质量评估
- 性能问题只能靠体感判断

改进：

- 建一组固定查询样本
- 记录 query encode、search、rerank、total latency
- 记录 chunk 数、文档数、FTS rebuild 耗时

预期收益：

- 每次调参都有可比较的结果
- 能快速区分“变慢”来自索引、查询还是重排

## Execution Order

当前建议按以下顺序推进：

1. 保留 Markdown 结构，重建索引
2. 去掉重复 embedding，控制 FTS rebuild 频率
3. 收紧 hybrid query 触发条件
4. 放大候选池并优化文档级聚合
5. 建立最小可用的检索评测与性能观测

## Roadmap

### P0

- 保留结构化 Markdown 清洗结果，恢复标题感知切块效果
- 删除重复 embedding，降低索引链路开销
- 收紧 hybrid search 的启用条件

### P1

- 扩大候选池并做更稳的文档级聚合
- 为 title / tags / headers 提供结构化排序特征
- 建立基础检索基准和性能日志

### P2

- cross-encoder rerank
- 孤岛笔记专用排序策略
- 知识图谱可视化

## Documentation Rule

以后这份文档只接受两类更新：

- 某项功能已经进入代码并可用
- 某项功能进入了短期、可执行的 roadmap

如果只是探索方案，不应直接写进主路线图。
