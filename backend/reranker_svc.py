import logging
from typing import List, Dict, Any, Optional
from services.reranker_service import reranker_service, RerankerService

logger = logging.getLogger("semantix")


class RerankerServiceFacade:
    """
    向后兼容门面 (Facade)，直接委托至统一的 RerankerService 单例。
    杜绝多实例重复加载造成的显存与内存浪费。
    """

    def __init__(self, service: Optional[RerankerService] = None):
        self._service = service or reranker_service

    @property
    def model_name(self) -> str:
        return self._service.model_name

    @property
    def is_ready(self) -> bool:
        return self._service.is_ready

    def start_loading(self):
        self._service.start_loading()

    def _normalize_score(self, x: float, exponent: float = 0.7) -> float:
        return self._service.normalize_score(x, exponent)

    def rerank(self, query: str, candidates: List[Dict[str, Any]], top_k: int = 10) -> List[Dict[str, Any]]:
        if not candidates:
            return []

        if not self._service.is_ready:
            if not self._service._loading and self._service._model is None:
                self._service.start_loading()
            return candidates[:top_k]

        try:
            texts = [c.get("snippet", "") for c in candidates]
            scores = self._service.predict_scores(query, texts)

            for i, score in enumerate(scores):
                normalized_score = self._normalize_score(score)
                if "score_details" not in candidates[i]:
                    candidates[i]["score_details"] = {}
                candidates[i]["score_details"]["semantic"] = normalized_score
                candidates[i]["rerank_score"] = normalized_score
                candidates[i]["score"] = normalized_score

            candidates.sort(key=lambda x: x["score"], reverse=True)
            return candidates[:top_k]
        except Exception as e:
            logger.error("Error during reranking in facade: %s", e)
            return candidates[:top_k]


# 全局单例别名
reranker_svc = RerankerServiceFacade(reranker_service)

