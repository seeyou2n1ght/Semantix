import logging
import os
from typing import List, Dict, Any, Optional
import jieba
from storage.lancedb_storage import LanceDBStorage
from services.embedding_service import EmbeddingService, embedding_service
from config import ranking_config

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
        hit_count: int = 1,
        rrf_score: float = 0.0,
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
        self.hit_count = hit_count
        self.rrf_score = rrf_score

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

    @staticmethod
    def _apply_doc_diversity_guard(
        rows: List[Dict[str, Any]],
        max_per_doc: int = ranking_config.MAX_CHUNKS_PER_DOC_RECALL,
        target_limit: int = ranking_config.RECALL_CANDIDATE_LIMIT,
    ) -> List[Dict[str, Any]]:
        """内存单遍贪心截断：限制单篇笔记分块数不超过配额，防止长文档垄断召回池"""
        counts: Dict[str, int] = {}
        guarded: List[Dict[str, Any]] = []
        for r in rows:
            path = r.get("path", "")
            if counts.get(path, 0) < max_per_doc:
                counts[path] = counts.get(path, 0) + 1
                guarded.append(r)
                if len(guarded) >= target_limit:
                    break
        return guarded

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
        执行 Vector 与 FTS 独立召回并通过标准 Reciprocal Rank Fusion (RRF) 融合。
        彻底消除 128 字符硬切断与分数语义混淆，按文档路径聚合并输出优质候选。
        """
        if self.storage.table is None:
            return []

        try:
            where_clauses = [f"vault_id = '{self.storage._escape_sql_string(vault_id)}'"]
            if exclude_paths:
                formatted = ", ".join([f"'{self.storage._escape_sql_string(p)}'" for p in exclude_paths])
                where_clauses.append(f"path NOT IN ({formatted})")
            filter_expr = " AND ".join(where_clauses)

            # 超额召回深度 (Over-fetching)
            fetch_limit = max(candidate_limit, ranking_config.RECALL_OVERFETCH_LIMIT)

            # 1. 独立向量语义召回 (Vector Recall)
            vector_rows: List[Dict[str, Any]] = []
            try:
                vec_query = self.storage.table.search(query_vector).metric("cosine").limit(fetch_limit)
                if min_similarity > 0:
                    max_dist = 1.0 - min_similarity
                    vec_query = vec_query.distance_range(upper_bound=max_dist)
                vector_rows = vec_query.where(filter_expr).to_list()
            except Exception as e:
                logger.warning("Vector retrieval failed (%s)", e)

            # 2. 独立全文检索召回 (FTS/BM25 Recall)
            fts_rows: List[Dict[str, Any]] = []
            clean_query = query_text.strip() if query_text else ""
            if clean_query:
                vault_stops = self.storage.get_vault_stopwords(vault_id)
                if vault_stops:
                    tokens = [t for t in jieba.cut(clean_query) if t.strip() and t.lower() not in vault_stops]
                    if tokens:
                        clean_query = " ".join(tokens)
                try:
                    fts_search_str = self.storage.prepare_fts_query(clean_query)
                    fts_query = self.storage.table.search(fts_search_str, query_type="fts").limit(fetch_limit)
                    fts_rows = fts_query.where(filter_expr).to_list()
                except Exception as e:
                    logger.debug("FTS search unavailable or failed (%s), proceeding with vector-only.", e)

            # 3. 执行文档级多样性守卫 (Doc Diversity Guard)
            guarded_vector_rows = self._apply_doc_diversity_guard(
                vector_rows,
                max_per_doc=ranking_config.MAX_CHUNKS_PER_DOC_RECALL,
                target_limit=candidate_limit,
            )
            guarded_fts_rows = self._apply_doc_diversity_guard(
                fts_rows,
                max_per_doc=ranking_config.MAX_CHUNKS_PER_DOC_RECALL,
                target_limit=candidate_limit,
            )

            # 4. 执行 RRF 融合与文档分块聚合
            return self._fuse_and_aggregate(
                vector_rows=guarded_vector_rows,
                fts_rows=guarded_fts_rows,
                min_similarity=min_similarity,
            )
        except Exception as e:
            logger.error("Error during candidate retrieval: %s", e)
            return []

    def _fuse_and_aggregate(
        self,
        vector_rows: List[Dict[str, Any]],
        fts_rows: List[Dict[str, Any]],
        min_similarity: float = 0.0,
        rrf_k: float = 60.0,
    ) -> List[RetrievalCandidate]:
        """使用标准 Reciprocal Rank Fusion (k=60) 融合向量与词面分，并按文档路径聚合"""
        vec_rank_map: Dict[str, int] = {}
        for idx, row in enumerate(vector_rows):
            key = f"{row['path']}#{row.get('chunk_index', 0)}"
            vec_rank_map[key] = idx + 1

        fts_rank_map: Dict[str, int] = {}
        fts_scores: Dict[str, float] = {}
        for idx, row in enumerate(fts_rows):
            key = f"{row['path']}#{row.get('chunk_index', 0)}"
            fts_rank_map[key] = idx + 1
            fts_scores[key] = float(row.get("_score", 0.0))

        chunk_dict: Dict[str, Dict[str, Any]] = {}
        for r in vector_rows:
            key = f"{r['path']}#{r.get('chunk_index', 0)}"
            chunk_dict[key] = r
        for r in fts_rows:
            key = f"{r['path']}#{r.get('chunk_index', 0)}"
            if key not in chunk_dict:
                chunk_dict[key] = r

        doc_map: Dict[str, Dict[str, Any]] = {}

        for key, row in chunk_dict.items():
            path = row["path"]

            # 计算本分块的纯向量余弦分
            if "_distance" in row:
                similarity = max(0.0, 1.0 - float(row["_distance"]))
            elif key in vec_rank_map:
                similarity = 0.5
            else:
                similarity = 0.0

            # 纯向量模式门槛过滤
            if min_similarity > 0 and key in vec_rank_map and similarity < min_similarity:
                continue

            # 计算纯词面 BM25 分 (从 fts_scores 取真实分数，避免重叠 chunk 丢失词面分)
            lexical = fts_scores.get(key, 0.0)

            # 计算 RRF 分数
            rrf_score = 0.0
            if key in vec_rank_map:
                rrf_score += 1.0 / (rrf_k + vec_rank_map[key])
            if key in fts_rank_map:
                rrf_score += 1.0 / (rrf_k + fts_rank_map[key])

            full_text = row.get("parent_text", row.get("text", ""))
            chunk_text = row.get("text", "")
            chunk_idx = row.get("chunk_index", 0)
            vector = row.get("vector", [])
            full_path = row.get("full_path", "")
            tags = row.get("tags", [])
            links = row.get("links", [])

            if path not in doc_map:
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
                    "hit_count": 1,
                    "best_chunk_rrf": rrf_score,
                    "rrf_score": rrf_score,
                }
            else:
                doc_map[path]["hit_count"] += 1
                # 最佳 chunk 判断：与分块自身的最佳 RRF 比较，而非与已累加的文档总分比较
                if rrf_score > doc_map[path]["best_chunk_rrf"]:
                    doc_map[path]["best_chunk_rrf"] = rrf_score
                    doc_map[path]["snippet"] = self._create_snippet(full_text, chunk_text)
                    doc_map[path]["vector"] = vector
                    doc_map[path]["matched_chunk_index"] = chunk_idx
                    doc_map[path]["full_path"] = full_path
                doc_map[path]["semantic_score"] = max(doc_map[path]["semantic_score"], similarity)
                doc_map[path]["lexical_score"] = max(doc_map[path]["lexical_score"], lexical)
                doc_map[path]["rrf_score"] += rrf_score

        # 多分块 Hit Bonus：同一文档命中多块时轻微奖励，提升整篇代表性
        for doc in doc_map.values():
            doc.pop("best_chunk_rrf", None)
            if doc["hit_count"] >= 2:
                hit_bonus = min(0.15, 0.05 * (doc["hit_count"] - 1))
                doc["rrf_score"] *= (1.0 + hit_bonus)

        candidates = [RetrievalCandidate(**item) for item in doc_map.values()]
        candidates.sort(key=lambda c: c.rrf_score, reverse=True)
        return candidates
