import logging
import threading
import time
from sentence_transformers import SentenceTransformer
from typing import List, Optional

logger = logging.getLogger("semantix")


class ModelService:
    def __init__(self, model_name: str = "BAAI/bge-small-zh-v1.5"):
        self.model_name = model_name
        self._model: Optional[SentenceTransformer] = None
        self._embedding_dim: Optional[int] = None
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
            logger.info("Loading embedding model: %s...", self.model_name)
            self._model = SentenceTransformer(self.model_name)
            self._embedding_dim = self._model.get_sentence_embedding_dimension()
            logger.info("Model loaded. Embedding dimension: %s", self._embedding_dim)
        except Exception as e:
            self._load_error = e
            logger.error("Failed to load model: %s", e)
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
        return self._embedding_dim

    def _wait_for_load(self, timeout: float = 60.0):
        start = time.time()
        while self._loading and (time.time() - start) < timeout:
            time.sleep(0.1)

    def encode(self, texts: List[str]) -> List[List[float]]:
        self._wait_for_load()
        if self._model is None:
            raise RuntimeError(f"Model not available: {self._load_error}")
        embeddings = self._model.encode(texts, normalize_embeddings=True)
        return embeddings.tolist()


model_svc = ModelService()
