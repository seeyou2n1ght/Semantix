import logging
from typing import List, Dict, Any, Optional
from services.embedding_service import embedding_service
from services.reranker_service import reranker_service
from services.retrieval_service import RetrievalService, RetrievalCandidate
from services.ranking.features import FeatureBuilder
from services.ranking.related import RelatedRanker
from services.ranking.discover import DiscoverRanker

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
        current_tags: Optional[List[str]] = None,
        current_links: Optional[List[str]] = None,
        exclude_paths: Optional[List[str]] = None,
        top_k_related: int = 4,
        top_k_discover: int = 4,
        ranking_mode: str = "balanced",
        mmr_lambda: float = 0.65,
    ) -> Dict[str, List[Dict[str, Any]]]:
        if not query_text or not query_text.strip():
            return {"related": [], "discover": []}

        # 1. 生成带 BGE 检索前缀的 Query 向量
        query_vector = embedding_service.encode_query(query_text)

        # 2. 召回粗排候选池 (Recall 40~50 -> Doc Aggregation 25~30)
        candidates = self.retrieval_svc.retrieve_candidates(
            vault_id=vault_id,
            query_vector=query_vector,
            query_text=query_text,
            exclude_paths=exclude_paths,
            candidate_limit=45,
        )
        if not candidates:
            return {"related": [], "discover": []}

        # 3. 根据精排模式决定 CrossEncoder 调用候选深度
        # fast: 0; balanced: 24; high_quality: 30
        rerank_scores: Optional[List[float]] = None
        if ranking_mode != "fast":
            rerank_limit = 24 if ranking_mode == "balanced" else 30
            pool_for_rerank = candidates[:rerank_limit]
            texts_to_rerank = [c.snippet or c.title for c in pool_for_rerank]
            try:
                rerank_scores = reranker_service.predict_scores(query_text, texts_to_rerank)
            except Exception as e:
                logger.error("Reranking failed (%s), fallback to base semantic.", e)
                rerank_scores = None

        # 4. 构建标准化特征
        features = FeatureBuilder.build_features(
            candidates=candidates,
            current_path=current_path,
            current_tags=current_tags,
            current_links=current_links,
            rerank_scores=rerank_scores,
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

        # 7. 打包为字典格式
        def to_card_dict(f, channel: str) -> Dict[str, Any]:
            score = f.relevance_score if channel == "related" else f.discover_score
            return {
                "id": f.candidate.path,
                "path": f.candidate.path,
                "title": f.candidate.title,
                "snippet": f.candidate.snippet,
                "score": round(float(score), 4),
                "labels": f.labels,
                "matched_chunk_index": f.candidate.matched_chunk_index,
            }

        return {
            "related": [to_card_dict(f, "related") for f in related_selected],
            "discover": [to_card_dict(f, "discover") for f in discover_selected],
        }
