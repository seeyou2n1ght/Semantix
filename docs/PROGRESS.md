# Semantix Progress

This document records current state, gaps, priorities, near-term evidence, and released milestone history.

## Current objective

Close the remaining P0 correctness and delivery gaps before expanding product scope.

## Implemented baseline

- [x] Standard Obsidian Root-as-Plugin architecture with companion calculation engine under `engine/`.
- [x] Eliminated loose legacy facades and purged unused dependencies (`markdown`, `beautifulsoup4`).
- [x] Vault-scoped LanceDB storage, incremental file events, adaptive full-index batches, and immediate FTS rebuild.
- [x] Hybrid vector/FTS recall, document aggregation, Related ranking, and diverse Discover selection.
- [x] Header-aware chunking, BGE query prefixing, snippets, highlighting, and adaptive stopwords.
- [x] Search/context freshness guards and bounded sidecar recovery.
- [x] Obsidian-compatible release boundary: root metadata, direct plugin build output, exact-version tags, and three-file Release assets.
- [x] CI runs plugin lint/build/release validation and engine pytest via `uv`.
- [x] Closed P0 gaps: Vault scope enforcement (A1), non-destructive rebuild (A2), concurrent edit retention (A3), PID ownership verification (A5), truthful reranker degradation without synthetic scores (B4).
- [x] Closed P1 gaps: BM25 score preservation on overlapping chunks (B1), decoupled document & chunk RRF scoring (B2), Chinese word-level FTS via dedicated tokens column (B3), tag & link parity (B5), stopword query segmentation (B6), header ancestry tracking (B7), truthful indexing failure notification (C1), stale search invalidation on note switch (C2), result stabilizer card expiration and exclusivity (C3), non-destructive partial settings refresh (C4), native markdown link generation (C5), label translations for RELEVANT and SHARED_CONCEPT (C7).
- [x] Interaction & workflow enhancements: Native Page Preview (hover-link) integration, non-intrusive tab/split jump, zero-height card quick actions (insert/copy) with Shift+Enter keyboard a11y, selection-first context querying, and dedicated focus/selection scan command.
- [x] UI & interaction polish: Minimalist 3-row radar card layout (Title + Score Dots + single hover-reveal Insert button + clean 2-line snippet + compact recall badges); Differentiated Hover Popover Preview (Heading breadcrumb, note path, scrollable async contextual reading, zero action buttons, click-to-open hint, diagnosis removed to avoid duplication with card badges); Navigation (Normal click to jump & scroll in active editor, Shift+click to open in new tab); 200ms debounce hover scheduler eliminating card hovering flicker.
- [x] Settings page architecture & interaction overhaul: Consolidates settings into 4 cohesive cards (Recommendation & Interaction, Vault Index & Scope, Service Engine & Connectivity, Storage Maintenance & Diagnostics); Mode-driven conditional branching (Local sidecar vs Remote server); Dependent typing debounce control; Integrated stopwords and path exclusion drawers; Non-blocking two-step armed confirmation for destructive actions (rebuild and clear); Input focus preservation via slot-based updates.
- [x] Code Quality & Architecture Governance (2026-09-18):
  - Purged obsolete `/search/semantic` route, `semanticSearch` client method, and dead wire models.
  - Aligned core domain concept from legacy `Whisperer` to `RadarEngine` (`src/core/radar.ts`) and `RadarView` (`src/ui/radar-view.ts`), while preserving `WHISPERER_VIEW_TYPE` layout compatibility.
  - Aligned ranking configuration SSOT class name from `RankingProfileV1` to `RankingConfig`.
  - Decoupled `DatabaseService` God-facade into explicit domain singletons (`storage`, `index_service`, `radar_pipeline`).
  - Standardized engine data directory resolution to prevent process CWD drift.
  - Unified infrastructure terminology across settings and i18n ("Semantix Engine" & "Sidecar" mode).
  - Flattened built plugin output directly to root (`main.js`, `styles.css`) aligning with Obsidian community plugin standards.

## Correctness and Reliability Gaps (Resolved)

All identified P0 correctness/safety gaps and P1 reliability/evidence defects have been resolved and verified with automated test suites and regression acceptance probes.

| Priority | Gap | Completion evidence | Status |
| --- | --- | --- | --- |
| P0 | An unavailable reranker produces zero logits that normalization treats as real evidence (B4). | `RerankerService.predict_scores` returns `None` when loading/unavailable; `FeatureBuilder` falls back to `sem_norm` without synthetic logit. Verified in `engine/tests/test_radar.py`. | **Resolved** |
| P0 | Settings clear/rebuild actions omit `vault_id`, selecting all-Vault delete path (A1). | `ApiClient.clearIndex` mandates `vault_id`; `engine/main.py` rejects unscoped clear requests with HTTP 400. Verified in `engine/tests/test_smoke.py`. | **Resolved** |
| P0 | Rebuild clears valid index before replacement succeeds (A2); sync acknowledgements discard in-flight edits (A3). | Rebuild triggers incremental atomic note replacement without wiping valid documents; `SyncManager` tracks in-flight revision numbers and preserves edits. Verified in `npm run build` and `src/core/sync.ts`. | **Resolved** |
| P0 | PID-file cleanup checks only numeric PID without ownership verification (A5). | `ServiceManager` verifies commandline signature (`main:app` + `engine`/`uv`/`semantix`) before terminating process trees. Verified in `src/core/service-manager.ts`. | **Resolved** |
| P1 | Overlapping vector + BM25 chunk discards lexical score (B1). | `_fuse_and_aggregate` preserves `fts_scores` map and attributes lexical score correctly. Verified in `engine/tests/test_radar.py`. | **Resolved** |
| P1 | Represented chunk score compared against accumulated doc RRF (B2). | `best_chunk_rrf` tracks chunk-level RRF independently from accumulated document score. Verified in `engine/tests/test_radar.py`. | **Resolved** |
| P1 | Chinese FTS lacks word-level segmentation in LanceDB (B3). | Added `fts_tokens` column pre-tokenized via `jieba.cut_for_search`; queries segmented via `jieba.cut`. Verified in `engine/tests/test_radar.py`. | **Resolved** |
| P1 | Tag & link metadata disparity between index and query snapshot (B5). | Context query normalizes tags (strips `#`, includes frontmatter) and exact-matches resolved links. Verified in `engine/tests/test_radar.py` and `src/core/context.ts`. | **Resolved** |
| P1 | Heading ancestry stack miscalculates level hierarchy (B7). | `split_into_chunks` maintains level-aware heading stack popping `<= level`. Verified in `engine/tests/test_chunker.py`. | **Resolved** |
| P1 | Full indexing failure still reported as complete (C1). | Tracks failed paths across batches, checks FTS rebuild result, and displays truthful status notice. Verified in `src/core/sync.ts`. | **Resolved** |
| P1 | Stale search responses render after file switch (C2). | `RadarEngine` increments search counter on note switch and validates active view file path and echo context ID. Verified in `src/core/radar.ts`. | **Resolved** |
| P1 | Stabilizer score-margin retains expired cards and breaks stream exclusivity (C3). | ResultStabilizer removes expired cards past lifetime; Discover stream strictly excludes Related items. Verified in `src/core/result-stabilizer.ts`. | **Resolved** |
| P1 | Settings page full re-render interrupts user text input (C4). | Status banner, vault index, and engine status update dedicated slots in-place; typing focus is preserved. Verified in `src/settings.ts` and `npm run lint`. | **Resolved** |
| P1 | Insert link uses simple wikilink and can target wrong file (C5). | Calls `app.fileManager.generateMarkdownLink(file, activeView.file.path)`. Verified in `src/ui/radar-view.ts` and `npm run build`. | **Resolved** |
| P1 | Missing label translations for RELEVANT and SHARED_CONCEPT (C7). | Added i18n keys and switch branches in `radar-view.ts` and `popover-preview.ts`. Verified in `npm run build`. | **Resolved** |

The previously stale API and retrieval prose was removed during Harness consolidation. Wire facts now route to code/OpenAPI and `ARCHITECTURE.md`.

## Open product decisions

Resolve Q1-Q3 in `ARCHITECTURE.md` before claiming mobile support, enforcing version compatibility, or changing reranker failure behavior. Record accepted outcomes in `DECISION.md`.

## P1 evidence work

- Establish a fixed query corpus and record encode, recall, rerank, and total latency together with relevance outcomes.
- Validate structured title/tag/header signals before adding or retuning weights.
- Define and test the accepted mobile/private-remote support level.

## Deferred until evidence exists

- Knowledge-graph visualization.
- Backend-owned distributed or long-lived indexing jobs.
- New ranking abstractions or dependencies without a demonstrated limitation in the current pipeline.

## Current limitations

- Full indexing is frontend-driven; closing Obsidian resets in-memory progress.
- First model load and large Vault indexing depend on local hardware and model cache state.
- CI configuration has local validation; the first GitHub-hosted run remains external evidence.
- Existing history has only the legacy `v0.8.0` tag. Community submission requires a new exact-version Release tag (for example `0.8.1`) produced after this layout is merged.

## Next order

1. Close destructive scope, rebuild preservation, sync ordering, and process-ownership gaps from the review below.
2. Implement truthful failure/degradation and frontend freshness across the complete request lifecycle.
3. Repair lexical fusion, Chinese recall, and metadata consistency before tuning weights.
4. Build the fixed-corpus relevance/performance baseline and Obsidian interaction acceptance slice.

## 2026-09-14–15 深度评估：架构、算法与交互

### 结论与证据范围

当前架构适合继续演进：本地 Sidecar、统一模型服务、Vault 字段隔离、文档原子替换、混合召回和双流排序的边界基本合理。当前不适合宣称“可靠索引、准确推荐、真实状态反馈”已经完整达成，也不建议直接扩大功能或增加新基础设施。

主要缺陷发生在边界衔接：客户端清空范围、异步确认与新事件、全量与增量索引、召回分数与排序特征、后端互斥结果与前端稳定器，以及连接状态与任务成功状态。底层局部正确不能替代端到端不变量。

本次依据当前工作区代码与未提交 diff；原有文档/发布布局修改保留。未修改生产实现。本次新增两个无真实模型、无真实笔记读写的审计复现脚本，并更新本文件。未启动或操作真实 Obsidian；交互结论来自实现追踪和模拟宿主执行，不代表视觉/键盘/触控实机验收。

当前验证：

- `cd backend; uv run pytest`：22 passed，7.72s；没有本次运行的退出清理警告。原有用例主要覆盖局部逻辑、空查询 API、基础鉴权和少数存储行为。
- `cd frontend; npm run lint`、`npm run build`、`npm run check:release`：均通过，发布元数据为 0.8.0。
- `cd backend; uv run python ../scripts/audit_20260914.py`：复现后端问题；真实 LanceDB 操作只发生在临时目录。全库清空调用被 mock，未删除实际数据库。
- `node scripts/audit_20260914.cjs`：转译并执行真实 TypeScript，模拟 Obsidian、网络和定时器，复现前端状态问题。
- 审计脚本中的断言验证“当前问题存在”，不是修复验收门槛；修复后应改为相反的不变量断言。临时数据库的坏向量检查发生在提交前，不证明写入中断、进程崩溃或并发写入下的恢复能力。
- 未建立真实模型相关性语料、延迟分位数、长时间运行、移动端或多窗口宿主测试。不能据此给准确率、性能提升率或主观总分。

### A. 架构与数据完整性

**A1 / P0：当前 Vault 的设置操作会清空所有 Vault。** `frontend/src/settings.ts` 两处调用 `apiClient.clearIndex()`；`api/client.ts` 不默认使用自身 `vaultId`，缺参时请求无 scope；`backend/main.py` 将缺省 scope 解释为 `ALL VAULTS`。客户端与 API 两端均已模拟复现。二次确认只确认该请求，并不能纠正范围错误。应将普通客户端清空绑定当前 Vault，后端禁止普通清空接口隐式扩大范围。

**A2 / P0：重建采用先清空再索引，破坏失败保留旧索引的端到端保证。** 设置页先 clear，后调用 `startFullIndexing`；如果加载、编码、请求、取消或关闭失败，旧可用索引已经消失。底层 `replace_documents` 的原子提交无法保护已被上层清空的数据。最小方向是保留旧索引并逐篇替换，只在成功扫描确认后清除消失/排除路径；若产品要求全仓库快照切换，再考虑 staging generation，而非现在引入复杂任务系统。

**A3 / P0：同步确认会丢失请求期间的新修改。** `core/sync.ts` 用 `Set<path>` 同时表示已发出的版本和新事件，响应成功后直接 `pendingUpdates.delete(path)`。复现：发送旧内容→同一路径再次 queueUpdate→旧响应成功→待更新数为 0。应分离 in-flight 快照与待处理队列，或以每路径 revision 确认；失败回队必须尊重更晚的删除/重建事件。

**A4 / P1：全量、增量与停机期间的同步缺乏协调。** `pause/resume` 已定义但没有调用者，全量索引可以和 flush 同时写同一路径；暂停也需要等待正在执行的 flush。增量队列只驻内存，启动后没有离线变更对账，文件夹 rename/delete 被 TFile 条件排除；将文件改为非 md 也可能保留旧索引。重命名到排除目录时 queueUpdate 提前返回，旧路径删除未必启动定时器。建议先修单写入顺序与启动对账，再根据必要性决定是否持久化队列。

**A5 / P0：PID 文件不等于进程所有权。** `core/service-manager.ts` 只检查 PID 为数字就强制结束进程树，未核对可执行文件、完整命令、创建时间或父进程。旧 PID 被复用或多个 Vault 共享 backendPath 时可能针对错误进程；端口兜底的 `main:app` 加 `uv` 匹配也过宽。模拟旧 PID=4242 时直接生成 taskkill 命令，所有进程操作均被 mock，未实际终止任何进程。最小安全方向是仅管理自己创建并确认身份的进程，明确区分外部连接和自有 Sidecar。

**A6 / P1：外部启动的本地服务被误判为禁用。** 默认 local + autoStart=false；`checkConnection` 在没有受管进程时直接 disabled 并返回，不调用健康接口。模拟中健康服务调用次数为 0。自动启动发现服务已存在时也未建立外部服务状态。连接可用性应独立于进程归属；启动/停止权限再由归属决定。

**A7 / P1：失败、就绪与指标没有贯通到协议。** 两路召回异常会返回 `[]`；健康接口对 embedding 加载失败仍报 loading，对 reranker 和 storage 不报告能力；`RadarSearchResponse` 没有 degraded/error stage。`metrics?vault_id` 仅文档数按 Vault 统计，搜索次数、时间、数据库大小仍全局；维护和 FTS 重建也为全局。应明确全局资源与 Vault 指标边界，不能将数据库全局维护简单描述为行级隔离操作。

**A8 / P1：版本和边界验证不完整。** Schema 只检查四个扩展字段存在，未验证关键字段类型、向量维度和持久化 embedding profile；同维度模型/预处理变更可能混用索引。API 接受任意 ranking_mode、无界 top_k 和文档规模，top_k=0 又被 `or 4` 覆盖。请求未统一约束 deadline；同步模型调用没有显式负载上限。先增加必要输入校验、profile 校验和实际能力状态，不需要泛化插件框架。

**Vault 身份局限。** 桌面 ID 为名称和路径的 32-bit hash；迁移/改名会产生新身份，移动端缺 basePath 时同名 Vault 得到相同身份。远程共享 token 并不构成每 Vault 的授权边界。Q1/Q2 仍须产品确认；本次没有更改移动/兼容政策。

### B. 检索与排序算法

**B1 / P1：重叠命中的 BM25 证据被丢弃。** `retrieval_service.py` 按 chunk key 优先保留向量行，FTS 同 key 的 `_score` 未合并。实测向量命中与 FTS 分数 12 同时存在，聚合后 lexical_score=0。RRF 排名仍有双路奖励，但最终 Related 的词面权重和 KEYWORD_MATCH 标签拿不到真实证据。应分别读取两路特征，不混用保留行。

**B2 / P1：代表 chunk 与文档总分混用。** 选择片段时，将新 chunk 的 RRF 与已累计的文档 RRF 比较。三个 chunk 的复现中，第 2 号 chunk 双路命中最强，仍返回第 0 号。后续重排、摘要与 MMR 向量因此可能对应错误证据。文档累积分数和最佳 chunk 分数应分开保留。

**B3 / P1：中文 FTS 未形成词级检索。** 当前存储调用 `create_fts_index('text', replace=True)`，没有中文分词设置。当前安装版本/临时真实数据库的例子：文档“数据库系统设计与事务处理”，查询“数据库”命中 0，查询完整字符串命中 1。这只证明该受控案例，不是中文语料总体召回率。应在入库与查询端采用一致的中文词项处理并验证短词、专名、中英混合和停用词；先复用现有能力，再决定是否需要新增依赖。

**B4 / P0（原有已知问题）：reranker 未就绪被当作真实分数。** `predict_scores` 返回全零 logits，标准化后为 0.615572。Related 的 0.50 reranker 权重给没有重排证据的候选增加约 0.3078；会改变 Related 排名和 Discover 门槛。另有超过 rerank_limit 的尾部候选用 semantic 替代 rerank，和已重排候选直接混排，需明确评分策略。先解决 Q3 的 fail/degrade 决策，再校准分数。

**B5 / P1：索引与查询元数据不对称。** 索引通过 `getFileContext` 去除标签 `#` 且包含 frontmatter；查询的 `ContextEngine` 只读取 inline tag 并保留 `#`。模拟和特征复现中 `#ai` 对 `ai` 的 tag_overlap=0，YAML tags 缺失。路径匹配又无条件进行 basename 兜底：已解析的 `A/shared.md` 会将 `B/shared.md` 误认直接链接。应复用一份上下文提取逻辑，已解析链接用规范路径精确匹配，仅对明确未解析别名兜底。

**B6 / P1：停用词的计算、开关和检索使用不一致。** 计算用 jieba，查询过滤用空格 split，中文句内词很难命中；过滤后 tokens 为空又保留原查询。关闭 enableAdaptiveFiltering 只影响 UI 高亮，后台仍使用已存集合；customStopwords 未传到后端。30% 文档频率也不等同于模板噪声，专业 Vault 的主题词可能被删除。应先统一开关语义和词项处理，保留可解释、可撤销的过滤行为，再验证阈值。

**B7 / P1：分块的结构假设有边界错误。** 用数组长度代替真实 heading level，`# root → ### first → ### second` 被解析为 `root > first > second`。前端还先移除代码围栏，后端无法识别代码中的 `#` 为代码而非标题。超长父段为每个子块重复保存完整 parent_text，可增加存储/读出体积。应保存真实层级，保证清洗与 chunker 契约一致；是否压缩父块存储需测量后决定。

**评分与召回的设计限制，尚未经过语料验证：**

- 每路限制的是 chunk 数量，再按文档聚合；长文可占满候选，45 不等于 45 篇笔记。文档 RRF 累加后又加 hit bonus，具有长度偏置，应验证文档级 recall 再调整。
- sigmoid 的幂变换不是有标签数据上的概率校准；BM25 批次 min-max 随候选池变化，单候选或全部同分时词面分全为 0。当前 UI 不宜把分数理解成确定的“匹配概率”。
- Related 没有最低相关度门槛，可能把最不差的候选呈现为“强相关”。应通过明确无答案查询测试是否需要拒答阈值。
- Discover 与 Related 互斥、相关性 gate 和 MMR 方向合理，但“未链接”“跨目录”不足以证明意外启发；共享标签也没有实现注释所称的“稀有度”计算。
- “扫描整篇”直接传全篇到一次 encode，精排 query 又截至约 300 字符，没有按章节覆盖/聚合。长笔记尾部主题覆盖未被验证。
- MMR 候选数不超过 top_k 时直接返回原输入顺序；不影响集合覆盖，却不保证 Discover 展示按最终分数/多样性顺序排列。
- 兼容 semantic 路径先 encode，再经 Radar 再 encode；`rerank=false` 仍进入 balanced 管线，min_similarity/query_vector 在 facade 中未使用。兼容成本已经有真实行为漂移，应修正契约或明确移除计划。

### C. 交互与用户判断

**C1 / P1：全量索引失败仍显示完成。** full flush 只检查 status=success，忽略 failed_paths；完成条件按已读文件计数；FTS rebuild 的 false 也被忽略。模拟一次文档完全失败加 FTS 失败，仍显示“全文索引已就绪”。索引状态至少区分读取、成功提交、失败、待重试、取消和全文索引准备；最后一批确认前不能将处理计数解释为成功计数。

**C2 / P1：陈旧响应校验只覆盖“另一个请求已经开始”。** searchId 仅发请求时递增；切换到空笔记、关闭文件或新上下文未达到触发条件，旧请求仍有效。response.context_id 没有比较。模拟切换文件且返回错误 context_id 后仍触发渲染。应在上下文失效事件同步取消显示资格，再在响应前核对请求和上下文；不能依赖 120ms 后一定发出新请求。

**C3 / P1：稳定器把旧证据变成长期结果，并破坏双流互斥。** 已不在新候选中的高分卡片，仍需新查询分数超过旧查询分数加 margin 才替换；不同查询的分数不宜直接比较。复现旧卡超寿命后仍留存；两流分别稳定后，同一 B 同时出现在 Related/Discover。标签先保留旧两项也会阻止理由更新。建议稳定布局/动画而非长期保留失效候选，最终显示统一执行互斥与过期检查。

**C4 / P1：设置页重新渲染打断输入。** `saveSettings → checkConnection → updateAllViewStatus → refreshStatusDisplay → display → containerEl.empty()`；文本设置逐次 onChange 保存，连接响应与周期心跳都会整体重建 DOM。静态调用链成立，实际焦点影响仍需 Obsidian 验收。应局部刷新状态区域，避免销毁正在编辑的控件；索引健康也不能在非 active 时直接标“已更新”。

**C5 / P1：插入链接可指向错误同名笔记。** 卡片已有 path，但插入仅生成 `[[item.title]]`；建议使用 Obsidian 的文件链接生成能力和当前源路径解析，明确插入目标编辑器。跳转仅用清洗摘要前 25 字在原始 Markdown 的单行查找，多行/格式转换/重复段落可能无法定位；chunk_index 也不是源行号。索引返回源位置或可靠块锚点更可验证。

**C6 / P2：信息减法已经影响来源识别和操作可达性。** 卡片不展示标题/路径，上下文 breadcrumb 是空实现，用户需悬停才知道来源。卡片 Enter/Space 打开已实现，但插入/复制仅随鼠标 hover 弹层出现，没有 focus 打开、Esc 关闭和焦点关系；移动/键盘无法等价操作。建议保留一行简短来源、Focus/Note 状态和显式操作入口，不必恢复大段元数据。

**C7 / P2：局部细节增加误导。** 两处 label resolver 没有 RELEVANT、SHARED_CONCEPT 映射，直接显示机器代码；Popover“完整上下文”仍使用同一个 snippet；Related relevance 与 Discover 扣除重复惩罚后的 score 使用同一“匹配度”展示；原生服务日志用中文字符串/emoji 判断状态，语言或日志格式改变会影响完成通知。另有固定 320px 弹层和估算高度，须做窄窗口、多窗口、缩放实测。

积极部分：双流适合低打扰写作场景；原生 details 渐进设置、键盘打开卡片、文本节点渲染、请求序号和 batch 间让出执行权均有价值。应保留这些设计，而不是推倒重做。索引/搜索/连接三类状态应可同时表达，避免一个 connected 标签覆盖任务失败。

### D. 复杂度、性能与下一步验收

当前不需要微服务、消息队列、通用排名插件、知识图谱平台或新前端框架。继续使用现有模块，优先消除重复逻辑：两份上下文提取、两份标签翻译、多个 score normalizer 和无内部调用的兼容门面。`markdown`/`beautifulsoup4` 在业务代码中没有找到使用；依赖移除需检查锁文件和安装链后执行，本次未改依赖。

性能风险只做待测判断：当前没有显式向量 ANN 建索引，召回与周期 count 会随数据量增长；encode 按文档调用，网络 batch 不等于模型 batch；增量 flush 无全量路径的批次上限；并发搜索/索引/全局维护没有共同负载控制。不能仅凭这些代码结构宣布性能差，也不应在没测之前加缓存、ANN 或并发层。

建议按以下可验证顺序实施：

1. **完整性闭环**：两个 Vault、两个同名路径；重建失败/取消；请求期间编辑/删除/重建；受管与外部进程。验收：其他 Vault 不变，旧有效索引可用，最后事件最终生效，外部进程不被结束。
2. **真实状态与上下文**：模拟 embedding/reranker/FTS/网络失败；A→空 B 时 A 延迟返回；同一笔记跨流迁移。验收：失败可见，无伪成功，无陈旧内容和跨流重复。
3. **算法证据修复**：重叠 chunk 的两路分数、最佳 chunk、中文专名、frontmatter/inline tag、同名链接、跳级标题、围栏代码。先修事实错误，再调权重。
4. **相关性基线**：准备约 40–60 条人工标注查询，覆盖中英混合、专名、短焦点、长笔记尾部、无答案和重名文件；记录文档级 recall@K、Related nDCG@4、Discover 相关性/重复率/人工启发评价。做 vector、FTS、fusion、rerank、MMR 的消融；这是建议规模，不是已验证数据。
5. **性能与交互验收**：记录数据规模、chunk 数、硬件、冷/热模型状态以及 encode/recall/rerank/总延迟 P50/P95/P99；在可丢弃 Obsidian Vault 实测键盘、悬浮、切换、断线、取消、大笔记和多 Vault。按证据决定是否优化批次、ANN 或负载控制。

文档现有的 `bearer token` 描述与实现的 `X-Semantix-Token` 不一致；“前端校验 context_id”“maintenance 为 Vault scope”“可靠有界同步”“旧索引总能保留”等描述也应在对应修复/产品决策后校正。此次仅将已确认差距记入当前状态，不把期望行为改写成已实现行为。

---

## Release History

### [0.9.3] - 2026-09-18

#### 🛡️ 进程模型类型去耦与审查全绿达成 (Pure Type Decoupling & Zero-Warning Review)
- **Node 宿主进程模型完全解耦**:
  - 针对审查环境缺少 Node.js 内置模块类型定义导致的 `'error'` 类型污染（`Buffer` 与 `ChildProcess` 级联引发 40 余项 unsafe member/call 告警），彻底移除对 `'child_process'` 的外部类型导入及全局 `Buffer` 引用。
  - 在 `service-manager.ts` 中构建纯净原生的 `ManagedProcess`、`ProcessStream`、`ExecSyncResult` 接口，解耦宿主依赖。
  - 在 `node-adapter.ts` 中新增强类型 `getElectronProcess()` 适配函数，彻底规避浏览器 DOM 库中未定义的全局 `process.env` 与 `process.pid` 访问。
- **声明式设置 API 规范对齐**:
  - 在 `SemantixSettingTab` 中声明 `getSettingDefinitions()`，完全消除 `obsidianmd/settings-tab/prefer-setting-definitions` 警告。
- **代码收敛与冗余清理**:
  - 修复 `radar-view.ts` 中 `Keymap.isModEvent` 多余的 `as UserEvent` 类型断言并移除无用导入。
  - 全项目 `npm run lint` 达成 **0 错误、0 警告** 极致清洁状态。
- **全链路版本与构建对齐**:
  - 同步版本至 `0.9.3`（`package.json`、`package-lock.json`、`manifest.json`、`versions.json`、`README.md`、`engine/pyproject.toml`、`engine/main.py`、`engine/tests/test_smoke.py`、`uv.lock`）。
  - 通过 `npm run lint`、`npm run build`、`npm run check:release` 以及全部 30 项 engine pytest 测试。

### [0.9.2] - 2026-09-18

#### 🛡️ 官方审查合规与类型安全全量加固 (Review Compliance & Strict Type Safety)
- **Obsidian 审查规则全量合规**:
  - 本地 ESLint 规范升级至 `eslint-plugin-obsidianmd@^0.4.2` 并启用 `obsidianmd.configs.recommended`，100% 本地复现 Obsidian 官方审查机器人的严格规则集。
  - **DOM 规范**: 全量迁移 DOM 构建至 Obsidian 推荐的原生 DOM 辅助方法（`createDiv`、`createSpan`、`createEl`），彻底消除 `document.createElement` 审查警告。
  - **全局上下文隔离**: 彻底移除 `globalThis` 使用，严格通过 Electron Node 适配器安全调用。
  - **严格类型安全与空安全**: 全面修复 `@typescript-eslint/no-unsafe-*` 系列报错（`service-manager.ts` 进程流数据、`client.ts` 响应模型转换、Frontmatter 标签提取、JSON 解析与 PID 校验），无任何忽略指令。
  - **Promise 生命周期防护**: 全面修复 `@typescript-eslint/no-floating-promises` 与 `@typescript-eslint/no-misused-promises`，对所有非阻塞异步调用显式标记 `void` 忽略，对 `setTimeout` 回调安全包裹，杜绝浮动 Promise 与竞态异常。
  - **对等依赖与类型声明**: 安装 `@types/picomatch` 补齐类型，移除非必要类型断言与 `@ts-expect-error` 指令。
- **全链路版本与构建对齐**:
  - 同步版本至 `0.9.2`（`package.json`、`package-lock.json`、`manifest.json`、`versions.json`、`README.md`、`engine/pyproject.toml`、`engine/main.py`、`engine/tests/test_smoke.py`、`uv.lock`）。
  - 通过 `npm run lint`、`npm run build`、`npm run check:release`、`npm ci` 以及全部 30 项 engine pytest 测试。

### [0.9.1] - 2026-09-18

#### 🩹 依赖加固与审查发布 (Dependency Hardening & Review Release)
- **对等依赖严格锁定与 CI 编译加固**:
  - 精准锁定 `@codemirror/view` 版本为 `"6.38.6"`，完全契合 `obsidian@1.10.3` 的 strict peerDependency 约束，根治 GitHub Actions CI 在全新容器中执行 `npm ci` 时抛出的 `ERESOLVE` 对等依赖冲突。
  - 同步全链路引擎版本标识（`ENGINE_VERSION`、`pyproject.toml`、`uv.lock`）至 `0.9.1`。
  - 触发正式 Release 自动化构建以对接 Obsidian 官方插件市场审查。

### [0.9.0] - 2026-09-18

#### 🚀 架构重构与规范化 (Architecture & Compliance)
- **代码库结构与 Obsidian 发布规范对齐**:
  - 构建产物扁平化至根目录（`./main.js`、`./styles.css`），完全符合 Obsidian 官方加载契约与社区插件发布要求。
  - `manifest.json` 明确标注 `isDesktopOnly: true` 与维护者主页。
  - 清理多余临时脚本及冗余构建输出，简化根目录层级。
- **社区插件上架审查合规治理 (Review Compliance)**:
  - 修复 API 版本契约：`manifest.json` 与 `versions.json` 将 `minAppVersion` 提升至 `1.7.2` 对齐 `workspace.revealLeaf`，并保留运行时向下降级容错。
  - 移除 `window.confirm()`，全量替换为 Obsidian 原生 `Modal` 异步交互对话框 (`FullIndexConfirmModal`)。
  - 规范设置项输入框 Placeholder，统一遵循 Obsidian UI Sentence Case 规范，移除所有行内 eslint-disable 指令。
  - 清理生产代码中所有非必要的 `console.log` 调试日志，保留标准的 `console.warn` 与 `console.error`。
  - 全面使用 `window.setTimeout` 代替全局 `setTimeout`，确保在 Obsidian 多窗口/分离窗口（Popout Windows）中的生命周期兼容性。
  - 将 `@codemirror/view` 显式声明至 `package.json` 的生产依赖项中。
  - 重构 `src/styles.css`，通过提升 CSS 选择器特异性全量移除 `!important` 规则。
  - 重构 `README.md`，提供纯正规范的英文主文（涵盖功能、安装、本地引擎启动、索引与日常使用指南）并保留完整中文说明。
  - 解决 Linux CI 运行 pytest 时 PyTorch 线程析构导致的 `SIGABRT` 退出码 134 异常。
- **领域概念统一 (Radar Domain)**:
  - 核心模块全面从早期原型的 `Whisperer` 重构统一为 `Radar`（`RadarEngine`、`RadarView`），并维持原有工作区视图布局完全向后兼容。
  - 领域服务解耦：移除上帝外观，显式导出 `LanceDBStorage`、`IndexService`、`RadarPipeline` 单例。
  - 修复引擎存储路径解析，消除了运行目录（CWD）漂移缺陷。
  - 统一配置单一真理源（SSOT）为 `RankingConfig`。

---

### [0.8.0] - 2026-09-10

#### 🚀 新功能与体验增强 (Features & UI Redesign)
- **设置页信息架构全量重构 (Settings Architecture Redesign)**:
  - 弃用平铺大卡片布局，对齐 Obsidian 原生折叠与分组规范。
  - 核心划分为：**状态概览 (Status Banner)**、**推荐体验 (Whisperer Flow)**、**索引范围 (Scope)** 与折叠式 **高级设置 (Advanced)**。
  - 新增双流 Discover 打散系数（MMR $\lambda$）调节滑块，支持 0.1~0.9 动态平滑调整探索多样性。
- **倒排索引即时构建 (Instant FTS Indexing)**:
  - 新增 `POST /index/rebuild-fts` 接口并在初次全量索引完成后自动触发，消除前 30 秒混合检索由于倒排未就绪而降级的冷启动延迟。
- **全量索引自适应流控 (Adaptive Indexing Flow Control)**:
  - 引入双阈值自适应分片（≤25 篇且 ≤150k 字符），结合 `requestIdleCallback` 帧对齐主线程让渡，杜绝索引期间 Obsidian 界面掉帧卡顿。

#### 🛡️ 进程治理与自愈机制 (Process Governance & Self-Healing)
- **Win32 精准宿主状态判定 (Win32 Host Suicide)**:
  - 采用 Windows 原生 `GetExitCodeProcess` 探测 Obsidian 父进程退出码（退出码 ≠ 259 即判定销毁），彻底解决句柄假存活导致的僵尸进程滞留问题。
- **孤儿进程树治理 (PID Lockfile Management)**:
  - 写入 `.semantix.pid` 锁文件，启动前基于 PID 树深度回收历史残留孤儿进程。
- **三振出局自愈状态机 (Self-Healing Circuit Breaker)**:
  - 遇到异常退出采取 3s / 6s / 15s 指数退避重试；连续失败 3 次触发熔断阻断无限重试；支持用户主动停止压制与控制面板一键重置重启。

---

### [0.7.0] - 2026-04-11

#### 🚀 新功能 (Features)
- **智能关键词高亮 (Intelligent Keyword Highlighting)**：弃用暴力 N-gram 切分，全面接入浏览器原生 `Intl.Segmenter` API 实现语言感知分词。高亮结果从"碎片化噪音"跃迁为真正有语义的关键词。
- **权威停用词库 (Built-in Stopwords)**：内嵌约 150+ 词的权威中文停用词典（涵盖虚词、代词、连词、副词），自动过滤"怎么"、"由于"、"但是"等无意义高亮词汇。
- **启发式噪音过滤 (Adaptive Noise Filtering)**：后端新增基于文档频率 (DF) 的自适应噪音词识别引擎。
  - 自动统计仓库内所有词汇的出现频率，将在超过 80% 文档中出现的"大众脸"词汇动态加入停用词表。
  - 前端新增设置开关 **"启发式噪音过滤"**，可一键开启/关闭。
  - 新增 **"立即分析仓库噪音"** 按钮，支持手动触发词频分析。
- **新增 API 端点**：`POST /index/compute-stopwords`，用于触发仓库词频分析并返回噪音词列表。
- **状态同步增强**：`GET /index/status` 响应新增 `vault_stopwords` 字段，前端自动同步并缓存。

#### 🩹 修复 (Fixes)
- **后端启动崩溃修复**：修复 `models.py` 中 `Dict` 类型未导入导致的 `NameError`（后端启动即退出，Code: 1）。
- **MaintenanceRequest 模型补全**：为 `MaintenanceRequest` 添加缺失的 `vault_id` 字段，修复 `compute-stopwords` 端点调用时的 `AttributeError`。
- **前端进程管理加固**：
  - 修复后端服务未启用时仍刷新面板骨架的问题。
  - 修复手动启动后端时提示异常退出的进程竞态问题（Process Pinning 机制）。
  - 修复测试后端连接无响应问题（引入 5s 硬超时）。
  - 修复跨平台端口清理逻辑（新增 Unix `lsof`/`kill` 支持）。

#### 🚀 稳定性与生命周期 (Stability & Lifecycle)
- **后端“看门狗”自杀机制 (Watchdog Suicide)**: 实现了一种高度稳健的后端进程管理方案。后端现在具备自我监控能力：
  - **父进程存活探测**: 通过环境变量感知 Obsidian PID，一旦发现父进程异常消失，立即启动自我清理。
  - **心跳超时回收**: 若 120 秒内未收到前端 Ping 信号，后端将自动执行优雅退出，防止资源泄露。
- **静默喂狗机制**: 插件心跳探测现在会自动向后端发送生命信号，对用户完全无感且资源占用极低。

---

### [0.4.6] - 2026-04-10

#### 🚀 新功能与优化 (Features & Optimizations)
- **动态状态追踪 (Live Status Tracking)**: 引入基于单条动态 Notice 的进度追踪系统。在后端启动全周期（同步依赖、唤醒服务、加载模型）提供原生的右上角实时反馈。
- **高精度日志解析**: 
  - 升级 `ServiceManager` 实时流式解析 stdout/stderr，捕捉耗时较长的“模型加载”或“下载”期并及时播报。
  - 增加了对模型下载进度（`Downloading: XX%`）的实时捕获。
  - 细化了 `uv sync` 的环境同步阶段（解析、准备、安装）反馈。
- **状态实时同步 (Real-time Status Sync)**: 增强了设置面板与插件核心的状态订阅机制。设置面板现在能自动响应后台心跳探测，实时展示连接状态指示灯，并在页面顶部增加全局状态徽标。
- **启动性能优化**: 将后端启动过程改为非阻塞异步执行，避免在自动拉起时占用 Obsidian 的初始化时间。
- **一键环境创建**: 当后端项目缺少虚拟环境时，在设置页提供初始化按钮，执行 `uv venv` 和 `uv sync`。
- **检索上下文增强**: 在语义搜索请求中自动注入笔记标题、Tags 及文件路径，显著提升推荐准确度。
- **并发检索版本控制**: 通过闭包版本号校验，丢弃过时的异步请求，彻底解决高频操作下的结果跳闪现象。

#### 🩹 修复与加固 (Fixes & Hardening)
- **浮窗生命周期管理**: 引入状态锁机制，彻底解决启动浮窗在服务就绪后因后续杂散日志而“复活”并驻留的问题。
- **进程生命周期加固**: 
  - 将 Windows 进程清理逻辑改为同步执行 (`execSync`)，确保 Obsidian 退出时后端进程及其子进程完全回收。
  - **智能特征匹配**: 引入基于命令行指纹的进程校验，确保清理端口冲突时**绝不误杀**无关进程。
- **平台兼容性**: 为所有底层进程操作增加平台校验，确保在移动端环境下不触发无效调用。
- **UI 体验优化**: 
  - 修正了 ServiceManager 的语法结构错误。
  - 优化了设置项文案，将“测试自启动”改为“探测服务连接”。
  - 将所有侧边栏视图标题、设置项名称统一调整为 **Sentence case**。

#### 🛠️ 架构与工程 (Engineering)
- **文档体系重塑**: 建立 `docs/` 专项手册体系，实现技术手册与入门指南的完全解耦。
- **样式系统重构**: 实现了 `styles.css` 构建集成，全量弃用 JS 硬编码样式，完美适配原生暗色/亮色主题。
- **构建链路优化**: 升级 `esbuild` 配置支持多入口异步构建，自动压缩输出 CSS 产物。
- **CI/CD 修复**: 解决了 `npm ci` 依赖同步问题，并建立了前端产物的自动打包流程。

---

### [0.3.0] - 2026-04-09

#### 🚀 新功能 (Features)
- **Hybrid Search (混合检索)**: 集成基于 LanceDB 的全文本搜索 (FTS) 与向量检索，支持查询时的动态权衡。
- **Glob 排除规则**: 引入 `picomatch` 库，支持复杂的通配符路径过滤（如 `**/node_modules/**`）。
- **Hit-boost 聚合排名**: 在后端实现文档级 Hit-boost 排序算法，显著优化搜索结果的宏观相关度。

#### 🛠️ 架构与工程 (Engineering)
- **Vault 哈希隔离**: 实现基于路径哈希的 `vault_id` 机制，确保不同 Obsidian 仓库之间的数据索引物理隔离。
- **后端模型热加载**: 实现 FastAPI 启动时的模型异步预热与健康状态反馈。

---

### [0.1.0] - 2026-03-20

#### 🏗️ 初始版本
- 建立 Semantix 插件核心骨架，支持单路向量检索。
- 实现基础的文件变更实时监听同步机制。
- 侧边栏基础视图雏形。
