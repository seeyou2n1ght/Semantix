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

    def upsert_documents(self, data: List[Dict[str, Any]]) -> int:
        return self.index_svc.upsert_documents(data)

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

    def compute_vault_stopwords(self, vault_id: str, threshold: float = 0.6) -> List[str]:
        return self.index_svc.compute_vault_stopwords(vault_id, threshold)

    def radar_search(
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
    ) -> Dict[str, List[Dict[str, Any]]]:
        """执行新版双流精排搜索"""
        return self.radar_pipeline.execute(
            vault_id=vault_id,
            query_text=query_text,
            current_path=current_path,
            current_tags=current_tags,
            current_links=current_links,
            exclude_paths=exclude_paths,
            top_k_related=top_k_related,
            top_k_discover=top_k_discover,
            ranking_mode=ranking_mode,
        )

    def search(
        self,
        vault_id: str,
        query_vector: List[float],
        top_k: int = 5,
        exclude_paths: Optional[List[str]] = None,
        min_similarity: float = 0.0,
        query_text: Optional[str] = None,
        current_path: Optional[str] = None,
        current_tags: Optional[List[str]] = None,
        current_links: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """
        向后兼容旧版 semantic search 接口。
        通过 RadarPipeline 检索出 related 列表，转为旧 SearchResultItem 格式。
        """
        radar_res = self.radar_search(
            vault_id=vault_id,
            query_text=query_text or "",
            current_path=current_path,
            current_tags=current_tags,
            current_links=current_links,
            exclude_paths=exclude_paths,
            top_k_related=top_k,
            top_k_discover=0,
            ranking_mode="balanced",
        )

        results = []
        for item in radar_res.get("related", []):
            results.append(
                {
                    "path": item["path"],
                    "score": item["score"],
                    "snippet": item["snippet"],
                    "matched_chunk_index": item.get("matched_chunk_index", 0),
                    "reasons": item.get("labels", []),
                    "score_details": {"relevance": item["score"]},
                }
            )
        return results


# 全局默认单例
DB_PATH = os.getenv("SEMANTIX_DB_PATH", "./semantix_lance").strip()
db_svc = DatabaseService(db_path=DB_PATH)

