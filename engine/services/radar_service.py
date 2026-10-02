import logging
import time
from typing import List, Dict, Any, Optional
from services.embedding_service import embedding_service
from services.reranker_service import reranker_service
from services.retrieval_service import RetrievalService, RetrievalCandidate
from services.ranking.features import FeatureBuilder
from services.ranking.related import RelatedRanker
from services.ranking.discover import DiscoverRanker
from config import ranking_config

logger = logging.getLogger("semantix")


class RadarPipeline:
    """
    统一双流检索与排序管线：
    单次调用完成 Embedding -> 多路召回 -> 候选聚合 -> Cross-Encoder 精排 -> 双流分流 -> 标签解析。
    """

    def __init__(self, retrieval_svc: RetrievalService):
        self.retrieval_svc = retrieval_svc

    def execute(
        self,
        vault_id: str,
        query_text: str,
        current_path: Optional[str] = None,
        title: Optional[str] = None,
        heading: Optional[str] = None,
        current_tags: Optional[List[str]] = None,
        current_links: Optional[List[str]] = None,
        exclude_paths: Optional[List[str]] = None,
        top_k_related: int = 4,
        top_k_discover: int = 4,
        ranking_mode: str = "balanced",
        mmr_lambda: float = 0.65,
        enable_adaptive_filtering: bool = True,
        custom_stopwords: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        warnings: List[str] = []
        started = time.perf_counter()
        if not query_text or not query_text.strip():
            return {"related": [], "discover": []}

        # 1. 构建与索引分块端对称的结构化上下文 Query 文本
        structured_query_text = query_text
        if title or heading:
            file_basename = title.strip() if title else ""
            if file_basename.lower().endswith(".md"):
                file_basename = file_basename[:-3]
            heading_part = f" [{heading.strip()}]" if heading and heading.strip() else ""
            prefix = f"[{file_basename}]{heading_part}\n" if file_basename else (f"{heading_part.strip()}\n" if heading_part else "")
            structured_query_text = f"{prefix}{query_text}"

        # 生成带 BGE 检索前缀的 Query 向量
        query_vector = embedding_service.encode_query(structured_query_text)
        embedded = time.perf_counter()

        # 2. 分通道召回并按文档聚合候选池
        candidates = self.retrieval_svc.retrieve_candidates(
            vault_id=vault_id,
            query_vector=query_vector,
            query_text=query_text,
            enable_adaptive_filtering=enable_adaptive_filtering,
            custom_stopwords=custom_stopwords,
            exclude_paths=exclude_paths,
            candidate_limit=ranking_config.RECALL_CANDIDATE_LIMIT,
            warnings=warnings,
        )
        recalled = time.perf_counter()
        candidate_count = len(candidates)
        if not candidates:
            return {"related": [], "discover": [], "warnings": warnings}

        # 3. 根据精排模式决定 CrossEncoder 调用候选深度
        # Only a successfully reranked shortlist competes in reranking modes.
        rerank_scores: Optional[List[float]] = None
        if ranking_mode != "fast":
            rerank_limit = (
                ranking_config.RERANK_LIMIT_HIGH_QUALITY
                if ranking_mode == "high_quality"
                else ranking_config.RERANK_LIMIT_BALANCED
            )
            pool_for_rerank = candidates[:rerank_limit]
            texts_to_rerank = [f"[{c.full_path or c.title}]\n{c.snippet}" for c in pool_for_rerank]
            # 构造适合 CrossEncoder 的对称上下文 Query，保留标题前缀并控制在 300 字符内
            rerank_query = structured_query_text
            if len(rerank_query) > 300:
                if title or heading:
                    file_basename = title.strip() if title else ""
                    if file_basename.lower().endswith(".md"):
                        file_basename = file_basename[:-3]
                    heading_part = f" [{heading.strip()}]" if heading and heading.strip() else ""
                    prefix = f"[{file_basename}]{heading_part}\n" if file_basename else (f"{heading_part.strip()}\n" if heading_part else "")
                    remain_len = max(50, 300 - len(prefix))
                    rerank_query = f"{prefix}{query_text[:remain_len]}"
                else:
                    rerank_query = query_text[:300]
            try:
                rerank_scores = reranker_service.predict_scores(rerank_query, texts_to_rerank)
                if rerank_scores is not None:
                    if len(rerank_scores) != len(pool_for_rerank):
                        raise ValueError("Reranker score count does not match candidate count")
                    candidates = pool_for_rerank
            except Exception as e:
                logger.error("Reranking failed (%s), fallback to base semantic.", e)
                rerank_scores = None
            if rerank_scores is None:
                warnings.append("reranker_unavailable")

        # 4. 构建标准化特征
        reranked = time.perf_counter()
        features = FeatureBuilder.build_features(
            candidates=candidates,
            current_path=current_path,
            current_tags=current_tags,
            current_links=current_links,
            rerank_scores=rerank_scores,
            query_text=query_text,
        )

        # 5. Related 流排序
        related_selected = RelatedRanker.rank(
            features=features,
            top_k=top_k_related,
        )

        # 6. Discover 流排序 (基于互斥、Relevance Gate 与 MMR)
        discover_selected = DiscoverRanker.rank(
            all_features=features,
            related_selected=related_selected,
            current_path=current_path,
            top_k=top_k_discover,
            mmr_lambda=mmr_lambda,
        )
        logger.info(
            "Radar stages mode=%s candidates=%d ranked=%d embed_ms=%.2f recall_ms=%.2f rerank_ms=%.2f rank_ms=%.2f warnings=%s",
            ranking_mode, candidate_count, len(features),
            (embedded - started) * 1000, (recalled - embedded) * 1000,
            (reranked - recalled) * 1000, (time.perf_counter() - reranked) * 1000, warnings,
        )

        # 7. 打包为字典格式
        def to_card_dict(f, channel: str) -> Dict[str, Any]:
            score = f.relevance_score if channel == "related" else f.discover_score
            return {
                "id": f.candidate.path,
                "path": f.candidate.path,
                "title": f.candidate.title,
                "snippet": f.candidate.snippet,
                "source_text": f.candidate.source_text,
                "score": round(float(score), 4),
                "labels": f.labels,
                "matched_chunk_index": f.candidate.matched_chunk_index,
                "matched_terms": f.candidate.matched_terms,
            }

        return {
            "related": [to_card_dict(f, "related") for f in related_selected],
            "discover": [to_card_dict(f, "discover") for f in discover_selected],
            "warnings": warnings,
        }
