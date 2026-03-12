import logging
import lancedb
import os
import pyarrow as pa
from typing import List, Dict, Any

from utils.chunker import split_into_chunks

logger = logging.getLogger("semantix")

COLLECTION_NAME = "semantix_notes"


class DatabaseService:
    def __init__(self, db_path: str = "./semantix_lance", dim: int = 512):
        logger.info("Initializing LanceDB at %s...", db_path)
        self.db = lancedb.connect(db_path)
        self.dim = dim
        self._init_collection()

    def _init_collection(self):
        schema = pa.schema(
            [
                pa.field("vault_id", pa.string()),
                pa.field("path", pa.string()),
                pa.field("chunk_index", pa.int32()),
                pa.field("vector", pa.list_(pa.float32(), self.dim)),
                pa.field("text", pa.string()),
            ]
        )

        if COLLECTION_NAME in self.db.table_names():
            self.table = self.db.open_table(COLLECTION_NAME)
            existing_fields = {field.name for field in self.table.schema}
            if "chunk_index" not in existing_fields:
                logger.warning(
                    "Existing table schema missing chunk_index, recreating table..."
                )
                self.db.drop_table(COLLECTION_NAME)
                self.table = self.db.create_table(COLLECTION_NAME, schema=schema)
                logger.info("Table recreated with chunk_index.")
            else:
                logger.info("Table %s already exists and opened.", COLLECTION_NAME)
        else:
            logger.info("Creating table %s with dim %s...", COLLECTION_NAME, self.dim)
            self.table = self.db.create_table(COLLECTION_NAME, schema=schema)
            logger.info("Table created.")

    def _escape_sql_string(self, s: str) -> str:
        return s.replace("'", "''")

    def _truncate_snippet(self, text: str, max_length: int = 120) -> str:
        """
        Truncate snippet to max_length characters, respecting word boundaries.
        """
        if not text:
            return ""
        if len(text) <= max_length:
            return text

        truncated = text[:max_length]
        last_space = truncated.rfind(" ")
        if last_space > max_length // 2:
            truncated = truncated[:last_space]

        return truncated.strip() + "..."

    def count_notes(self, vault_id: str = None) -> int:
        try:
            if not self.table:
                return 0
            if not vault_id:
                rows = self.table.to_list()
                unique_paths = set(row.get("path") for row in rows if row.get("path"))
                return len(unique_paths)

            try:
                query = (
                    self.table.search(None)
                    .where(f"vault_id = '{self._escape_sql_string(vault_id)}'")
                    .limit(10_000_000)
                )
                rows = query.to_list()
                unique_paths = set(row.get("path") for row in rows if row.get("path"))
                return len(unique_paths)
            except Exception:
                pass

            logger.warning(
                "Using slow fallback for count_notes with vault_id=%s", vault_id
            )
            rows = self.table.to_list()
            unique_paths = set(
                row.get("path")
                for row in rows
                if row.get("vault_id") == vault_id and row.get("path")
            )
            return len(unique_paths)
        except Exception as e:
            logger.error("Error counting notes: %s", e)
            return 0

    def delete_by_paths(self, vault_id: str, paths: List[str]):
        if not paths:
            return

        try:
            formatted_paths = ", ".join(
                [f"'{self._escape_sql_string(p)}'" for p in paths]
            )
            where_clause = f"vault_id = '{self._escape_sql_string(vault_id)}' AND path IN ({formatted_paths})"
            self.table.delete(where_clause)
            logger.info("Deleted %s notes (all chunks) from vector DB.", len(paths))
        except Exception as e:
            logger.error("Error deleting paths: %s", e)
            raise

    def upsert_documents(self, data: List[Dict[str, Any]]):
        """
        Index documents with automatic chunking.
        Each document is split into chunks, and each chunk gets its own embedding.
        """
        if not data:
            return

        try:
            from model_svc import model_svc

            paths_by_vault: Dict[str, List[str]] = {}
            for item in data:
                vault_id = item.get("vault_id")
                if not vault_id:
                    raise ValueError("Missing vault_id in upsert data")
                paths_by_vault.setdefault(vault_id, []).append(item["path"])

            for vault_id, paths in paths_by_vault.items():
                self.delete_by_paths(vault_id, paths)

            all_chunk_data = []

            for item in data:
                vault_id = item.get("vault_id")
                path = item.get("path")
                text = item.get("text", "")

                if not text or not text.strip():
                    continue

                chunks_with_idx = split_into_chunks(text)

                if not chunks_with_idx:
                    chunk_text = text[:500] if len(text) > 500 else text
                    chunks_with_idx = [(chunk_text, 0)]

                chunk_texts = [c[0] for c in chunks_with_idx]

                try:
                    embeddings = model_svc.encode(chunk_texts)
                except Exception as e:
                    logger.error("Failed to encode chunks for %s: %s", path, e)
                    continue

                for i, (chunk_text, para_idx) in enumerate(chunks_with_idx):
                    all_chunk_data.append(
                        {
                            "vault_id": vault_id,
                            "path": path,
                            "chunk_index": i,
                            "vector": embeddings[i],
                            "text": chunk_text,
                        }
                    )

            if all_chunk_data:
                self.table.add(all_chunk_data)
                logger.info(
                    "Indexed %s chunks from %s documents.",
                    len(all_chunk_data),
                    len(data),
                )

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
        """
        Search for similar chunks and aggregate by document path.
        Returns document-level results with the best matching chunk as snippet.
        """
        try:
            query = self.table.search(query_vector).metric("cosine").limit(top_k * 3)

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

            path_results: Dict[str, Dict[str, Any]] = {}

            for row in res_list:
                path = row["path"]
                distance = row["_distance"]
                similarity = 1 - distance
                chunk_text = row.get("text", "")
                chunk_index = row.get("chunk_index", 0)

                if path not in path_results or similarity > path_results[path]["score"]:
                    snippet = self._truncate_snippet(chunk_text, max_length=120)
                    path_results[path] = {
                        "path": path,
                        "score": similarity,
                        "snippet": snippet,
                        "matched_chunk_index": chunk_index,
                    }

            results = sorted(
                path_results.values(), key=lambda x: x["score"], reverse=True
            )
            return results[:top_k]

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
        """
        Legacy method - now equivalent to search() since chunking is done at index time.
        Kept for API compatibility.
        """
        return self.search(
            vault_id=vault_id,
            query_vector=query_vector,
            top_k=top_k,
            exclude_paths=exclude_paths,
            min_similarity=min_similarity,
        )

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
