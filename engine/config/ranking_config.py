"""
Semantix 排序与检索核心参数单一配置源 (Single Source of Truth)
集中管理粗排深度、RRF 常数、加权配比、惩罚系数与桥梁奖励门槛。
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class RankingConfig:
    PROFILE_VERSION: str = "v2.0"

    # 召回与候选池深度
    RECALL_CANDIDATE_LIMIT: int = 45
    RECALL_OVERFETCH_LIMIT: int = 80
    MAX_CHUNKS_PER_DOC_RECALL: int = 2
    RERANK_LIMIT_BALANCED: int = 16
    RERANK_LIMIT_HIGH_QUALITY: int = 20

    # RRF 倒数排名融合常数
    RRF_K: float = 60.0
    HIT_BONUS_STEP: float = 0.05
    HIT_BONUS_MAX: float = 0.15

    # Related 流权重、微调加成与拒答门控
    RELATED_RERANK_WEIGHT: float = 0.50
    RELATED_SEMANTIC_WEIGHT: float = 0.35
    RELATED_LEXICAL_WEIGHT: float = 0.15
    RELATED_SAME_FOLDER_BOOST: float = 0.02
    RELATED_TAG_OVERLAP_BOOST: float = 0.01
    RELATED_MAX_TAG_BOOST: float = 0.03
    RELATED_MIN_RELEVANCE: float = 0.35
    RELATED_DIRECT_LINK_THRESHOLD: float = 0.22

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

    # 特征标签仲裁阈值
    LABEL_MISSING_LINK_MIN_REL: float = 0.70
    LABEL_DEEP_ECHO_MAX_LEXICAL: float = 0.08
    LABEL_DEEP_ECHO_MIN_RERANK: float = 0.70
    LABEL_CROSS_DOMAIN_MIN_REL: float = 0.50


# 全局默认单例与向后兼容别名
ranking_config = RankingConfig()
RankingProfileV1 = RankingConfig
RankingProfile = RankingConfig
