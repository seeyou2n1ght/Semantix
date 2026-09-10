import logging
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

    def upsert_documents(self, data: List[Dict[str, Any]]) -> int:
        """
        批量解析、分块、向量化并存入 LanceDB。
        返回入库的分块总数。
        """
        if not data:
            return 0

        # 按 vault_id 分组做去重删除
        paths_by_vault: Dict[str, List[str]] = {}
        for item in data:
            vault_id = item.get("vault_id")
            if not vault_id:
                raise ValueError("Missing vault_id in upsert data")
            paths_by_vault.setdefault(vault_id, []).append(item["path"])

        for vault_id, paths in paths_by_vault.items():
            self.storage.delete_by_paths(vault_id, paths)

        all_chunk_data = []

        for item in data:
            vault_id = item.get("vault_id")
            path = item.get("path")
            text = item.get("text", "")
            tags = item.get("tags", [])
            links = item.get("links", [])

            # 单篇超长保护：防正则分块 CPU 挂起
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
            for _, child_text, _, h_str in chunks_with_idx:
                header_part = f" [{h_str}]" if h_str else ""
                enriched_text = f"[{file_basename}]{header_part}\n{child_text}"
                chunks_for_encoding.append(enriched_text)

            try:
                embeddings = self.embedding_svc.encode(chunks_for_encoding)
            except Exception as e:
                logger.error("Failed to encode chunks for %s: %s", path, e)
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

        if all_chunk_data:
            self.storage.insert_rows(all_chunk_data)
            logger.info("Indexed %d chunks from %d documents.", len(all_chunk_data), len(data))

        return len(all_chunk_data)

    def delete_by_paths(self, vault_id: str, paths: List[str]):
        self.storage.delete_by_paths(vault_id, paths)

    def compute_vault_stopwords(self, vault_id: str, threshold: float = 0.6) -> List[str]:
        """计算 Vault 自适应停用词"""
        if not self.storage.table:
            return []
        try:
            where_clause = f"vault_id = '{self.storage._escape_sql_string(vault_id)}'"
            rows = self.storage.table.search(None).where(where_clause).select(["text", "path"]).to_list()

            doc_words: Dict[str, Set[str]] = {}
            for row in rows:
                path = row["path"]
                text = row["text"]
                if not text:
                    continue
                if path not in doc_words:
                    doc_words[path] = set()
                words = re.findall(r'[\u4e00-\u9fa5]{2,}|[a-zA-Z]{3,}', text)
                doc_words[path].update([w.lower() for w in words])

            total_docs = len(doc_words)
            if total_docs < 5:
                return []

            df_counter = Counter()
            for words in doc_words.values():
                df_counter.update(words)

            noise_words = [word for word, count in df_counter.items() if (count / total_docs) >= threshold]
            logger.info("Computed %d adaptive stopwords for vault %s", len(noise_words), vault_id)
            self.storage.vault_stopwords.update(noise_words)
            self.storage._save_custom_stopwords()
            return noise_words
        except Exception as e:
            logger.error("Error computing vault stopwords: %s", e)
            return []
