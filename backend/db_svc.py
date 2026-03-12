import logging
import lancedb
import os
import pyarrow as pa
from collections import OrderedDict
from hashlib import md5
from typing import List, Dict, Any, Tuple

from utils.chunker import split_into_chunks

logger = logging.getLogger("semantix")

COLLECTION_NAME = "semantix_notes"


class DatabaseService:
    def __init__(self, db_path: str = "./semantix_lance", dim: int = 512):
        logger.info("Initializing LanceDB at %s...", db_path)
        self.db = lancedb.connect(db_path)
        self.dim = dim
        self._init_collection()
        self._chunk_cache: OrderedDict[str, Tuple[str, List[str], List[List[float]]]] = OrderedDict()
        self._chunk_cache_max = 256

    def _init_collection(self):
        # 使用 PyArrow 显式定义 LanceDB Schema
        schema = pa.schema(
            [
                pa.field("vault_id", pa.string()),
                pa.field("path", pa.string()),
                pa.field("vector", pa.list_(pa.float32(), self.dim)),
                pa.field("text", pa.string()),
            ]
        )

        if COLLECTION_NAME in self.db.table_names():
            self.table = self.db.open_table(COLLECTION_NAME)
            existing_fields = {field.name for field in self.table.schema}
            if "vault_id" not in existing_fields:
                logger.warning(
                    "Existing table schema missing vault_id, recreating table..."
                )
                self.db.drop_table(COLLECTION_NAME)
                self.table = self.db.create_table(COLLECTION_NAME, schema=schema)
                logger.info("Table recreated with vault_id.")
            else:
                logger.info("Table %s already exists and opened.", COLLECTION_NAME)
        else:
            # 表不存在则创建
            logger.info("Creating table %s with dim %s...", COLLECTION_NAME, self.dim)
            self.table = self.db.create_table(COLLECTION_NAME, schema=schema)
            logger.info("Table created.")

    def count_notes(self, vault_id: str = None) -> int:
        try:
            if not self.table:
                return 0
            if not vault_id:
                return len(self.table)
            try:
                return self.table.count_rows(
                    f"vault_id = '{self._escape_sql_string(vault_id)}'"
                )
            except (AttributeError, TypeError):
                logger.warning(
                    "count_rows not available, falling back to filter search"
                )
                try:
                    query = (
                        self.table.search(None)
                        .where(f"vault_id = '{self._escape_sql_string(vault_id)}'")
                        .limit(10_000_000)
                    )
                    return len(query.to_list())
                except Exception:
                    pass
            logger.warning(
                "Using slow fallback for count_notes with vault_id=%s", vault_id
            )
            rows = self.table.to_list()
            return sum(1 for row in rows if row.get("vault_id") == vault_id)
        except Exception as e:
            logger.error("Error counting notes: %s", e)
            return 0

    def _escape_sql_string(self, s: str) -> str:
        """
        转义字符串中的单引号以用于 SQL-like 查询。
        LanceDB 使用类 SQL 语法，单引号通过双写转义。
        """
        return s.replace("'", "''")

    def delete_by_paths(self, vault_id: str, paths: List[str]):
        if not paths:
            return

        try:
            # LanceDB 的 delete 使用类 SQL 的 where 子句
            formatted_paths = ", ".join(
                [f"'{self._escape_sql_string(p)}'" for p in paths]
            )
            where_clause = f"vault_id = '{self._escape_sql_string(vault_id)}' AND path IN ({formatted_paths})"
            self.table.delete(where_clause)
            logger.info("Deleted %s notes from vector DB.", len(paths))
        except Exception as e:
            logger.error("Error deleting paths: %s", e)
            raise

    def upsert_documents(self, data: List[Dict[str, Any]]):
        """
        data 中每个条目应包含: 'vector', 'path', 'text'
        LanceDB 支持基于 key(path) 的 merge_insert (upsert)。
        MVP 阶段使用先删后插的安全策略模拟 upsert。
        """
        if not data:
            return

        try:
            if hasattr(self.table, "merge_insert"):
                try:
                    self.table.merge_insert(
                        ["vault_id", "path"]
                    ).when_matched_update_all().when_not_matched_insert_all().execute(
                        data
                    )
                    logger.info("Upserted %s notes.", len(data))
                    return
                except Exception as e:
                    logger.warning("merge_insert failed, fallback to delete+add: %s", e)

            # Fallback: delete+add with per-vault scoping to avoid cross-vault stale rows
            paths_by_vault: Dict[str, List[str]] = {}
            for item in data:
                vault_id = item.get("vault_id")
                if not vault_id:
                    raise ValueError("Missing vault_id in upsert data")
                paths_by_vault.setdefault(vault_id, []).append(item["path"])

            for vault_id, paths in paths_by_vault.items():
                self.delete_by_paths(vault_id, paths)

            self.table.add(data)
            logger.info("Inserted %s notes.", len(data))
        except Exception as e:
            logger.error("Error inserting documents: %s", e)
            raise

    def search(
        self,
        vault_id: str,
        query_vector: List[float],
        top_k: int = 5,
        exclude_paths: List[str] = None,
        min_similarity: float = 0.0,
    ) -> List[Dict[str, Any]]:
        try:
            query = self.table.search(query_vector).metric("cosine").limit(top_k)

            # LanceDB 原生距离范围过滤
            if min_similarity > 0:
                max_distance = 1.0 - min_similarity
                query = query.distance_range(upper_bound=max_distance)

            where_clauses = [f"vault_id = '{self._escape_sql_string(vault_id)}'"]
            if exclude_paths and len(exclude_paths) > 0:
                formatted_paths = ", ".join(
                    [f"'{self._escape_sql_string(p)}'" for p in exclude_paths]
                )
                where_clauses.append(f"path NOT IN ({formatted_paths})")
            if where_clauses:
                query = query.where(" AND ".join(where_clauses))

            res_list = query.to_list()

            results = []
            for row in res_list:
                distance = row["_distance"]
                similarity = 1 - distance
                results.append(
                    {
                        "path": row["path"],
                        "score": similarity,
                        "snippet": row["text"][:200] + "..."
                        if len(row["text"]) > 200
                        else row["text"],
                    }
                )
            return results
        except Exception as e:
            logger.error("Error searching: %s", e)
            return []

    def search_with_context(
        self,
        vault_id: str,
        query_vector: List[float],
        top_k: int = 5,
        exclude_paths: List[str] = None,
        min_similarity: float = 0.0,
    ) -> List[Dict[str, Any]]:
        try:
            query = self.table.search(query_vector).metric("cosine").limit(top_k)

            if min_similarity > 0:
                max_distance = 1.0 - min_similarity
                query = query.distance_range(upper_bound=max_distance)

            where_clauses = [f"vault_id = '{self._escape_sql_string(vault_id)}'"]
            if exclude_paths and len(exclude_paths) > 0:
                formatted_paths = ", ".join(
                    [f"'{self._escape_sql_string(p)}'" for p in exclude_paths]
                )
                where_clauses.append(f"path NOT IN ({formatted_paths})")
            if where_clauses:
                query = query.where(" AND ".join(where_clauses))

            res_list = query.to_list()

            results = []
            for row in res_list:
                distance = row["_distance"]
                similarity = 1 - distance
                text = row.get("text", "") or ""

                snippet = text[:200] + "..." if len(text) > 200 else text
                matched_idx = None

                chunks, vectors = self._get_chunks_with_embeddings(
                    row.get("vault_id", vault_id), row.get("path", ""), text
                )
                if chunks and vectors:
                    matched_idx, _ = self._best_chunk(query_vector, vectors)
                    if matched_idx is not None and 0 <= matched_idx < len(chunks):
                        snippet = chunks[matched_idx]

                results.append(
                    {
                        "path": row["path"],
                        "score": similarity,
                        "snippet": snippet,
                        "matched_chunk_index": matched_idx,
                    }
                )
            return results
        except Exception as e:
            logger.error("Error searching with context: %s", e)
            return []

    def _best_chunk(self, query_vector: List[float], chunk_vectors: List[List[float]]) -> Tuple[int, float]:
        best_idx = 0
        best_score = -1.0
        for i, vec in enumerate(chunk_vectors):
            score = 0.0
            for q, v in zip(query_vector, vec):
                score += q * v
            if score > best_score:
                best_score = score
                best_idx = i
        return best_idx, best_score

    def _get_chunks_with_embeddings(
        self, vault_id: str, path: str, text: str
    ) -> Tuple[List[str], List[List[float]]]:
        if not text:
            return [], []

        cache_key = f"{vault_id}:{path}"
        text_hash = md5(text.encode("utf-8")).hexdigest()

        cached = self._chunk_cache.get(cache_key)
        if cached:
            cached_hash, cached_chunks, cached_vectors = cached
            if cached_hash == text_hash:
                self._chunk_cache.move_to_end(cache_key)
                return cached_chunks, cached_vectors

        chunks = split_into_chunks(text)
        if not chunks:
            return [], []

        from model_svc import model_svc

        vectors = model_svc.encode(chunks)

        self._chunk_cache[cache_key] = (text_hash, chunks, vectors)
        self._chunk_cache.move_to_end(cache_key)
        if len(self._chunk_cache) > self._chunk_cache_max:
            self._chunk_cache.popitem(last=False)

        return chunks, vectors

    def clear_vault(self, vault_id: str):
        try:
            self.table.delete(f"vault_id = '{self._escape_sql_string(vault_id)}'")
            logger.info("Cleared all notes for vault_id=%s", vault_id)
        except Exception as e:
            logger.error("Error clearing vault: %s", e)

    def clear_all(self):
        try:
            self.db.drop_table(COLLECTION_NAME)
            self._init_collection()
            logger.info("Table cleared and recreated.")
        except Exception as e:
            logger.error("Error clearing table: %s", e)
