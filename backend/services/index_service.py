import logging
import math
import os
import re
from collections import Counter
from typing import List, Dict, Any, Set, Optional
from utils.chunker import split_into_chunks
from storage.lancedb_storage import LanceDBStorage
from services.embedding_service import EmbeddingService, embedding_service

logger = logging.getLogger("semantix")


class IndexService:
    """
    负责文档预处理、分块、向量化编排以及批量写入存储。
    """

    def __init__(self, storage: LanceDBStorage, embedding_svc: Optional[EmbeddingService] = None):
        self.storage = storage
        self.embedding_svc = embedding_svc or embedding_service

    def upsert_documents(self, data: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        批量解析、分块、向量化并存入 LanceDB。
        采用原子隔离策略：仅当文档各分块成功向量化后，才将对应路径纳入待删除集合，
        避免单篇编码失败导致该文档旧索引被无辜删除。
        返回包含 indexed_chunks, success_docs, failed_docs 的字典。
        """
        if not data:
            return {"indexed_chunks": 0, "success_docs": 0, "failed_docs": []}

        all_chunk_data = []
        success_paths_by_vault: Dict[str, Set[str]] = {}
        failed_docs: List[str] = []

        for item in data:
            vault_id = item.get("vault_id")
            path = item.get("path")
            text = item.get("text", "")
            tags = item.get("tags", [])
            links = item.get("links", [])

            if not vault_id or not path:
                logger.warning("Missing vault_id or path in upsert item")
                failed_docs.append(path or "unknown")
                continue

            if not text or not text.strip():
                success_paths_by_vault.setdefault(vault_id, set()).add(path)
                continue

            chunks_with_idx = split_into_chunks(text)
            if not chunks_with_idx:
                fallback = text[:500] if len(text) > 500 else text
                chunks_with_idx = [(fallback, fallback, 0, "")]

            file_basename = os.path.basename(path)
            if file_basename.lower().endswith(".md"):
                file_basename = file_basename[:-3]

            chunks_for_encoding = []
            for _, child_text, _, h_str in chunks_with_idx:
                header_part = f" [{h_str}]" if h_str else ""
                enriched_text = f"[{file_basename}]{header_part}\n{child_text}"
                chunks_for_encoding.append(enriched_text)

            try:
                embeddings = self.embedding_svc.encode(chunks_for_encoding)
                if len(embeddings) != len(chunks_for_encoding):
                    raise ValueError("Embedding count does not match document chunks")
            except Exception as e:
                logger.error("Failed to encode chunks for %s: %s", path, e)
                failed_docs.append(path)
                continue

            for i, (parent_text, child_text, _, h_str) in enumerate(chunks_with_idx):
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
                        "text": child_text,           # 子块 (召回/匹配)
                        "parent_text": parent_text,    # 父块 (上下文展示)
                        "full_path": full_semantic_path,
                        "tags": tags,
                        "links": links,
                    }
                )

            success_paths_by_vault.setdefault(vault_id, set()).add(path)

        # 编码失败的路径不纳入事务，成功路径原子替换（包含空文档删除旧索引）。
        if success_paths_by_vault:
            self.storage.replace_documents(all_chunk_data, success_paths_by_vault)
            logger.info("Indexed %d chunks from %d documents.", len(all_chunk_data), len(data))

        total_success_docs = sum(len(paths) for paths in success_paths_by_vault.values())
        return {
            "indexed_chunks": len(all_chunk_data),
            "success_docs": total_success_docs,
            "failed_docs": failed_docs
        }

    def delete_by_paths(self, vault_id: str, paths: List[str]):
        self.storage.delete_by_paths(vault_id, paths)

    def _extract_tokens(self, text: str) -> List[str]:
        tokens: List[str] = []
        # 英文词汇提取（至少 3 字符）
        for en_word in re.findall(r'[a-zA-Z]{3,}', text):
            tokens.append(en_word.lower())

        # 中文词汇提取：优先 jieba 分词，未安装时回退至标点分句的 2~4 字符 n-gram
        try:
            import jieba  # type: ignore
            for w in jieba.cut(text):
                w_strip = w.strip()
                if len(w_strip) >= 2 and re.match(r'^[\u4e00-\u9fa5]+$', w_strip):
                    tokens.append(w_strip)
        except ImportError:
            clauses = re.findall(r'[\u4e00-\u9fa5]+', text)
            for clause in clauses:
                n = len(clause)
                for length in (2, 3, 4):
                    for i in range(n - length + 1):
                        tokens.append(clause[i:i + length])
        return tokens

    def compute_vault_stopwords(self, vault_id: str, threshold: float = 0.3) -> List[str]:
        """计算 Vault 自适应停用词并按 vault_id 物理隔离存储"""
        if self.storage.table is None or self.storage.table.count_rows() == 0:
            self.storage.set_vault_stopwords(vault_id, [])
            return []
        try:
            where_clause = f"vault_id = '{self.storage._escape_sql_string(vault_id)}'"
            rows = self.storage.table.search().where(where_clause).limit(None).select(["text", "path"]).to_list()

            doc_texts: Dict[str, List[str]] = {}
            for row in rows:
                path = row.get("path")
                text = row.get("text")
                if not text or not path:
                    continue
                doc_texts.setdefault(path, []).append(text)

            doc_words: Dict[str, Set[str]] = {}
            for path, chunks in doc_texts.items():
                combined = " ".join(chunks)
                doc_words[path] = set(self._extract_tokens(combined))

            total_docs = len(doc_words)
            if total_docs < 2:
                self.storage.set_vault_stopwords(vault_id, [])
                return []

            min_doc_freq = max(2, math.ceil(total_docs * threshold))
            df_counter = Counter()
            for words in doc_words.values():
                df_counter.update(words)

            noise_words = sorted(word for word, count in df_counter.items() if count >= min_doc_freq)
            logger.info(
                "Computed %d adaptive stopwords for vault %s (total_docs=%d, min_doc_freq=%d)",
                len(noise_words), vault_id, total_docs, min_doc_freq
            )
            self.storage.set_vault_stopwords(vault_id, noise_words)
            return noise_words
        except Exception as e:
            logger.error("Error computing vault stopwords: %s", e)
            raise
