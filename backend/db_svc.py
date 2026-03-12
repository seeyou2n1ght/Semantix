import logging
import lancedb
import os
import pyarrow as pa
from typing import List, Dict, Any

logger = logging.getLogger("semantix")

COLLECTION_NAME = "semantix_notes"

class DatabaseService:
    def __init__(self, db_path: str = "./semantix_lance", dim: int = 512):
        logger.info("Initializing LanceDB at %s...", db_path)
        self.db = lancedb.connect(db_path)
        self.dim = dim
        self._init_collection()

    def _init_collection(self):
        # 使用 PyArrow 显式定义 LanceDB Schema
        schema = pa.schema([
            pa.field("vault_id", pa.string()),
            pa.field("path", pa.string()),
            pa.field("vector", pa.list_(pa.float32(), self.dim)),
            pa.field("text", pa.string())
        ])
        
        if COLLECTION_NAME in self.db.table_names():
            self.table = self.db.open_table(COLLECTION_NAME)
            existing_fields = {field.name for field in self.table.schema}
            if "vault_id" not in existing_fields:
                logger.warning("Existing table schema missing vault_id, recreating table...")
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
            if not self.table: return 0
            # 简单计数，LanceDB 原生支持返回表长度
            if not vault_id:
                return len(self.table)
            # MVP: 通过物化进行过滤计数
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
            formatted_paths = ", ".join([f"'{self._escape_sql_string(p)}'" for p in paths])
            where_clause = f"vault_id = '{self._escape_sql_string(vault_id)}' AND path IN ({formatted_paths})"
            self.table.delete(where_clause)
            logger.info("Deleted %s notes from vector DB.", len(paths))
        except Exception as e:
            logger.error("Error deleting paths: %s", e)

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
                    self.table.merge_insert(["vault_id", "path"]) \
                        .when_matched_update_all() \
                        .when_not_matched_insert_all() \
                        .execute(data)
                    logger.info("Upserted %s notes.", len(data))
                    return
                except Exception as e:
                    logger.warning("merge_insert failed, fallback to delete+add: %s", e)
            paths_to_update = [item['path'] for item in data]
            vault_id = data[0].get("vault_id")
            if vault_id:
                self.delete_by_paths(vault_id, paths_to_update)
            self.table.add(data)
            logger.info("Inserted %s notes.", len(data))
        except Exception as e:
            logger.error("Error inserting documents: %s", e)

    def search(self, vault_id: str, query_vector: List[float], top_k: int = 5, exclude_paths: List[str] = None) -> List[Dict[str, Any]]:
        try:
            query = self.table.search(query_vector).metric("cosine").limit(top_k)
            
            where_clauses = [f"vault_id = '{self._escape_sql_string(vault_id)}'"]
            if exclude_paths and len(exclude_paths) > 0:
                formatted_paths = ", ".join([f"'{self._escape_sql_string(p)}'" for p in exclude_paths])
                where_clauses.append(f"path NOT IN ({formatted_paths})")
            if where_clauses:
                query = query.where(" AND ".join(where_clauses))
                
            res_list = query.to_list()
            
            results = []
            for row in res_list:
                distance = row["_distance"]
                similarity = 1 - distance
                results.append({
                    "path": row["path"],
                    "score": similarity,
                    "snippet": row["text"][:200] + "..." if len(row["text"]) > 200 else row["text"]
                })
            return results
        except Exception as e:
            logger.error("Error searching: %s", e)
            return []

    def clear_all(self):
        try:
            self.db.drop_table(COLLECTION_NAME)
            self._init_collection()
            logger.info("Table cleared and recreated.")
        except Exception as e:
             logger.error("Error clearing table: %s", e)
