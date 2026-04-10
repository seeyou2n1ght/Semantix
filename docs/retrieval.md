# 检索与召回逻辑详解

Semantix 采用深度的三阶段检索策略（Hybrid + Path Boost + Cross-rerank），旨在本地环境下提供媲美云端 RAG 的准确度。

## 1. 结构化文本预处理 (Structured Preprocessing)

不同于传统的正则清洗，Semantix 采用 Markdown AST (语法树) 解析器：
- **保留结构**：精确识别标题层级、列表嵌套与代码块。
- **语义身份注入 (Identity Injection)**：
    - **全路径前缀**：为每个块注入 `[目录 > 文件名 > 标题路径]`。
    - **示例**：`[Work/Archive > ProjectA > 设计文档 > 技术选型] ...文本内容`。
    - **价值**：利用 Obsidian 的目录结构作为隐含语义标签，解决重名文件歧义。

## 2. 父子块与滑动窗口 (Parent-Child & Sliding Window)

后端执行“颗粒度解耦”切块：
- **子块 (Index Chunk - ~400 字符)**：作为向量化的基准单元，用于高精度匹配。
- **父块 (Context Chunk - 段落/完整列表)**：作为子块的容器，检索命中后向用户展示父块全貌。
- **滑动窗口重叠 (10%-20% Overlap)**：确保长段落在物理切割处不丢失核心语义。

## 3. 增强召回策略 (Triple-layer Retrieval)

| 阶段 | 策略 | 作用 |
| --- | --- | --- |
| **Stage 1: Hybrid** | Vector + FTS (0.7:0.3) | 同时捕捉语义意图与精确关键词（如 ID、专有名词）。 |
| **Stage 2: Path Boost** | 目录亲和度加权 | 若命中文件与当前活动笔记处于**同一目录**，得分获得 `+0.05` 的奖励分。 |
| **Stage 3: Rerank** | Cross-encoder 精排 | 利用 `bge-reranker-base` 对 Top 15 候选进行二次打分，纠正向量检索的偏差。 |

## 4. 文档级聚合评分 (Aggregation)

1. **去重聚合**：同一文件的多个命中子块合并，取精排最高分作为 Base Score。
2. **命中增益 (Hit-boost)**：每额外命中一个位置不同的块，得分增加 0.02 (上限 0.06)。
3. **最终分计算**：`Final = Rerank_Score + Hit_boost + Path_boost`。

## 5. 结果解释与展示
后端返回经过 **Snippet Focusing** 处理的文本：
- 如果命中点在长段落结尾，Snippet 会自动前移，确保关键词在展示框中心。
- 指示灯映射：🟢 >= 0.85 (强相关), 🔵 >= 0.75 (相关), 🟡 < 0.75 (潜在关联)。
