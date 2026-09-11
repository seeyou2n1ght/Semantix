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
        shared_links_count: int = 0,
        is_cross_folder_shared_tag: bool = False,
    ):
        self.candidate = candidate
        self.semantic_norm = semantic_norm
        self.rerank_norm = rerank_norm
        self.lexical_norm = lexical_norm
        self.is_direct_link = is_direct_link
        self.is_same_folder = is_same_folder
        self.tag_overlap = tag_overlap
        self.shared_links_count = shared_links_count
        self.is_cross_folder_shared_tag = is_cross_folder_shared_tag

        # 动态特征：在精排流水线中计算注入
        self.relevance_score: float = 0.0
        self.max_sim_to_related: float = 0.0
        self.discover_score: float = 0.0
        self.bridge_score: float = 0.0
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
        # 构造规范化路径集合与 Basename 集合，保障完整路径与未解析别名双向兼容
        def _norm_path(p: str) -> str:
            return os.path.splitext(p)[0].replace("\\", "/").strip("/").lower()

        def _base_name(p: str) -> str:
            return os.path.splitext(os.path.basename(p))[0].lower()

        curr_p_norm = _norm_path(current_path) if current_path else ""
        curr_p_base = _base_name(current_path) if current_path else ""

        curr_links_exact = set(current_links or [])
        curr_links_norm = {_norm_path(p) for p in curr_links_exact if p}
        curr_links_base = {_base_name(p) for p in curr_links_exact if p}

        feature_list: List[CandidateFeatures] = []

        for i, c in enumerate(candidates):
            sem_norm = ScoreNormalizer.normalize_cosine(c.semantic_score)
            
            # 如果有精排得分，使用精排归一化；否则回退为语义分
            if rerank_scores and i < len(rerank_scores):
                rr_norm = ScoreNormalizer.normalize_rerank_logit(rerank_scores[i])
            else:
                rr_norm = sem_norm

            lex_norm = norm_lexicals[i] if i < len(norm_lexicals) else 0.0

            # 链接关系检测 (双向直接出入链判断，兼容完整路径与文件名别名)
            cand_links_exact = set(c.links or [])
            cand_links_norm = {_norm_path(p) for p in cand_links_exact if p}
            cand_links_base = {_base_name(p) for p in cand_links_exact if p}

            cand_p_norm = _norm_path(c.path)
            cand_p_base = _base_name(c.path)

            is_linked = False
            if current_path:
                # 正向：当前笔记链接了候选笔记
                linked_forward = (
                    c.path in curr_links_exact
                    or cand_p_norm in curr_links_norm
                    or cand_p_base in curr_links_base
                )
                # 反向：候选笔记链接了当前笔记
                linked_backward = (
                    current_path in cand_links_exact
                    or curr_p_norm in cand_links_norm
                    or curr_p_base in cand_links_base
                )
                is_linked = linked_forward or linked_backward

            # 2-hop 共同引用桥梁检测：无直接链接，但双方共同链接了同一篇核心概念笔记
            # 同时计算精确路径交集与文件名交集，取最大匹配数
            shared_links = 0
            if not is_linked and (curr_links_exact or curr_links_base):
                exact_shared = len(curr_links_exact & cand_links_exact)
                norm_shared = len(curr_links_norm & cand_links_norm)
                base_shared = len(curr_links_base & cand_links_base)
                shared_links = max(exact_shared, norm_shared, base_shared)

            # 同目录判断
            item_dir = os.path.dirname(c.path).replace("\\", "/").strip("/")
            is_same_dir = bool(current_dir and item_dir and current_dir == item_dir)

            # 标签重叠与跨目录稀有标签检测
            shared_tags = len(current_tags_set & set(c.tags or []))
            is_cross_dir_tag = bool(not is_same_dir and shared_tags > 0)

            feat = CandidateFeatures(
                candidate=c,
                semantic_norm=sem_norm,
                rerank_norm=rr_norm,
                lexical_norm=lex_norm,
                is_direct_link=is_linked,
                is_same_folder=is_same_dir,
                tag_overlap=shared_tags,
                shared_links_count=shared_links,
                is_cross_folder_shared_tag=is_cross_dir_tag,
            )
            feature_list.append(feat)

        return feature_list
