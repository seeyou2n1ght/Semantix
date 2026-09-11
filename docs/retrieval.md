# 检索与排序算法详解

Semantix 采用基于 LanceDB 的四阶段混合召回与动态双流排序架构，兼顾当前编辑语义的高精度收敛（Related）与跨主题知识涌现（Discover）。

---

## 1. 结构化切分与父子块 (AST Chunking)

1. **AST 语义分段**：基于 Markdown 抽象语法树识别标题层级、代码块、引用与列表项，不破坏语法边界。
2. **颗粒度解耦**：
   - **子块 (Index Chunk, ~400 字符)**：作为稠密向量化的基准单元，嵌入任务前缀 `为这个句子生成表示以用于检索相关文章：` 进行高维语义匹配。
   - **父块 (Context Chunk, 完整段落或列表容器)**：命中子块后回溯所属父块，提供完整的阅读与思考上下文。
3. **路径前缀注入**：块级文本自动拼合目录名、文件名与所属 Heading，解决重名笔记歧义。

---

## 2. 粗排独立召回与 RRF 融合 (Decoupled Retrieval & RRF Fusion)

- **Vector 语义召回**：基于 `BAAI/bge-small-zh-v1.5` 生成 512 维向量，通过 LanceDB 独立检索余弦相似度 Top 40。
- **FTS 关键词召回**：通过 LanceDB 内置 Tantivy 倒排索引独立检索精确词频 Top 40。
- **倒数排名融合 (RRF)**：解耦两路独立召回分数，采用标准 Reciprocal Rank Fusion 公式计算无量纲融合基分：
  $$\text{RRF}(d) = \sum_{m \in \{\text{vec}, \text{fts}\}} \frac{1}{60 + \text{rank}_m(d)}$$
- **多块命中提权 (Hit Bonus)**：同一笔记命中多个块时保留最高分块作为匹配基点，并根据块命中频次追加频次奖励（单次额外命中 $+0.02$，上限 $+0.06$）。粗排最终聚合输出 Top 25 篇候选。

---

## 3. 分数动态归一化 (Score Normalization)

由于余弦相似度、Cross-Encoder Logits 与 FTS BM25 分数值域存在量纲差异，在进入双流前执行 Min-Max 动态线性标定：

$$\widetilde{S}(x) = \frac{x - \min(X)}{\max(X) - \min(X) + \epsilon}$$

当候选集离散度极小（$\max(X) - \min(X) < 10^{-6}$）时，回退为常数均值映射，杜绝浮点溢出与分值虚高。

---

## 4. 双流排序管线 (Dual-stream Ranking)

```text
               [Top 25 粗排候选池]
                        │
       ┌────────────────┴────────────────┐
       ▼                                 ▼
 [Related 强相关流]               [Discover 探索流]
       │                                 │
 Cross-Encoder 精排              Relevance Gate 门控 (≥ 0.45)
       │                                 │
 结构亲和度提权 (Path/Tag/Link)    强排除 Related 结果
       │                                 │
 最终截断 Top K_related           二跳知识桥接提权 (Bridge Bonus)
                                         │
                                   结构惩罚 (出链/同目录降权)
                                         │
                                   MMR 贪心多样性打散
                                         │
                                  最终截断 Top K_discover
```

### 4.1 Related (强相关流)
1. **精排重打分**：调用 `BAAI/bge-reranker-base` 对 Top 24（balanced）或 Top 30（high_quality）候选进行 Cross-Attention 计算，经 Sigmoid 结合幂函数非线性校准映射至 $[0, 1]$。
2. **结构加权 (Structure Boosting)**：
   - **出链笔记 (Direct Link)**：$S_{\text{rel}} \leftarrow S_{\text{rel}} + 0.20$
   - **同目录笔记 (Same Folder)**：$S_{\text{rel}} \leftarrow S_{\text{rel}} + 0.05$
   - **共有标签 (Shared Tags)**：每个共有标签 $+0.05$，上限 $+0.15$
3. **截断输出**：按复合分降序排列，取 Top $K_{\text{related}}$。

### 4.2 Discover (意料之外流)
1. **Relevance Gate**：过滤归一化相关分低于门控阈值（默认 0.45）的弱相关或无关噪音。
2. **Hard Mutual Exclusion**：强排除已入选 Related 的全部笔记。
3. **二跳知识桥接提权 (Concept Bridge Bonus)**：
   - 当前笔记与候选笔记共享 $\ge 1$ 个共同出链目标时判定为两跳概念桥接节点：$S_{\text{disc}} \leftarrow S_{\text{disc}} + 0.15$
   - 跨物理目录且包含共有标签的笔记额外赋予跨域线索加权：$S_{\text{disc}} \leftarrow S_{\text{disc}} + 0.10$
4. **结构惩罚 (Novelty Penalty)**：
   - 已直接链接的笔记降权：$S_{\text{disc}} \leftarrow S_{\text{disc}} \times 0.60$
   - 同目录笔记降权：$S_{\text{disc}} \leftarrow S_{\text{disc}} \times 0.80$
5. **MMR (Maximal Marginal Relevance) 内部多样性打散**：
   在剩余候选集 $R \setminus S$ 中贪心迭代选择使下式最大化的候选 $d_i$ 加入结果集 $S$：

   $$\text{MMR}(d_i) = \lambda \cdot \operatorname{Sim}(d_i, q) - (1 - \lambda) \max_{d_j \in S} \operatorname{Sim}(d_i, d_j)$$

   - $\lambda = 0.65$：平衡相关度与内部相异度，确保最终选出的 Discover 卡片覆盖不同的主题聚类。

---

## 5. 推荐理由标签 (Explainable Labels)

系统为每张卡片动态生成 1~2 个指示标签：
- `DIRECT_LINK`：当前笔记存在指向该文件的双向链接
- `SHARE_TAGS`：共享核心标签
- `SAME_FOLDER` / `RELATED_FOLDER`：物理目录共存或相邻
- `SHARED_CONCEPT`：两跳共同出链桥接概念或跨目录共同标签
- `HIGH_RELEVANCE`：语义相关度极高（前 10%）
- `CROSS_TOPIC`：跨越目录但存在潜在语义桥梁
- `SPARK`：Discover 流高新颖度灵感推荐


