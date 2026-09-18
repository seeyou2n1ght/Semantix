import logging
import os
from typing import List, Dict, Any, Optional, Set
from storage.lancedb_storage import LanceDBStorage
from services.embedding_service import embedding_service
from services.retrieval_service import RetrievalService
from services.index_service import IndexService
from services.radar_service import RadarPipeline

logger = logging.getLogger("semantix")


class DatabaseService:
    """
    Facade 适配器层：整合 Storage、IndexService、RetrievalService 与 RadarPipeline。
    在重构期间保持向后兼容，同时为 main.py 统一暴露领域服务。
    """

    def __init__(self, db_path: str = "./semantix_lance", dim: int = 512):
        self.storage = LanceDBStorage(db_path=db_path, dim=dim)
        self.retrieval_svc = RetrievalService(self.storage, embedding_service)
        self.index_svc = IndexService(self.storage, embedding_service)
        self.radar_pipeline = RadarPipeline(self.retrieval_svc)

    @property
    def vault_stopwords(self) -> Set[str]:
        return self.storage.vault_stopwords

    @property
    def table(self):
        return self.storage.table

    def close(self):
        self.storage.close()

    def count_notes(self, vault_id: Optional[str] = None) -> int:
        return self.storage.count_notes(vault_id)

    def upsert_documents(self, data: List[Dict[str, Any]]) -> Dict[str, Any]:
        return self.index_svc.upsert_documents(data)

    def get_vault_stopwords(self, vault_id: str) -> Set[str]:
        return self.storage.get_vault_stopwords(vault_id)

    def delete_by_paths(self, vault_id: str, paths: List[str]):
        self.storage.delete_by_paths(vault_id, paths)

    def clear_vault(self, vault_id: str):
        self.storage.clear_vault(vault_id)

    def clear_all(self):
        self.storage.clear_all()

    def rebuild_fts_index(self):
        self.storage.rebuild_fts_index()

    def mark_fts_dirty(self):
        self.storage.mark_fts_dirty()

    def maybe_rebuild_fts_index(self, min_interval_seconds: float = 30.0):
        self.storage.maybe_rebuild_fts_index(min_interval_seconds)

    def optimize_database(self, retention_days: int = 7):
        self.storage.optimize_database(retention_days)

    def get_storage_metrics(self) -> int:
        return self.storage.get_storage_metrics()

    def compute_vault_stopwords(self, vault_id: str, threshold: float = 0.3) -> List[str]:
        return self.index_svc.compute_vault_stopwords(vault_id, threshold)

    def radar_search(
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
    ) -> Dict[str, List[Dict[str, Any]]]:
        """执行双流精排搜索"""
        return self.radar_pipeline.execute(
            vault_id=vault_id,
            query_text=query_text,
            current_path=current_path,
            title=title,
            heading=heading,
            current_tags=current_tags,
            current_links=current_links,
            exclude_paths=exclude_paths,
            top_k_related=top_k_related,
            top_k_discover=top_k_discover,
            ranking_mode=ranking_mode,
            mmr_lambda=mmr_lambda,
        )


# 全局默认单例：基准化到 engine 目录下的 semantix_lance，避免受执行进程 CWD 漂移影响
_DEFAULT_DB_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "semantix_lance"))
_RAW_DB_PATH = os.getenv("SEMANTIX_DB_PATH", "").strip()
DB_PATH = os.path.abspath(_RAW_DB_PATH) if _RAW_DB_PATH else _DEFAULT_DB_DIR

db_svc = DatabaseService(db_path=DB_PATH)
storage = db_svc.storage
index_service = db_svc.index_svc
retrieval_service = db_svc.retrieval_svc
radar_pipeline = db_svc.radar_pipeline
