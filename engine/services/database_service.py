"""Compose the shared storage, indexing and retrieval services."""
import os
from storage.lancedb_storage import LanceDBStorage
from services.embedding_service import embedding_service
from services.retrieval_service import RetrievalService
from services.index_service import IndexService
from services.radar_service import RadarPipeline

# 全局默认单例：基准化到 engine 目录下的 semantix_lance，避免受执行进程 CWD 漂移影响
_DEFAULT_DB_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "semantix_lance"))
_RAW_DB_PATH = os.getenv("SEMANTIX_DB_PATH", "").strip()
DB_PATH = os.path.abspath(_RAW_DB_PATH) if _RAW_DB_PATH else _DEFAULT_DB_DIR

storage = LanceDBStorage(db_path=DB_PATH)
index_service = IndexService(storage, embedding_service)
retrieval_service = RetrievalService(storage)
radar_pipeline = RadarPipeline(retrieval_service)
