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
        is_title_mentioned: bool = False,
        is_cross_domain: bool = False,
        is_island: bool = False,
        concept_bridge_target: Optional[str] = None,
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
        self.is_title_mentioned = is_title_mentioned
        self.is_cross_domain = is_cross_domain
        self.is_island = is_island
        self.concept_bridge_target = concept_bridge_target

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
        query_text: Optional[str] = None,
    ) -> List[CandidateFeatures]:
        if not candidates:
            return []

        # 1. 词面分批次归一化
        raw_lexicals = [c.lexical_score for c in candidates]
        norm_lexicals = ScoreNormalizer.normalize_batch_lexical(raw_lexicals)

        current_dir = os.path.dirname(current_path).replace("\\", "/").strip("/") if current_path else None
        current_tags_set = {t.lstrip("#").lower() for t in (current_tags or []) if t}

        # 构造规范化路径集合与未解析别名集合，仅对不含路径的别名回退至 basename
        def _norm_path(p: str) -> str:
            return os.path.splitext(p)[0].replace("\\", "/").strip("/").lower()

        def _base_name(p: str) -> str:
            return os.path.splitext(os.path.basename(p))[0].lower()

        curr_p_norm = _norm_path(current_path) if current_path else ""
        curr_p_base = _base_name(current_path) if current_path else ""

        curr_links_exact = set(current_links or [])
        curr_links_norm = {_norm_path(p) for p in curr_links_exact if p}
        curr_links_unresolved = {_base_name(p) for p in curr_links_exact if p and "/" not in p.replace("\\", "/")}

        query_clean = query_text.strip().lower() if query_text else ""

        feature_list: List[CandidateFeatures] = []

        for i, c in enumerate(candidates):
            sem_norm = ScoreNormalizer.normalize_cosine(c.semantic_score)
            
            # 如果有精排得分，使用精排归一化；否则回退为语义分
            if rerank_scores and i < len(rerank_scores):
                rr_norm = ScoreNormalizer.normalize_rerank_logit(rerank_scores[i])
            else:
                rr_norm = sem_norm

            lex_norm = norm_lexicals[i] if i < len(norm_lexicals) else 0.0

            # 链接关系检测：精准规范路径优先，无路径别名才允许 basename 兜底
            cand_links_exact = set(c.links or [])
            cand_links_norm = {_norm_path(p) for p in cand_links_exact if p}
            cand_links_unresolved = {_base_name(p) for p in cand_links_exact if p and "/" not in p.replace("\\", "/")}

            cand_p_norm = _norm_path(c.path)
            cand_p_base = _base_name(c.path)

            is_linked = False
            if current_path:
                # 正向：当前笔记链接了候选笔记
                linked_forward = (
                    c.path in curr_links_exact
                    or cand_p_norm in curr_links_norm
                    or cand_p_base in curr_links_unresolved
                )
                # 反向：候选笔记链接了当前笔记
                linked_backward = (
                    current_path in cand_links_exact
                    or curr_p_norm in cand_links_norm
                    or curr_p_base in cand_links_unresolved
                )
                is_linked = linked_forward or linked_backward

            # 2-hop 共同引用桥梁检测：无直接链接，但双方共同链接了同一篇核心概念笔记
            shared_links = 0
            concept_bridge_target: Optional[str] = None
            if not is_linked and (curr_links_norm or curr_links_unresolved):
                norm_shared = curr_links_norm & cand_links_norm
                unresolved_shared = curr_links_unresolved & cand_links_unresolved
                shared_links = max(len(norm_shared), len(unresolved_shared))
                if norm_shared:
                    first_shared = sorted(list(norm_shared))[0]
                    concept_bridge_target = os.path.splitext(os.path.basename(first_shared))[0]
                elif unresolved_shared:
                    concept_bridge_target = sorted(list(unresolved_shared))[0]

            # 同目录与跨顶层目录（跨域）判断
            item_dir = os.path.dirname(c.path).replace("\\", "/").strip("/")
            is_same_dir = bool(current_dir and item_dir and current_dir == item_dir)
            is_cross_domain = False
            if current_dir and item_dir and not is_same_dir:
                curr_tld = current_dir.split("/")[0]
                cand_tld = item_dir.split("/")[0]
                if curr_tld and cand_tld and curr_tld != cand_tld:
                    is_cross_domain = True

            # 标签重叠与跨目录稀有标签检测（统一去除 # 前缀并忽略大小写）
            cand_tags_set = {t.lstrip("#").lower() for t in (c.tags or []) if t}
            shared_tags = len(current_tags_set & cand_tags_set)
            is_cross_dir_tag = bool(not is_same_dir and shared_tags > 0)

            # 潜在双链检测 (正文出现标题，但未用 [[]] 包裹且未直接建链)
            is_title_mentioned = False
            raw_title = c.title.strip() if c.title else cand_p_base
            if query_clean and len(raw_title) >= 3 and not is_linked:
                title_lower = raw_title.lower()
                if title_lower in query_clean and f"[[{title_lower}]]" not in query_clean:
                    is_title_mentioned = True

            # 沉睡孤岛检测 (候选笔记出链为0，且未直接建链)
            is_island = bool(len(cand_links_exact) == 0 and not is_linked)

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
                is_title_mentioned=is_title_mentioned,
                is_cross_domain=is_cross_domain,
                is_island=is_island,
                concept_bridge_target=concept_bridge_target,
            )
            feature_list.append(feat)

        return feature_list
