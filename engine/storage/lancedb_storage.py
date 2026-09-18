import logging
import os
import json
import threading
import time
from typing import List, Dict, Any, Set, Optional
import pyarrow as pa
import lancedb
import jieba

logger = logging.getLogger("semantix")

COLLECTION_NAME = "semantix_notes"
INDEX_SCHEMA_VERSION = 1


class LanceDBStorage:
    """
    LanceDB 底层存储引擎：负责数据表初始化、Arrow Schema 版本校验、
    FTS 索引维护、增删改查以及物理压缩优化。
    """

    @staticmethod
    def tokenize_for_fts(text: str) -> str:
        """使用 jieba.cut_for_search 针对搜索倒排索引分词"""
        if not text:
            return ""
        return " ".join(jieba.cut_for_search(text))

    @staticmethod
    def prepare_fts_query(query: str) -> str:
        """使用 jieba.cut 对查询字符串进行分词"""
        if not query:
            return ""
        return " ".join(jieba.cut(query))

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
        self.vault_stopwords: Dict[str, Set[str]] = self._load_custom_stopwords()
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
                pa.field("fts_tokens", pa.string()),   # 全文检索分词内容 (支持中英文词级召回)
            ]
        )
        # 获取现有表名集合，优先使用现代 list_tables 接口避免 DeprecationWarning
        existing_tables: list[str] = []
        if hasattr(self.db, "list_tables"):
            tables_res = self.db.list_tables()
            if hasattr(tables_res, "tables"):
                existing_tables = list(tables_res.tables)
            elif isinstance(tables_res, (list, tuple)):
                existing_tables = [t for t in tables_res if isinstance(t, str)]
        elif hasattr(self.db, "table_names"):
            existing_tables = list(self.db.table_names())

        if COLLECTION_NAME in existing_tables:
            self.table = self.db.open_table(COLLECTION_NAME)
            existing_fields = {field.name for field in self.table.schema}
            # 如果缺少必要字段，触发重建
            if any(f not in existing_fields for f in ["parent_text", "full_path", "tags", "links"]):
                raise RuntimeError("Incompatible index schema; back up and explicitly rebuild the index")
            if "fts_tokens" not in existing_fields and hasattr(self.table, "add_columns"):
                try:
                    self.table.add_columns({"fts_tokens": "text"})
                except Exception as e:
                    logger.warning("Could not add fts_tokens column to existing table: %s", e)
            logger.info("Table %s opened with verified schema.", COLLECTION_NAME)
        else:
            logger.info("Creating table %s with dim %d...", COLLECTION_NAME, self.dim)
            self.table = self.db.create_table(COLLECTION_NAME, schema=schema)
            logger.info("Table %s created successfully.", COLLECTION_NAME)

    def _escape_sql_string(self, s: str) -> str:
        """
        转义 SQL 字符串字面量中的危险字符。
        LanceDB 的 where/delete 仅接受字符串谓词，无法参数化，
        因此需严格防御：剥离 null bytes、转义单引号与反斜杠。
        """
        s = s.replace("\x00", "")     # 剥离 null bytes
        s = s.replace("\\", "\\\\")   # 转义反斜杠
        s = s.replace("'", "''")      # 转义单引号
        return s

    def _validate_identifier(self, value: str, name: str = "value") -> str:
        """校验标识符（vault_id / path）不含明显的注入载荷"""
        if not value or not isinstance(value, str):
            raise ValueError(f"Invalid {name}: must be a non-empty string")
        # 拒绝包含 SQL 关键字与危险字符的输入
        if any(ch in value for ch in [";", "--", "/*", "*/"]):
            raise ValueError(f"Invalid {name}: contains disallowed characters")
        return value

    def _load_custom_stopwords(self) -> Dict[str, Set[str]]:
        if os.path.exists(self.stopword_file):
            try:
                with open(self.stopword_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        return {vid: set(words) for vid, words in data.items()}
                    elif isinstance(data, list):
                        return {"__default__": set(data)}
            except Exception as e:
                logger.error("Failed to load custom stopwords: %s", e)
        return {}

    def _save_custom_stopwords(self):
        try:
            os.makedirs(self.db_path, exist_ok=True)
            with open(self.stopword_file, "w", encoding="utf-8") as f:
                dump_data = {vid: sorted(list(words)) for vid, words in self.vault_stopwords.items()}
                json.dump(dump_data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error("Failed to save custom stopwords: %s", e)

    def get_vault_stopwords(self, vault_id: str) -> Set[str]:
        return self.vault_stopwords.get(vault_id, set())

    def set_vault_stopwords(self, vault_id: str, words: List[str]):
        # 重算结果是当前语料的完整快照，必须替换旧集合，避免陈旧噪音词永久残留。
        self.vault_stopwords[vault_id] = set(words)
        self._save_custom_stopwords()

    def count_notes(self, vault_id: Optional[str] = None) -> int:
        try:
            if self.table is None or self.table.count_rows() == 0:
                logger.info("count_notes: table empty or None (vault_id=%s)", vault_id)
                return 0
            import pyarrow.compute as pc

            if not vault_id:
                arrow_tbl = self.table.search().select(["vault_id", "path"]).limit(None).to_arrow()
                return len(set(zip(arrow_tbl.column("vault_id").to_pylist(), arrow_tbl.column("path").to_pylist())))

            escaped_vid = self._escape_sql_string(vault_id)
            arrow_tbl = self.table.search().where(f"vault_id = '{escaped_vid}'").select(["path"]).limit(None).to_arrow()
            cnt = len(pc.unique(arrow_tbl.column("path")))
            logger.info("count_notes: unique notes=%d for vault_id=%s", cnt, vault_id)
            return cnt
        except Exception as e:
            logger.error("Error counting notes: %s", e)
            raise

    def delete_by_paths(self, vault_id: str, paths: List[str]):
        if not paths or self.table is None:
            return
        self._validate_identifier(vault_id, "vault_id")
        try:
            formatted_paths = ", ".join([f"'{self._escape_sql_string(p)}'" for p in paths])
            where_clause = f"vault_id = '{self._escape_sql_string(vault_id)}' AND path IN ({formatted_paths})"
            self.table.delete(where_clause)
            logger.info("Deleted %d paths for vault_id=%s", len(paths), vault_id)
        except Exception as e:
            logger.error("Error deleting paths: %s", e)
            raise

    def clear_vault(self, vault_id: str):
        if self.table is None:
            return
        self._validate_identifier(vault_id, "vault_id")
        try:
            self.table.delete(f"vault_id = '{self._escape_sql_string(vault_id)}'")
            self.set_vault_stopwords(vault_id, [])
            logger.info("Cleared all notes for vault_id=%s", vault_id)
        except Exception as e:
            logger.error("Error clearing vault: %s", e)
            raise

    def clear_all(self):
        try:
            self.db.drop_table(COLLECTION_NAME)
            self._init_collection()
            self.vault_stopwords.clear()
            self._save_custom_stopwords()
            logger.info("Table cleared and recreated.")
        except Exception as e:
            logger.error("Error clearing table: %s", e)
            raise

    def insert_rows(self, rows: List[Dict[str, Any]]):
        if not rows or self.table is None:
            logger.warning("insert_rows skipped: rows=%s, table_is_none=%s", bool(rows), self.table is None)
            return
        try:
            self.table.add(rows)
            logger.info("insert_rows: successfully added %d rows, current table rows=%d", len(rows), self.table.count_rows())
        except Exception as e:
            logger.error("Error inserting rows to table: %s", e)
            raise

    def replace_documents(self, rows: List[Dict[str, Any]], paths_by_vault: Dict[str, Set[str]]):
        """Replace only successfully encoded documents in one Lance transaction.

        The scoped delete removes old surplus chunks when a note shrinks, while
        a failed merge leaves its previous version available.
        """
        if self.table is None:
            raise RuntimeError("Index table is unavailable")
        scopes = []
        for vault_id, paths in paths_by_vault.items():
            formatted = ", ".join(f"'{self._escape_sql_string(p)}'" for p in sorted(paths))
            scopes.append(f"(vault_id = '{self._escape_sql_string(vault_id)}' AND path IN ({formatted}))")
        if not scopes:
            return
        for r in rows:
            if "fts_tokens" not in r:
                r["fts_tokens"] = self.tokenize_for_fts(r.get("text", ""))
        data = pa.Table.from_pylist(rows, schema=self.table.schema)
        (self.table.merge_insert(["vault_id", "path", "chunk_index"])
         .when_matched_update_all()
         .when_not_matched_insert_all()
         .when_not_matched_by_source_delete(" OR ".join(scopes))
         .execute(data))

    def rebuild_fts_index(self):
        try:
            if self.table is not None:
                field_name = "fts_tokens" if "fts_tokens" in {f.name for f in self.table.schema} else "text"
                self.table.create_fts_index(field_name, replace=True)
                logger.info("FTS index on '%s' rebuilt successfully.", field_name)
        except Exception as e:
            logger.error("Failed to rebuild FTS index: %s", e)
            raise

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

    def optimize_database(self, retention_days: int = 0):
        from datetime import timedelta
        try:
            if self.table is None:
                return
            logger.info("Starting database optimization (retention: %d days)...", retention_days)
            # LanceDB 0.29+: optimize 执行 Compaction、Prune 与 Index 维护
            # cleanup_older_than 设为 retention_days（为 0 时清理所有历史版本，仅保留最新版，彻底回收空间）
            self.table.optimize(
                cleanup_older_than=timedelta(days=max(0, retention_days)),
                delete_unverified=True
            )
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
