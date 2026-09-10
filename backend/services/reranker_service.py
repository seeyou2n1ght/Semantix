import logging
import threading
import time
import math
from typing import List, Dict, Any, Optional
from sentence_transformers import CrossEncoder

logger = logging.getLogger("semantix")


class RerankerService:
    """
    负责基于 CrossEncoder 的精排重打分服务。
    """

    def __init__(self, model_name: str = "BAAI/bge-reranker-base"):
        self.model_name = model_name
        self._model: Optional[CrossEncoder] = None
        self._loading = False
        self._load_error: Optional[Exception] = None
        self._lock = threading.Lock()

    def start_loading(self):
        with self._lock:
            if self._model is not None or self._loading:
                return
            self._loading = True

        thread = threading.Thread(target=self._load_model, daemon=True)
        thread.start()

    def _load_model(self):
        try:
            logger.info("Loading reranker model: %s...", self.model_name)
            self._model = CrossEncoder(self.model_name)
            logger.info("Reranker model loaded successfully.")
        except Exception as e:
            self._load_error = e
            logger.error("Failed to load reranker: %s", e)
        finally:
            self._loading = False

    @property
    def is_ready(self) -> bool:
        return self._model is not None and not self._loading

    def normalize_score(self, x: float, exponent: float = 0.7) -> float:
        """
        Sigmoid + 幂函数非线性校准，映射到 [0, 1] 空间。
        """
        try:
            prob = 1.0 / (1.0 + math.exp(-x))
            return math.pow(prob, exponent)
        except OverflowError:
            return 0.0 if x < 0 else 1.0

    def predict_scores(self, query: str, texts: List[str]) -> List[float]:
        """批量预测相关性原始 logits"""
        if not texts:
            return []
        if not self.is_ready:
            if not self._loading and self._model is None:
                self.start_loading()
            return [0.0] * len(texts)

        pairs = [[query, text] for text in texts]
        raw_scores = self._model.predict(pairs)
        return [float(s) for s in raw_scores]


# 默认单例
reranker_service = RerankerService()
