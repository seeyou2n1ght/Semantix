import os
from typing import List, Dict, Any, Optional
from services.retrieval_service import RetrievalCandidate
from services.ranking.normalizer import ScoreNormalizer


class CandidateFeatures:
    """承载单条候选在当前上下文下的多维特征"""
    def __init__(
        self,
        candidate: RetrievalCandidate,
        semantic_norm: float,
        rerank_norm: float,
        lexical_norm: float,
        is_direct_link: bool,
        is_same_folder: bool,
        tag_overlap: int,
    ):
        self.candidate = candidate
        self.semantic_norm = semantic_norm
        self.rerank_norm = rerank_norm
        self.lexical_norm = lexical_norm
        self.is_direct_link = is_direct_link
        self.is_same_folder = is_same_folder
        self.tag_overlap = tag_overlap

        # 动态特征：在精排流水线中计算注入
        self.relevance_score: float = 0.0
        self.max_sim_to_related: float = 0.0
        self.discover_score: float = 0.0
        self.labels: List[str] = []


class FeatureBuilder:
    """负责将粗排候选项与上下文状态加工为标准化特征"""

    @staticmethod
    def build_features(
        candidates: List[RetrievalCandidate],
        current_path: Optional[str] = None,
        current_tags: Optional[List[str]] = None,
        current_links: Optional[List[str]] = None,
        rerank_scores: Optional[List[float]] = None,
    ) -> List[CandidateFeatures]:
        if not candidates:
            return []

        # 1. 词面分批次归一化
        raw_lexicals = [c.lexical_score for c in candidates]
        norm_lexicals = ScoreNormalizer.normalize_batch_lexical(raw_lexicals)

        current_dir = os.path.dirname(current_path).replace("\\", "/").strip("/") if current_path else None
        current_tags_set = set(current_tags or [])
        current_links_set = set(current_links or [])

        feature_list: List[CandidateFeatures] = []

        for i, c in enumerate(candidates):
            sem_norm = ScoreNormalizer.normalize_cosine(c.semantic_score)
            
            # 如果有精排得分，使用精排归一化；否则回退为语义分
            if rerank_scores and i < len(rerank_scores):
                rr_norm = ScoreNormalizer.normalize_rerank_logit(rerank_scores[i])
            else:
                rr_norm = sem_norm

            lex_norm = norm_lexicals[i] if i < len(norm_lexicals) else 0.0

            # 链接关系检测 (双向出入链判断)
            is_linked = (c.path in current_links_set) or (current_path in (c.links or []))

            # 同目录判断
            item_dir = os.path.dirname(c.path).replace("\\", "/").strip("/")
            is_same_dir = bool(current_dir and item_dir and current_dir == item_dir)

            # 标签重叠
            shared_tags = len(current_tags_set & set(c.tags or []))

            feat = CandidateFeatures(
                candidate=c,
                semantic_norm=sem_norm,
                rerank_norm=rr_norm,
                lexical_norm=lex_norm,
                is_direct_link=is_linked,
                is_same_folder=is_same_dir,
                tag_overlap=shared_tags,
            )
            feature_list.append(feat)

        return feature_list
