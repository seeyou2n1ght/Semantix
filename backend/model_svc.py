import logging
from typing import List, Optional
from services.embedding_service import embedding_service, EmbeddingService

logger = logging.getLogger("semantix")


class ModelService:
    """
    向后兼容门面 (Facade)，直接委托至统一的 EmbeddingService 单例。
    杜绝多实例重复加载造成的显存与内存浪费。
    """

    def __init__(self, service: Optional[EmbeddingService] = None):
        self._service = service or embedding_service

    @property
    def model_name(self) -> str:
        return self._service.model_name

    @property
    def is_ready(self) -> bool:
        return self._service.is_ready

    @property
    def embedding_dim(self) -> int:
        return self._service.embedding_dim

    def encode(self, texts: List[str]) -> List[List[float]]:
        return self._service.encode(texts)

    def encode_query(self, query: str) -> List[float]:
        return self._service.encode_query(query)


# 全局单例别名
model_svc = ModelService(embedding_service)

