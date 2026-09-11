"""
Semantix 排序与检索核心参数单一配置源 (Single Source of Truth)
集中管理粗排深度、RRF 常数、加权配比、惩罚系数与桥梁奖励门槛。
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class RankingProfileV1:
    PROFILE_VERSION: str = "v1.2"

    # 召回与候选池深度
    RECALL_CANDIDATE_LIMIT: int = 45
    RERANK_LIMIT_BALANCED: int = 24
    RERANK_LIMIT_HIGH_QUALITY: int = 30

    # RRF 倒数排名融合常数
    RRF_K: float = 60.0
    HIT_BONUS_STEP: float = 0.05
    HIT_BONUS_MAX: float = 0.15

    # Related 流权重与微调加成
    RELATED_RERANK_WEIGHT: float = 0.50
    RELATED_SEMANTIC_WEIGHT: float = 0.35
    RELATED_LEXICAL_WEIGHT: float = 0.15
    RELATED_SAME_FOLDER_BOOST: float = 0.02
    RELATED_TAG_OVERLAP_BOOST: float = 0.01
    RELATED_MAX_TAG_BOOST: float = 0.03

    # Discover 流门控与惩罚/奖励参数
    DISCOVER_MIN_RELEVANCE: float = 0.45
    DISCOVER_HARD_DUPLICATE_THRESHOLD: float = 0.88
    DISCOVER_ALPHA_RELATED_PENALTY: float = 0.20
    DISCOVER_BETA_KNOWN_RELATION_PENALTY: float = 0.15
    DISCOVER_BRIDGE_SHARED_LINKS_UNIT: float = 0.04
    DISCOVER_BRIDGE_SHARED_LINKS_MAX: float = 0.08
    DISCOVER_BRIDGE_CROSS_TAG_UNIT: float = 0.03
    DISCOVER_BRIDGE_CROSS_TAG_MAX: float = 0.06
    DISCOVER_DEFAULT_MMR_LAMBDA: float = 0.65


# 全局默认单例
ranking_config = RankingProfileV1()
