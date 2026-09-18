from typing import List
from services.ranking.features import CandidateFeatures
from config import ranking_config


class LabelResolver:
    """
    负责在分流后赋予机器标签码 (Label Codes)，解耦后端业务规则与前端 UI 多语言文本。
    遵循单徽章预算法则 (Badge Budget <= 1)，通过优先级仲裁输出唯一的最高认知价值徽章。
    """

    @staticmethod
    def resolve_related_labels(feat: CandidateFeatures) -> List[str]:
        labels: List[str] = []

        # 1. 潜在双链 (优先级最高)
        if feat.is_title_mentioned and feat.relevance_score >= ranking_config.LABEL_MISSING_LINK_MIN_REL:
            labels.append("MISSING_LINK")
        # 2. 孤岛唤醒
        elif feat.is_island and feat.relevance_score >= 0.50:
            labels.append("ISLAND_WAKE")
        # 3. 共同概念桥梁
        elif feat.shared_links_count > 0 and not feat.is_direct_link:
            if feat.concept_bridge_target:
                labels.append(f"CONCEPT_BRIDGE:{feat.concept_bridge_target}")
            else:
                labels.append("CONCEPT_BRIDGE")
        # 4. 语义共鸣 (纯语义暗线，极低字面重合)
        elif feat.lexical_norm <= ranking_config.LABEL_DEEP_ECHO_MAX_LEXICAL and (
            feat.rerank_norm >= ranking_config.LABEL_DEEP_ECHO_MIN_RERANK or feat.semantic_norm >= 0.75
        ):
            labels.append("DEEP_ECHO")
        # 5. 跨顶层目录跨域
        elif feat.is_cross_domain and feat.relevance_score >= ranking_config.LABEL_CROSS_DOMAIN_MIN_REL:
            labels.append("CROSS_DOMAIN")
        # 6. 标签关联
        elif feat.tag_overlap > 0:
            labels.append("TOPIC_TAG")

        # 严格遵守单卡至多 1 个徽章，不输出空洞兜底标签
        return labels[:1]

    @staticmethod
    def resolve_discover_labels(feat: CandidateFeatures) -> List[str]:
        labels: List[str] = []

        # 1. 潜在双链
        if feat.is_title_mentioned and feat.relevance_score >= ranking_config.LABEL_MISSING_LINK_MIN_REL:
            labels.append("MISSING_LINK")
        # 2. 孤岛唤醒
        elif feat.is_island and feat.discover_score >= 0.40:
            labels.append("ISLAND_WAKE")
        # 3. 共同概念桥梁
        elif feat.shared_links_count > 0 and not feat.is_direct_link:
            if feat.concept_bridge_target:
                labels.append(f"CONCEPT_BRIDGE:{feat.concept_bridge_target}")
            else:
                labels.append("CONCEPT_BRIDGE")
        # 4. 跨域灵感 (不同顶层分类目录)
        elif feat.is_cross_domain and feat.relevance_score >= ranking_config.LABEL_CROSS_DOMAIN_MIN_REL:
            labels.append("CROSS_DOMAIN")
        # 5. 语义共鸣
        elif feat.lexical_norm <= ranking_config.LABEL_DEEP_ECHO_MAX_LEXICAL and (
            feat.rerank_norm >= ranking_config.LABEL_DEEP_ECHO_MIN_RERANK or feat.semantic_norm >= 0.75
        ):
            labels.append("DEEP_ECHO")
        # 6. 标签关联
        elif feat.tag_overlap > 0:
            labels.append("TOPIC_TAG")

        # 严格遵守单卡至多 1 个徽章，不输出空洞兜底标签
        return labels[:1]
