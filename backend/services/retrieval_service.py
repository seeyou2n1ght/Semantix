import logging
import os
from typing import List, Dict, Any, Optional
from storage.lancedb_storage import LanceDBStorage
from services.embedding_service import EmbeddingService, embedding_service

logger = logging.getLogger("semantix")


class RetrievalCandidate:
    """内部候选实体，承载粗排聚合后的完整上下文与特征"""
    def __init__(
        self,
        path: str,
        title: str,
        snippet: str,
        vector: List[float],
        semantic_score: float,
        lexical_score: float,
        matched_chunk_index: int,
        tags: List[str],
        links: List[str],
        full_path: str,
    ):
        self.path = path
        self.title = title
        self.snippet = snippet
        self.vector = vector
        self.semantic_score = semantic_score
        self.lexical_score = lexical_score
        self.matched_chunk_index = matched_chunk_index
        self.tags = tags
        self.links = links
        self.full_path = full_path

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "title": self.title,
            "snippet": self.snippet,
            "vector": self.vector,
            "semantic_score": self.semantic_score,
            "lexical_score": self.lexical_score,
            "matched_chunk_index": self.matched_chunk_index,
            "tags": self.tags,
            "links": self.links,
            "full_path": self.full_path,
        }


class RetrievalService:
    """
    负责多路召回（Vector + FTS）以及候选分块向笔记级实体的聚合。
    输出充足的候选池（Top 25~30），不决定最终展示与分流。
    """

    def __init__(self, storage: LanceDBStorage, embedding_svc: Optional[EmbeddingService] = None):
        self.storage = storage
        self.embedding_svc = embedding_svc or embedding_service

    def _truncate_snippet(self, text: str, max_length: int = 200) -> str:
        if not text:
            return ""
        if len(text) <= max_length:
            return text
        last_space = text.rfind(" ", max_length - 50, max_length)
        if last_space > 0:
            return text[:last_space].strip()
        return text[:max_length].strip()

    def _create_snippet(self, parent_text: str, child_text: str) -> str:
        if child_text and child_text in parent_text:
            start_idx = parent_text.find(child_text)
            snip_start = max(0, start_idx - 30)
            snip_end = min(len(parent_text), start_idx + len(child_text) + 50)
            snippet = parent_text[snip_start:snip_end].strip()
            if snip_start > 0:
                snippet = "..." + snippet
            if snip_end < len(parent_text):
                snippet = snippet + "..."
            return snippet
        return self._truncate_snippet(parent_text)

    def retrieve_candidates(
        self,
        vault_id: str,
        query_vector: List[float],
        query_text: str = "",
        exclude_paths: Optional[List[str]] = None,
        candidate_limit: int = 40,
        min_similarity: float = 0.0,
    ) -> List[RetrievalCandidate]:
        """
        根据 query_vector 与 query_text 执行 Hybrid/Vector 召回，
        按文档路径聚合并去重，输出候选池。
        """
        if not self.storage.table:
            return []

        try:
            is_hybrid = False
            # 短查询开启 Hybrid (Vector + FTS)，长查询走纯向量
            use_hybrid = bool(query_text and len(query_text.strip()) <= 128)

            if use_hybrid:
                try:
                    from lancedb.rerankers import LinearCombinationReranker
                    reranker = LinearCombinationReranker(weight=0.7)
                    query = (
                        self.storage.table.search(query_type="hybrid")
                        .vector(query_vector)
                        .text(query_text)
                        .rerank(reranker=reranker)
                        .limit(candidate_limit)
                    )
                    is_hybrid = True
                except Exception as e:
                    logger.warning("Hybrid search failed (%s), fallback to vector search.", e)
                    query = self.storage.table.search(query_vector).metric("cosine").limit(candidate_limit)
            else:
                query = self.storage.table.search(query_vector).metric("cosine").limit(candidate_limit)

            if min_similarity > 0 and not is_hybrid:
                max_distance = 1.0 - min_similarity
                query = query.distance_range(upper_bound=max_distance)

            where_clauses = [f"vault_id = '{self.storage._escape_sql_string(vault_id)}'"]
            if exclude_paths:
                formatted = ", ".join([f"'{self.storage._escape_sql_string(p)}'" for p in exclude_paths])
                where_clauses.append(f"path NOT IN ({formatted})")

            query = query.where(" AND ".join(where_clauses))
            raw_rows = query.to_list()

            return self._aggregate_to_candidates(raw_rows, is_hybrid, min_similarity)
        except Exception as e:
            logger.error("Error during candidate retrieval: %s", e)
            return []

    def _aggregate_to_candidates(
        self,
        rows: List[Dict[str, Any]],
        is_hybrid: bool,
        min_similarity: float,
    ) -> List[RetrievalCandidate]:
        """将分块命中按笔记聚合，取最优 chunk 作为代表"""
        doc_map: Dict[str, Dict[str, Any]] = {}

        for row in rows:
            path = row["path"]

            # LanceDB 评分提取
            if "_relevance_score" in row:
                similarity = float(row["_relevance_score"])
                lexical = float(row.get("_score", 0.0))
            elif "_score" in row:
                similarity = float(row["_score"])
                lexical = similarity
            else:
                distance = float(row.get("_distance", 1.0))
                similarity = max(0.0, 1.0 - distance)
                lexical = 0.0

            if not is_hybrid and min_similarity > 0 and similarity < min_similarity:
                continue

            full_text = row.get("parent_text", row.get("text", ""))
            chunk_text = row.get("text", "")
            chunk_idx = row.get("chunk_index", 0)
            vector = row.get("vector", [])
            full_path = row.get("full_path", "")
            tags = row.get("tags", [])
            links = row.get("links", [])

            if path not in doc_map or similarity > doc_map[path]["semantic_score"]:
                doc_map[path] = {
                    "path": path,
                    "title": os.path.splitext(os.path.basename(path))[0],
                    "snippet": self._create_snippet(full_text, chunk_text),
                    "vector": vector,
                    "semantic_score": similarity,
                    "lexical_score": lexical,
                    "matched_chunk_index": chunk_idx,
                    "tags": tags,
                    "links": links,
                    "full_path": full_path,
                }

        candidates = [RetrievalCandidate(**item) for item in doc_map.values()]
        # 初始按语义相似度降序
        candidates.sort(key=lambda c: c.semantic_score, reverse=True)
        return candidates
