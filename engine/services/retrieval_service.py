import logging
import os
from typing import List, Dict, Any, Optional, Callable
from utils.vectors import cosine_similarity
from services.lexical import query_terms, highlight_terms
from storage.lancedb_storage import LanceDBStorage
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
        matched_terms: Optional[List[str]] = None,
        source_text: str = "",
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
        self.matched_terms = matched_terms or []
        self.source_text = source_text


class RetrievalService:
    """
    负责多路召回（Vector + FTS）以及候选分块向笔记级实体的聚合。
    按配置补足各通道的文档候选池，不决定最终展示与分流。
    """

    def __init__(self, storage: LanceDBStorage):
        self.storage = storage

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
        """Retain at most target_limit documents and max_per_doc chunks each."""
        if target_limit <= 0:
            return []
        counts: Dict[str, int] = {}
        guarded: List[Dict[str, Any]] = []
        for r in rows:
            path = r.get("path", "")
            if path not in counts and len(counts) >= target_limit:
                continue
            if counts.get(path, 0) < max_per_doc:
                counts[path] = counts.get(path, 0) + 1
                guarded.append(r)
        return guarded

    def _recall_documents(
        self,
        fetch_rows: Callable[[str, int], List[Dict[str, Any]]],
        filter_expr: str,
        candidate_limit: int,
        warnings: Optional[List[str]] = None,
        channel: str = "recall",
    ) -> List[Dict[str, Any]]:
        """Refill with unseen documents; bound work even for chunk-heavy notes."""
        rows: List[Dict[str, Any]] = []
        seen_paths: set[str] = set()
        fetch_limit = max(candidate_limit, ranking_config.RECALL_OVERFETCH_LIMIT)
        for _ in range(ranking_config.RECALL_MAX_ROUNDS):
            scoped_filter = filter_expr
            if seen_paths:
                excluded = ", ".join(
                    f"'{self.storage._escape_sql_string(p)}'" for p in sorted(seen_paths)
                )
                scoped_filter += f" AND path NOT IN ({excluded})"
            try:
                batch = fetch_rows(scoped_filter, fetch_limit)
            except Exception:
                if not rows:
                    raise
                # An optional refill failure must not discard the valid first batch.
                if warnings is not None:
                    warnings.append(f"{channel}_refill_incomplete")
                logger.warning("%s recall refill failed; retaining collected candidates", channel)
                break
            rows.extend(batch)
            seen_paths.update(row["path"] for row in batch)
            if len(seen_paths) >= candidate_limit or len(batch) < fetch_limit:
                break
        return self._apply_doc_diversity_guard(rows, target_limit=candidate_limit)

    def retrieve_candidates(
        self,
        vault_id: str,
        query_vector: List[float],
        query_text: str = "",
        exclude_paths: Optional[List[str]] = None,
        candidate_limit: int = 40,
        min_similarity: float = 0.0,
        enable_adaptive_filtering: bool = True,
        custom_stopwords: Optional[List[str]] = None,
        warnings: Optional[List[str]] = None,
    ) -> List[RetrievalCandidate]:
        """
        执行 Vector 与 FTS 独立召回并通过标准 Reciprocal Rank Fusion (RRF) 融合。
        彻底消除 128 字符硬切断与分数语义混淆，按文档路径聚合并输出优质候选。
        """
        if self.storage.table is None:
            raise RuntimeError("Search index is unavailable")
        if candidate_limit <= 0:
            return []
        warnings = warnings if warnings is not None else []

        try:
            where_clauses = [f"vault_id = '{self.storage._escape_sql_string(vault_id)}'"]
            if exclude_paths:
                formatted = ", ".join([f"'{self.storage._escape_sql_string(p)}'" for p in exclude_paths])
                where_clauses.append(f"path NOT IN ({formatted})")
            filter_expr = " AND ".join(where_clauses)

            # 1. 独立向量语义召回 (Vector Recall)
            vector_rows: List[Dict[str, Any]] = []
            vector_failed = False
            try:
                def fetch_vector(scoped_filter: str, limit: int) -> List[Dict[str, Any]]:
                    vec_query = self.storage.table.search(query_vector).metric("cosine").limit(limit)
                    if min_similarity > 0:
                        vec_query = vec_query.distance_range(upper_bound=1.0 - min_similarity)
                    return vec_query.where(scoped_filter).to_list()

                vector_rows = self._recall_documents(fetch_vector, filter_expr, candidate_limit, warnings, "vector")
            except Exception as e:
                logger.warning("Vector retrieval failed (%s)", e)
                vector_failed = True
                warnings.append("vector_unavailable")

            # 2. 独立全文检索召回 (FTS/BM25 Recall)
            fts_rows: List[Dict[str, Any]] = []
            stops = set(custom_stopwords or [])
            if enable_adaptive_filtering:
                stops.update(self.storage.get_vault_stopwords(vault_id))
            terms = query_terms(query_text or "", stops)
            fts_succeeded = False
            if terms:
                try:
                    fts_search_str = " ".join(terms)
                    def fetch_fts(scoped_filter: str, limit: int) -> List[Dict[str, Any]]:
                        return self.storage.table.search(fts_search_str, query_type="fts").limit(limit).where(scoped_filter).to_list()

                    fts_rows = self._recall_documents(fetch_fts, filter_expr, candidate_limit, warnings, "lexical")
                    fts_succeeded = True
                except Exception as e:
                    logger.debug("FTS search unavailable or failed (%s), proceeding with vector-only.", e)
                    warnings.append("lexical_unavailable")

            if vector_failed and not fts_succeeded:
                raise RuntimeError("No retrieval channel is available")

            # 4. 执行 RRF 融合与文档分块聚合
            candidates = self._fuse_and_aggregate(
                vector_rows=vector_rows,
                fts_rows=fts_rows,
                min_similarity=min_similarity,
                query_vector=query_vector,
            )
            for candidate in candidates:
                candidate.matched_terms = highlight_terms(query_text or "", candidate.snippet, terms)
            return candidates
        except Exception as e:
            logger.error("Error during candidate retrieval: %s", e)
            raise

    def _fuse_and_aggregate(
        self,
        vector_rows: List[Dict[str, Any]],
        fts_rows: List[Dict[str, Any]],
        min_similarity: float = 0.0,
        rrf_k: float = ranking_config.RRF_K,
        query_vector: Optional[List[float]] = None,
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
            elif query_vector is not None and row.get("vector"):
                similarity = max(0.0, cosine_similarity(query_vector, row["vector"]))
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
                    "source_text": chunk_text,
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
                    doc_map[path]["source_text"] = chunk_text
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
                hit_bonus = min(
                    ranking_config.HIT_BONUS_MAX,
                    ranking_config.HIT_BONUS_STEP * (doc["hit_count"] - 1),
                )
                doc["rrf_score"] *= (1.0 + hit_bonus)

        candidates = [RetrievalCandidate(**item) for item in doc_map.values()]
        candidates.sort(key=lambda c: c.rrf_score, reverse=True)
        return candidates
