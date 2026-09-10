import logging
from typing import List, Set, Optional
from services.ranking.features import CandidateFeatures
from services.ranking.mmr import select_by_mmr, cosine_similarity
from services.ranking.labels import LabelResolver

logger = logging.getLogger("semantix")


class DiscoverRanker:
    """
    Discover 意外关联流精排器 (v1 最小可行闭环)：
    Relevance Gate + Related 互斥 + 相似度惩罚 + MMR 多样性打散。
    确保“足够相关、不重复、且发现结果内部保持多样性”。
    """

    @staticmethod
    def rank(
        all_features: List[CandidateFeatures],
        related_selected: List[CandidateFeatures],
        current_path: Optional[str] = None,
        top_k: int = 4,
        min_relevance: float = 0.45,
        hard_duplicate_threshold: float = 0.88,
        alpha_related_penalty: float = 0.20,
        beta_known_relation_penalty: float = 0.15,
        mmr_lambda: float = 0.65,
    ) -> List[CandidateFeatures]:
        if not all_features or top_k <= 0:
            return []

        # 1. 排除当前笔记路径与已入选 Related 的笔记路径 (硬排除)
        excluded_paths: Set[str] = set()
        if current_path:
            excluded_paths.add(current_path)
        for r in related_selected:
            excluded_paths.add(r.candidate.path)

        # Related 已选卡片的向量集合
        related_vectors = [r.candidate.vector for r in related_selected if r.candidate.vector]

        filtered_pool: List[CandidateFeatures] = []

        for feat in all_features:
            if feat.candidate.path in excluded_paths:
                continue

            # 2. Relevance Gate：相关性硬门槛 (新颖度绝不能补偿不相关)
            # 使用已计算好的综合相关度或语义分
            relevance = feat.relevance_score if feat.relevance_score > 0 else (
                0.5 * feat.rerank_norm + 0.5 * feat.semantic_norm
            )
            if relevance < min_relevance:
                continue

            # 3. 计算与 Related 已选集合的最大相似度
            if related_vectors and feat.candidate.vector:
                sims = [cosine_similarity(feat.candidate.vector, rv) for rv in related_vectors]
                max_sim = max(sims) if sims else 0.0
            else:
                max_sim = 0.0
            feat.max_sim_to_related = max_sim

            # 4. Hard Duplicate Filter：若与 Related 某一卡片过于相似，直接剔除
            if max_sim >= hard_duplicate_threshold:
                continue

            # 5. 计算基础 Discover 分数：扣除 Related 重复度与已知结构关系 (已双链/同目录)
            known_relation = 0.0
            if feat.is_direct_link:
                known_relation += 1.0
            if feat.is_same_folder:
                known_relation += 0.5

            base_discover_score = (
                relevance
                - alpha_related_penalty * max_sim
                - beta_known_relation_penalty * known_relation
            )
            feat.discover_score = max(0.01, base_discover_score)
            filtered_pool.append(feat)

        if not filtered_pool:
            return []

        # 6. 使用 MMR 在候选池内部进行多样性贪心选择
        selected = select_by_mmr(
            candidates=filtered_pool,
            get_vector=lambda f: f.candidate.vector,
            get_score=lambda f: f.discover_score,
            top_k=top_k,
            lambda_param=mmr_lambda,
        )

        # 7. 赋予 Discover 机器标签
        for feat in selected:
            feat.labels = LabelResolver.resolve_discover_labels(feat)

        return selected
