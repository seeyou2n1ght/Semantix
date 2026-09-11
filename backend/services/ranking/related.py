from typing import List
from services.ranking.features import CandidateFeatures
from services.ranking.labels import LabelResolver
from config import ranking_config


class RelatedRanker:
    """
    Related 强相关流精排器：
    聚焦当前思考点，综合语义匹配、精排 Logits 与词面特征，输出高度相关的笔记。
    """

    @staticmethod
    def rank(
        features: List[CandidateFeatures],
        top_k: int = 4,
        rerank_weight: float = ranking_config.RELATED_RERANK_WEIGHT,
        semantic_weight: float = ranking_config.RELATED_SEMANTIC_WEIGHT,
        lexical_weight: float = ranking_config.RELATED_LEXICAL_WEIGHT,
    ) -> List[CandidateFeatures]:
        if not features or top_k <= 0:
            return []

        for feat in features:
            # 基础相关度加权组合 (实验参数，可后续微调)
            relevance = (
                rerank_weight * feat.rerank_norm
                + semantic_weight * feat.semantic_norm
                + lexical_weight * feat.lexical_norm
            )
            # 亲和度轻量微调 (同目录/标签轻微加权)
            bonus = 0.0
            if feat.is_same_folder:
                bonus += 0.02
            if feat.tag_overlap > 0:
                bonus += min(feat.tag_overlap * 0.01, 0.03)

            feat.relevance_score = min(1.0, relevance + bonus)

        # 按相关度降序排列
        sorted_feats = sorted(features, key=lambda f: f.relevance_score, reverse=True)
        selected = sorted_feats[:top_k]

        # 赋予 Related 标签
        for feat in selected:
            feat.labels = LabelResolver.resolve_related_labels(feat)

        return selected
