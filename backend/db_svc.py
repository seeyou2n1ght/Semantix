import logging
import lancedb
import os
import pyarrow as pa
import threading
import time
from typing import List, Dict, Any

from utils.chunker import split_into_chunks

logger = logging.getLogger("semantix")

COLLECTION_NAME = "semantix_notes"


class DatabaseService:
    def __init__(self, db_path: str = "./semantix_lance", dim: int = 512):
        logger.info("Initializing LanceDB at %s...", db_path)
        self.db_path = db_path
        self.db = lancedb.connect(db_path)
        self.dim = dim
        self._fts_rebuild_lock = threading.Lock()
        self._fts_rebuild_in_progress = False
        self._fts_dirty = False
        self._last_fts_rebuild_at = 0.0
        self._init_collection()

    def close(self):
        """Close the database connection and cleanup."""
        try:
            if hasattr(self, 'db') and self.db:
                # LanceDB handles closing via garbage collection/reference count usually,
                # but we can ensure resources are released if specific logic is needed.
                logger.info("LanceDB connection closing...")
                self.db = None
                self.table = None
        except Exception as e:
            logger.error("Error during DatabaseService shutdown: %s", e)

    def _init_collection(self):
        schema = pa.schema(
            [
                pa.field("vault_id", pa.string()),
                pa.field("path", pa.string()),
                pa.field("chunk_index", pa.int32()),
                pa.field("vector", pa.list_(pa.float32(), self.dim)),
                pa.field("text", pa.string()),          # 子块内容 (被向量化的核心)
                pa.field("parent_text", pa.string()),   # 父块或上下文内容 (用于展示)
                pa.field("full_path", pa.string()),     # 语义路径
                pa.field("tags", pa.list_(pa.string())),# 标签数组
                pa.field("links", pa.list_(pa.string())),# 出链数组
            ]
        )

        if COLLECTION_NAME in self.db.table_names():
            self.table = self.db.open_table(COLLECTION_NAME)
            existing_fields = {field.name for field in self.table.schema}
            # 如果缺少新字段，则触发重建
            if any(f not in existing_fields for f in ["parent_text", "full_path", "tags", "links"]):
                logger.warning(
                    "Schema mismatch (missing parent_text/full_path/tags/links), recreating table for context awareness..."
                )
                self.db.drop_table(COLLECTION_NAME)
                self.table = self.db.create_table(COLLECTION_NAME, schema=schema)
            else:
                logger.info("Table %s already exists and opened with new schema.", COLLECTION_NAME)
        else:
            logger.info("Creating table %s with dim %s and optimized schema...", COLLECTION_NAME, self.dim)
            self.table = self.db.create_table(COLLECTION_NAME, schema=schema)
            logger.info("Table created.")

    def _escape_sql_string(self, s: str) -> str:
        return s.replace("'", "''")

    def _truncate_snippet(self, text: str, max_length: int = 200) -> str:
        """
        Return snippet for frontend processing.
        Frontend will focus on matched keywords.
        """
        if not text:
            return ""
        if len(text) <= max_length:
            return text

        last_space = text.rfind(" ", max_length - 50, max_length)
        if last_space > 0:
            return text[:last_space].strip()

        return text[:max_length].strip()

    def count_notes(self, vault_id: str = None) -> int:
        try:
            if not self.table:
                return 0
            
            # 优化：只选取 'path' 列，避免拉取所有字段 (包括向量)，极大减少内存和带宽
            if not vault_id:
                # 获取所有不重复的路径
                rows = self.table.to_list(columns=["path"])
                unique_paths = {row.get("path") for row in rows if row.get("path")}
                return len(unique_paths)

            # 指定 vault_id 的情况
            try:
                # 尽量通过 pushdown 过滤
                where_clause = f"vault_id = '{self._escape_sql_string(vault_id)}'"
                rows = self.table.search(None).where(where_clause).select(["path"]).to_list()
                unique_paths = {row.get("path") for row in rows if row.get("path")}
                return len(unique_paths)
            except Exception as e:
                logger.warning("Optimized count_notes failed: %s, falling back...", e)

            # 通用回退方案
            rows = self.table.to_list(columns=["path", "vault_id"])
            unique_paths = {
                row.get("path")
                for row in rows
                if row.get("vault_id") == vault_id and row.get("path")
            }
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
                tags = item.get("tags", [])
                links = item.get("links", [])

                # 保护逻辑：如果单篇文档超过 50,000 字符，进行截断，防止正则切块导致 CPU 挂起
                if len(text) > 50000:
                    logger.warning("Document at %s is too large (%d chars), truncating to 50,000.", path, len(text))
                    text = text[:50000]

                if not text or not text.strip():
                    continue

                chunks_with_idx = split_into_chunks(text)

                if not chunks_with_idx:
                    fallback = text[:500] if len(text) > 500 else text
                    chunks_with_idx = [(fallback, fallback, 0, "")]

                file_basename = os.path.basename(path)
                if file_basename.lower().endswith(".md"):
                    file_basename = file_basename[:-3]

                chunks_for_encoding = []
                for parent_text, child_text, _, h_str in chunks_with_idx:
                    header_part = f" [{h_str}]" if h_str else ""
                    enriched_text = f"[{file_basename}]{header_part}\n{child_text}"
                    chunks_for_encoding.append(enriched_text)

                try:
                    embeddings = model_svc.encode(chunks_for_encoding)
                except Exception as e:
                    logger.error("Failed to encode chunks for %s: %s", path, e)
                    continue

                for i, (parent_text, child_text, para_idx, h_str) in enumerate(chunks_with_idx):
                    # 构造语义路径 (语义标签化)
                    # 组合: [目录路径] > [文件名] > [标题层级]
                    dir_name = os.path.dirname(path).replace("\\", "/").strip("/")
                    full_semantic_path = f"{dir_name} > {file_basename}" if dir_name else file_basename
                    if h_str:
                        full_semantic_path += f" > {h_str}"

                    all_chunk_data.append(
                        {
                            "vault_id": vault_id,
                            "path": path,
                            "chunk_index": i,
                            "vector": embeddings[i],
                            "text": child_text,           # 子块 (用于召回打分)
                            "parent_text": parent_text,    # 父块 (用于上下文展示)
                            "full_path": full_semantic_path,
                            "tags": tags,
                            "links": links,
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

    def rebuild_fts_index(self):
        try:
            # Rebuild Lance native Full Text Search index for hybrid queries
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

    def search(
        self,
        vault_id: str,
        query_vector: List[float],
        top_k: int = 5,
        exclude_paths: List[str] = None,
        min_similarity: float = 0.0,
        query_text: str = None,
        current_path: str = None,
        current_tags: List[str] = None,
        current_links: List[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Search for similar chunks and aggregate by document path.
        Returns document-level results with the best matching chunk as snippet.
        """
        try:
            # 放大候选池，确保去重后仍有足够候选进行精排
            # 基础召回量扩大到 top_k 的 10 倍，最少 50 条，给精排留出足够空间
            candidate_limit = max(top_k * 10, 50)

            is_hybrid = False
            # 只对短查询启用 hybrid；长查询（如 document 模式）走纯向量，
            # 避免过长 FTS query 拉高延迟且污染 lexical 信号
            use_hybrid = query_text and len(query_text.strip()) <= 128

            if use_hybrid:
                try:
                    from lancedb.rerankers import LinearCombinationReranker
                    reranker = LinearCombinationReranker(weight=0.7)
                    query = self.table.search(query_type="hybrid").vector(query_vector).text(query_text).rerank(reranker=reranker).limit(candidate_limit)
                    is_hybrid = True
                except Exception as e:
                    logger.warning("Hybrid search/rerank failed (%s), falling back to vector search.", e)
                    query = self.table.search(query_vector).metric("cosine").limit(candidate_limit)
            else:
                query = self.table.search(query_vector).metric("cosine").limit(candidate_limit)

            if min_similarity > 0 and not is_hybrid:
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
            path_results = self._aggregate_results(
                res_list, 
                is_hybrid, 
                min_similarity, 
                current_path,
                current_tags,
                current_links
            )

            results = sorted(
                path_results.values(), key=lambda x: x["score"], reverse=True
            )
            return results[:top_k]

        except Exception as e:
            logger.error("Error searching: %s", e)
            return []

    def _create_snippet(self, parent_text: str, child_text: str) -> str:
        """Helper to create a relevant snippet from matching chunk."""
        if child_text and child_text in parent_text:
            start_idx = parent_text.find(child_text)
            snip_start = max(0, start_idx - 30)
            snip_end = min(len(parent_text), start_idx + len(child_text) + 50)
            snippet = parent_text[snip_start:snip_end].strip()
            if snip_start > 0: snippet = "..." + snippet
            if snip_end < len(parent_text): snippet = snippet + "..."
            return snippet
        return self._truncate_snippet(parent_text)

    def _aggregate_results(
        self,
        res_list: List[Dict[str, Any]],
        is_hybrid: bool,
        min_similarity: float,
        current_path: str = None,
        current_tags: List[str] = None,
        current_links: List[str] = None,
    ) -> Dict[str, Dict[str, Any]]:
        """Aggregate chunk-level results into path-level results with boosting and path preference."""
        path_results: Dict[str, Dict[str, Any]] = {}
        
        # 提取当前笔记所在的目录，用于后续 Path Boosting
        current_dir = os.path.dirname(current_path).replace("\\", "/").strip("/") if current_path else None

        for row in res_list:
            path = row["path"]
            
            if "_relevance_score" in row:
                similarity = row["_relevance_score"]
            elif "_score" in row:
                similarity = row["_score"]
            else:
                distance = row.get("_distance", 1.0)
                similarity = 1.0 - distance

            if not is_hybrid and min_similarity > 0 and similarity < min_similarity:
                continue

            full_text = row.get("parent_text", row.get("text", ""))  # 优先展示父块内容
            chunk_text = row.get("text", "") # 当前命中的子块
            chunk_index = row.get("chunk_index", 0)
            full_path = row.get("full_path", "")
            tags = row.get("tags", [])
            links = row.get("links", [])

            # 文档级聚合：取最高分 chunk 作为 snippet，同时各维度累加权重
            if path not in path_results:
                path_results[path] = {
                    "path": path,
                    "score": similarity,
                    "snippet": self._create_snippet(full_text, chunk_text), # 聚焦子块的父上下文
                    "matched_chunk_index": chunk_index,
                    "hit_count": 1,
                    "full_path": full_path,
                    "tags": tags,
                    "links": links
                }
            elif similarity > path_results[path]["score"]:
                path_results[path]["score"] = similarity
                path_results[path]["snippet"] = self._create_snippet(full_text, chunk_text)
                path_results[path]["matched_chunk_index"] = chunk_index
                path_results[path]["hit_count"] += 1
            else:
                path_results[path]["hit_count"] += 1

        # 最终排序权重调整
        for item in path_results.values():
            item["reasons"] = []
            item["score_details"] = {"base_semantic": item["score"]}
            
            # 1. 命中数奖励 (Max +0.06)
            bonus = min(item["hit_count"] - 1, 3) * 0.02
            if bonus > 0:
                item["reasons"].append("HIGH_DENSITY")
                item["score_details"]["density_bonus"] = bonus
            
            # 2. 路径亲和度奖励 (Path-based Boosting)
            path_boost = 0.0
            if current_dir:
                item_dir = os.path.dirname(item["path"]).replace("\\", "/").strip("/")
                if item_dir == current_dir:
                    path_boost = 0.05
                    item["reasons"].append("SAME_FOLDER")
                elif current_dir in item_dir or item_dir in current_dir:
                    path_boost = 0.02
                    item["reasons"].append("RELATED_FOLDER")
            if path_boost > 0:
                item["score_details"]["path_bonus"] = path_boost
            
            # 3. 标签亲和度奖励 (Tag Affinity)
            tag_boost = 0.0
            if current_tags and item.get("tags"):
                shared_tags = set(current_tags) & set(item["tags"])
                tag_boost = min(len(shared_tags) * 0.05, 0.15)
                if tag_boost > 0:
                    item["reasons"].append("SHARE_TAGS")
                    item["score_details"]["tag_bonus"] = tag_boost
                
            # 4. 链接关联奖励 (Link Affinity)
            link_boost = 0.0
            if current_links and item["path"] in current_links:
                link_boost = 0.2
                item["reasons"].append("LINKED")
                item["score_details"]["link_bonus"] = link_boost
            
            item["score"] = item["score"] + bonus + path_boost + tag_boost + link_boost
            
            # 清理中间字段，避免拉低 API 性能
            del item["hit_count"]
            if "tags" in item: del item["tags"]
            if "links" in item: del item["links"]
            
        return path_results


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

    def optimize_database(self, retention_days: int = 7):
        """
        Perform maintenance: compaction and old version cleanup.
        """
        from datetime import timedelta
        try:
            if not self.table:
                return
            
            logger.info("Starting database optimization (retention: %d days)...", retention_days)
            # 1. 第一步：整理碎片/合并细碎文件
            self.table.optimize()
            
            # 2. 第二步：清理过期版本数据
            self.table.cleanup_old_versions(older_than=timedelta(days=retention_days))
            
            logger.info("Database optimization completed.")
        except Exception as e:
            logger.error("Failed to optimize database: %s", e)
            raise

    def get_storage_metrics(self) -> int:
        """
        Calculate total size of the database directory in bytes.
        """
        total_size = 0
        try:
            if not os.path.exists(self.db_path):
                return 0
            
            for dirpath, dirnames, filenames in os.walk(self.db_path):
                for f in filenames:
                    fp = os.path.join(dirpath, f)
                    if os.path.exists(fp):
                        total_size += os.path.getsize(fp)
            return total_size
        except Exception as e:
            logger.error("Error calculating storage metrics: %s", e)
            return 0
