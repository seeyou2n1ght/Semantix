import logging
import os
import json
import threading
import time
from typing import List, Dict, Any, Set, Optional
import pyarrow as pa
import lancedb

logger = logging.getLogger("semantix")

COLLECTION_NAME = "semantix_notes"
INDEX_SCHEMA_VERSION = 1


class LanceDBStorage:
    """
    LanceDB 底层存储引擎：负责数据表初始化、Arrow Schema 版本校验、
    FTS 索引维护、增删改查以及物理压缩优化。
    """

    def __init__(self, db_path: str = "./semantix_lance", dim: int = 512):
        logger.info("Initializing LanceDBStorage at %s (dim=%d, schema_version=%d)...", db_path, dim, INDEX_SCHEMA_VERSION)
        self.db_path = db_path
        self.dim = dim
        self.db = lancedb.connect(db_path)
        self._fts_rebuild_lock = threading.Lock()
        self._fts_rebuild_in_progress = False
        self._fts_dirty = False
        self._last_fts_rebuild_at = 0.0
        self.stopword_file = os.path.join(db_path, "custom_stopwords.json")
        self.vault_stopwords: Set[str] = self._load_custom_stopwords()
        self.table = None
        self._init_collection()

    def close(self):
        """关闭数据库连接与清理"""
        try:
            if hasattr(self, "db") and self.db:
                logger.info("LanceDBStorage connection closing...")
                self.db = None
                self.table = None
        except Exception as e:
            logger.error("Error during LanceDBStorage shutdown: %s", e)

    def _init_collection(self):
        schema = pa.schema(
            [
                pa.field("vault_id", pa.string()),
                pa.field("path", pa.string()),
                pa.field("chunk_index", pa.int32()),
                pa.field("vector", pa.list_(pa.float32(), self.dim)),
                pa.field("text", pa.string()),          # 子块内容 (核心向量化目标)
                pa.field("parent_text", pa.string()),   # 父块内容 (展示与上下文)
                pa.field("full_path", pa.string()),     # 语义路径
                pa.field("tags", pa.list_(pa.string())),# 标签列表
                pa.field("links", pa.list_(pa.string())),# 出链列表
            ]
        )

        if COLLECTION_NAME in self.db.table_names():
            self.table = self.db.open_table(COLLECTION_NAME)
            existing_fields = {field.name for field in self.table.schema}
            # 如果缺少必要字段，触发重建
            if any(f not in existing_fields for f in ["parent_text", "full_path", "tags", "links"]):
                logger.warning("Schema mismatch detected, recreating table %s...", COLLECTION_NAME)
                self.db.drop_table(COLLECTION_NAME)
                self.table = self.db.create_table(COLLECTION_NAME, schema=schema)
            else:
                logger.info("Table %s opened with verified schema.", COLLECTION_NAME)
        else:
            logger.info("Creating table %s with dim %d...", COLLECTION_NAME, self.dim)
            self.table = self.db.create_table(COLLECTION_NAME, schema=schema)
            logger.info("Table %s created successfully.", COLLECTION_NAME)

    def _escape_sql_string(self, s: str) -> str:
        return s.replace("'", "''")

    def _load_custom_stopwords(self) -> Set[str]:
        if os.path.exists(self.stopword_file):
            try:
                with open(self.stopword_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return set(data)
            except Exception as e:
                logger.error("Failed to load custom stopwords: %s", e)
        return set()

    def _save_custom_stopwords(self):
        try:
            os.makedirs(self.db_path, exist_ok=True)
            with open(self.stopword_file, "w", encoding="utf-8") as f:
                json.dump(list(self.vault_stopwords), f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error("Failed to save custom stopwords: %s", e)

    def count_notes(self, vault_id: Optional[str] = None) -> int:
        try:
            if not self.table:
                return 0
            if not vault_id:
                rows = self.table.to_list(columns=["path"])
                return len({row.get("path") for row in rows if row.get("path")})

            try:
                where_clause = f"vault_id = '{self._escape_sql_string(vault_id)}'"
                rows = self.table.search(None).where(where_clause).select(["path"]).to_list()
                return len({row.get("path") for row in rows if row.get("path")})
            except Exception as e:
                logger.warning("Optimized count_notes failed (%s), falling back...", e)

            rows = self.table.to_list(columns=["path", "vault_id"])
            return len({row.get("path") for row in rows if row.get("vault_id") == vault_id and row.get("path")})
        except Exception as e:
            logger.error("Error counting notes: %s", e)
            return 0

    def delete_by_paths(self, vault_id: str, paths: List[str]):
        if not paths or not self.table:
            return
        try:
            formatted_paths = ", ".join([f"'{self._escape_sql_string(p)}'" for p in paths])
            where_clause = f"vault_id = '{self._escape_sql_string(vault_id)}' AND path IN ({formatted_paths})"
            self.table.delete(where_clause)
            logger.info("Deleted %d paths for vault_id=%s", len(paths), vault_id)
        except Exception as e:
            logger.error("Error deleting paths: %s", e)
            raise

    def clear_vault(self, vault_id: str):
        if not self.table:
            return
        try:
            self.table.delete(f"vault_id = '{self._escape_sql_string(vault_id)}'")
            logger.info("Cleared all notes for vault_id=%s", vault_id)
        except Exception as e:
            logger.error("Error clearing vault: %s", e)
            raise

    def clear_all(self):
        try:
            self.db.drop_table(COLLECTION_NAME)
            self._init_collection()
            logger.info("Table cleared and recreated.")
        except Exception as e:
            logger.error("Error clearing table: %s", e)
            raise

    def insert_rows(self, rows: List[Dict[str, Any]]):
        if not rows or not self.table:
            return
        try:
            self.table.add(rows)
        except Exception as e:
            logger.error("Error inserting rows to table: %s", e)
            raise

    def rebuild_fts_index(self):
        try:
            if self.table:
                self.table.create_fts_index("text", replace=True)
                logger.info("FTS index on 'text' rebuilt successfully.")
        except Exception as e:
            logger.error("Failed to rebuild FTS index: %s", e)

    def mark_fts_dirty(self):
        with self._fts_rebuild_lock:
            self._fts_dirty = True

    def maybe_rebuild_fts_index(self, min_interval_seconds: float = 30.0):
        with self._fts_rebuild_lock:
            if not self._fts_dirty:
                return
            if self._fts_rebuild_in_progress:
                return
            if (time.time() - self._last_fts_rebuild_at) < min_interval_seconds:
                return

            self._fts_rebuild_in_progress = True
            self._fts_dirty = False

        try:
            self.rebuild_fts_index()
            with self._fts_rebuild_lock:
                self._last_fts_rebuild_at = time.time()
        except Exception:
            with self._fts_rebuild_lock:
                self._fts_dirty = True
            raise
        finally:
            with self._fts_rebuild_lock:
                self._fts_rebuild_in_progress = False

    def optimize_database(self, retention_days: int = 7):
        from datetime import timedelta
        try:
            if not self.table:
                return
            logger.info("Starting database optimization (retention: %d days)...", retention_days)
            self.table.optimize()
            self.table.cleanup_old_versions(older_than=timedelta(days=retention_days))
            logger.info("Database optimization completed.")
        except Exception as e:
            logger.error("Failed to optimize database: %s", e)
            raise

    def get_storage_metrics(self) -> int:
        total_size = 0
        try:
            if not os.path.exists(self.db_path):
                return 0
            for dirpath, _, filenames in os.walk(self.db_path):
                for f in filenames:
                    fp = os.path.join(dirpath, f)
                    if os.path.exists(fp):
                        total_size += os.path.getsize(fp)
            return total_size
        except Exception as e:
            logger.error("Error calculating storage metrics: %s", e)
            return 0
