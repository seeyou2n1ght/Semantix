import logging
from sentence_transformers import SentenceTransformer
from typing import List

logger = logging.getLogger("semantix")

class ModelService:
    def __init__(self, model_name: str = "BAAI/bge-small-zh-v1.5"):
        logger.info("Loading embedding model: %s...", model_name)
        # device='cpu' 适合 Raspberry Pi 等低功耗设备
        self.model = SentenceTransformer(model_name)
        self.embedding_dim = self.model.get_sentence_embedding_dimension()
        logger.info("Model loaded. Embedding dimension: %s", self.embedding_dim)

    def encode(self, texts: List[str]) -> List[List[float]]:
        # BGE 模型可添加指令前缀优化检索，MVP 阶段暂保持简单
        embeddings = self.model.encode(texts, normalize_embeddings=True)
        return embeddings.tolist()

# 单例实例
model_svc = ModelService()
