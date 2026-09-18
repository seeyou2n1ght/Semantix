import logging
import threading
import time
from typing import List, Optional
import torch
from sentence_transformers import SentenceTransformer
from services.device_service import device_manager

logger = logging.getLogger("semantix")

EMBEDDING_PROFILE_VERSION = "bge-small-zh-v1.5:semantix-v1"
BGE_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："


class EmbeddingService:
    """
    负责文本向量生成服务。
    使用 BAAI/bge-small-zh-v1.5 模型，对 Query 自动注入非对称检索前缀，
    对 Document Chunk 进行标准归一化向量化。
    支持 GPU 自动优先加速与 CPU 安全回退。
    """

    def __init__(self, model_name: str = "BAAI/bge-small-zh-v1.5"):
        self.model_name = model_name
        self.profile_version = EMBEDDING_PROFILE_VERSION
        self._model: Optional[SentenceTransformer] = None
        self._embedding_dim: Optional[int] = None
        self.active_device: Optional[str] = None
        self._loading = False
        self._load_error: Optional[Exception] = None
        self._lock = threading.Lock()

        self._start_async_load()

    def _start_async_load(self):
        self._loading = True
        thread = threading.Thread(target=self._load_model, daemon=True)
        thread.start()

    def _load_model(self):
        try:
            target_device = device_manager.get_preferred_device()
            logger.info(
                "Loading embedding model: %s on %s (profile: %s)...",
                self.model_name,
                target_device,
                self.profile_version,
            )
            try:
                self._model = SentenceTransformer(self.model_name, device=target_device)
                self.active_device = target_device
            except Exception as load_err:
                if target_device != "cpu":
                    logger.warning(
                        "Failed to initialize embedding model on %s (%s). Falling back to CPU.",
                        target_device,
                        load_err,
                    )
                    if target_device.startswith("cuda") and torch.cuda.is_available():
                        torch.cuda.empty_cache()
                    self._model = SentenceTransformer(self.model_name, device="cpu")
                    self.active_device = "cpu"
                    device_manager.mark_fallback("embedding", str(load_err))
                else:
                    raise

            self._embedding_dim = self._model.get_sentence_embedding_dimension()
            logger.info("Embedding model loaded on %s. Dimension: %s", self.active_device, self._embedding_dim)
        except Exception as e:
            self._load_error = e
            logger.error("Failed to load embedding model: %s", e)
        finally:
            self._loading = False

    @property
    def is_ready(self) -> bool:
        return self._model is not None and not self._loading

    @property
    def embedding_dim(self) -> int:
        self._wait_for_load()
        if self._model is None:
            raise RuntimeError(f"Model not loaded: {self._load_error}")
        return self._embedding_dim or 512

    def _wait_for_load(self, timeout: float = 60.0):
        start = time.time()
        while self._loading and (time.time() - start) < timeout:
            time.sleep(0.1)

    def encode(self, texts: List[str]) -> List[List[float]]:
        """通用文本批量向量化，带运行态显存溢出与设备异常自愈回退"""
        if not texts:
            return []
        self._wait_for_load()
        if self._model is None:
            raise RuntimeError(f"Model not available: {self._load_error}")
        try:
            embeddings = self._model.encode(texts, normalize_embeddings=True)
            return embeddings.tolist()
        except (torch.cuda.OutOfMemoryError, RuntimeError) as e:
            if self.active_device and self.active_device != "cpu":
                logger.warning(
                    "Error during embedding encode on %s (%s). Purging cache and falling back to CPU.",
                    self.active_device,
                    e,
                )
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                self._model = self._model.to("cpu")
                self.active_device = "cpu"
                device_manager.mark_fallback("embedding", f"Runtime inference failure: {e}")
                embeddings = self._model.encode(texts, normalize_embeddings=True)
                return embeddings.tolist()
            raise

    def encode_query(self, query: str) -> List[float]:
        """带 BGE 检索前缀的单句向量生成"""
        prefix_query = f"{BGE_QUERY_PREFIX}{query.strip()}"
        return self.encode([prefix_query])[0]


# 默认单例
embedding_service = EmbeddingService()
