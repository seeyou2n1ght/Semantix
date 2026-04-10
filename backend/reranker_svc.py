import logging
import threading
import time
import math
from sentence_transformers import CrossEncoder
from typing import List, Dict, Any, Optional

logger = logging.getLogger("semantix")

class RerankerService:
    def __init__(self, model_name: str = "BAAI/bge-reranker-base"):
        self.model_name = model_name
        self._model: Optional[CrossEncoder] = None
        self._loading = False
        self._load_error: Optional[Exception] = None
        self._lock = threading.Lock()
        
        # 默认不自动加载，只有在第一次被调用或显式启动时加载
        # 因为精排模型较大，我们让它懒加载或后台加载

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
            # CrossEncoder 会自动下载并加载模型
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

    def _sigmoid(self, x: float, offset: float = 1.1) -> float:
        """
        将原始 Logit 映射到 0-1 概率空间，并加入偏移量以对齐 UI 体感。
        Offset = 1.1 意味着 Logit=0 (模型认为中等相关) 时，输出约为 0.75 (对齐前端中位色)。
        """
        try:
            return 1 / (1 + math.exp(-(x + offset)))
        except OverflowError:
            return 0.0 if x < 0 else 1.0

    def rerank(self, query: str, candidates: List[Dict[str, Any]], top_k: int = 10) -> List[Dict[str, Any]]:
        """
        对召回候选进行精排
        candidates: 包含 'path', 'score', 'snippet' (通常来自 _aggregate_results)
        """
        if not candidates:
            return []
            
        if not self.is_ready:
            if not self._loading and self._model is None:
                self.start_loading()
            # 如果还没准备好，回退到原始排序
            return candidates[:top_k]

        try:
            # 构造 Cross-encoder 输入: [(query, text1), (query, text2), ...]
            # 我们使用候选中的 snippet (父块) 进行重排，因为它包含更多上下文
            pairs = [[query, c.get("snippet", "")] for c in candidates]
            
            # 执行推理 (通常 CrossEncoder 输出原始 logit)
            scores = self._model.predict(pairs)
            
            # 将新分数赋给候选，并重新排序
            for i, score in enumerate(scores):
                # 应用 Sigmoid 归一化和体感偏移
                normalized_score = self._sigmoid(float(score))
                
                candidates[i]["rerank_score"] = normalized_score
                # 保留原始分作为参考，但主序改为新分
                candidates[i]["score"] = normalized_score

            # 按精排分数降序排列
            candidates.sort(key=lambda x: x["score"], reverse=True)
            
            # 严格遵守 top_k 截断
            return candidates[:top_k]
            
        except Exception as e:
            logger.error("Error during reranking: %s", e)
            return candidates[:top_k]

reranker_svc = RerankerService()
