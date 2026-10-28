import os
import sys
import logging
import threading
import time
from typing import List, Dict, Any, Optional
import torch
from sentence_transformers import CrossEncoder
from services.device_service import device_manager
from config.model_config import get_reranker_model, reranker_load_options

logger = logging.getLogger("semantix")


class RerankerService:
    """
    负责基于 CrossEncoder 的精排重打分服务。
    支持 GPU 优先加速与 CPU 容错回退。
    """

    def __init__(self, model_name: Optional[str] = None):
        self.model_name = model_name or get_reranker_model()
        self.model_revision = reranker_load_options(self.model_name).get("revision")
        self._model: Optional[CrossEncoder] = None
        self.active_device: Optional[str] = None
        self._loading = False
        self._load_error: Optional[Exception] = None
        self._lock = threading.Lock()

    def start_loading(self):
        is_testing = os.getenv("SEMANTIX_TESTING", "").lower() in ("1", "true") or "pytest" in sys.modules
        if is_testing:
            return
        with self._lock:
            if self._model is not None or self._loading or self._load_error is not None:
                return
            self._loading = True

        thread = threading.Thread(target=self._load_model, daemon=True)
        thread.start()

    def _load_model(self):
        try:
            target_device = device_manager.get_preferred_device()
            logger.info("Loading reranker model: %s on %s...", self.model_name, target_device)
            try:
                self._model = CrossEncoder(self.model_name, device=target_device, **reranker_load_options(self.model_name))
                self.active_device = target_device
            except Exception as load_err:
                if target_device != "cpu":
                    logger.warning(
                        "Failed to initialize reranker on %s (%s). Falling back to CPU.",
                        target_device,
                        load_err,
                    )
                    if target_device.startswith("cuda") and torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    self._model = CrossEncoder(self.model_name, device="cpu", **reranker_load_options(self.model_name))
                    self.active_device = "cpu"
                    device_manager.mark_fallback("reranker", str(load_err))
                else:
                    raise

            self._load_error = None
            logger.info("Reranker model loaded successfully on %s.", self.active_device)
        except Exception as e:
            self._model = None
            self.active_device = None
            self._load_error = e
            logger.error("Failed to load reranker: %s", e)
        finally:
            self._loading = False

    @property
    def load_error(self) -> Optional[Exception]:
        return self._load_error

    @property
    def status(self) -> str:
        if self._loading:
            return "loading"
        if self._load_error is not None:
            return "error"
        return "ready" if self.is_ready else "not_loaded"

    @property
    def is_ready(self) -> bool:
        return self._model is not None and not self._loading

    def predict_scores(self, query: str, texts: List[str]) -> Optional[List[float]]:
        """批量预测相关性原始 logits。带运行时 OOM 与计算异常自动降级回退。"""
        if not texts:
            return []
        if not self.is_ready:
            if not self._loading and self._model is None and self._load_error is None:
                self.start_loading()
            return None

        pairs = [[query, text] for text in texts]
        try:
            # CrossEncoder defaults to Sigmoid for a single label. The ranking
            # normalizer owns that conversion, so both inference paths need logits.
            raw_scores = self._model.predict(pairs, activation_fn=torch.nn.Identity())
            return [float(s) for s in raw_scores]
        except (torch.cuda.OutOfMemoryError, RuntimeError) as e:
            if self.active_device and self.active_device != "cpu":
                logger.warning(
                    "Error during reranker inference on %s (%s). Purging cache and falling back to CPU.",
                    self.active_device,
                    e,
                )
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                try:
                    if hasattr(self._model, "model"):
                        self._model.model = self._model.model.to("cpu")
                    self.active_device = "cpu"
                    device_manager.mark_fallback("reranker", f"Runtime inference failure: {e}")
                    raw_scores = self._model.predict(pairs, activation_fn=torch.nn.Identity())
                    return [float(s) for s in raw_scores]
                except Exception as cpu_error:
                    e = cpu_error
            self._load_error = e
            self._model = None
            self.active_device = None
            logger.error("Reranker inference unavailable: %s", e)
            return None



# 默认单例
reranker_service = RerankerService()
