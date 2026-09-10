from typing import List
from services.ranking.features import CandidateFeatures


class LabelResolver:
    """
    负责在分流后赋予机器标签码 (Label Codes)，解耦后端业务规则与前端 UI 多语言文本。
    """

    @staticmethod
    def resolve_related_labels(feat: CandidateFeatures) -> List[str]:
        labels: List[str] = []
        if feat.lexical_norm >= 0.4:
            labels.append("KEYWORD_MATCH")
        elif feat.rerank_norm >= 0.7 or feat.semantic_norm >= 0.75:
            labels.append("DEEP_SEMANTIC")

        if feat.is_same_folder:
            labels.append("SAME_FOLDER")
        elif feat.tag_overlap > 0:
            labels.append("SHARED_TAGS")

        if not labels:
            labels.append("RELEVANT")

        # 保持在 1~2 个精炼标签
        return labels[:2]

    @staticmethod
    def resolve_discover_labels(feat: CandidateFeatures) -> List[str]:
        labels: List[str] = []
        if not feat.is_direct_link:
            labels.append("UNLINKED")

        if not feat.is_same_folder and feat.max_sim_to_related < 0.75:
            labels.append("CROSS_TOPIC")
        elif not feat.is_same_folder:
            labels.append("CROSS_FOLDER")
        elif feat.tag_overlap > 0:
            labels.append("SHARED_TAGS")

        if not labels:
            labels.append("SERENDIPITY")

        return labels[:2]
