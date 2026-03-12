import lancedb
import os
import pyarrow as pa
from typing import List, Dict, Any

COLLECTION_NAME = "semantix_notes"

class DatabaseService:
    def __init__(self, db_path: str = "./semantix_lance", dim: int = 512):
        print(f"Initializing LanceDB at {db_path}...")
        self.db = lancedb.connect(db_path)
        self.dim = dim
        self._init_collection()

    def _init_collection(self):
        # Define the schema explicitly for LanceDB using PyArrow
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
                print("Existing table schema missing vault_id, recreating table...")
                self.db.drop_table(COLLECTION_NAME)
                self.table = self.db.create_table(COLLECTION_NAME, schema=schema)
                print("Table recreated with vault_id.")
            else:
                print(f"Table {COLLECTION_NAME} already exists and opened.")
        else:
             # Create table if it doesn't exist
             print(f"Creating table {COLLECTION_NAME} with dim {self.dim}...")
             self.table = self.db.create_table(COLLECTION_NAME, schema=schema)
             print("Table created.")

    def count_notes(self, vault_id: str = None) -> int:
        try:
            if not self.table: return 0
            # A simple count, LanceDB natively supports returning length of table
            if not vault_id:
                return len(self.table)
            # MVP: filtered count via materialization
            rows = self.table.to_list()
            return sum(1 for row in rows if row.get("vault_id") == vault_id)
        except Exception as e:
            print(f"Error counting notes: {e}")
            return 0

    def _escape_sql_string(self, s: str) -> str:
        """
        Escapes single quotes in a string for use in a SQL-like query.
        LanceDB uses SQL-like syntax where single quotes are escaped by doubling them.
        """
        return s.replace("'", "''")

    def delete_by_paths(self, vault_id: str, paths: List[str]):
        if not paths:
            return
        
        try:
            # LanceDB delete uses a SQL-like where clause
            formatted_paths = ", ".join([f"'{self._escape_sql_string(p)}'" for p in paths])
            where_clause = f"vault_id = '{self._escape_sql_string(vault_id)}' AND path IN ({formatted_paths})"
            self.table.delete(where_clause)
            print(f"Deleted {len(paths)} notes from vector DB.")
        except Exception as e:
            print(f"Error deleting paths: {e}")

    def upsert_documents(self, data: List[Dict[str, Any]]):
        """
        data items should contain: 'vector', 'path', 'text'
        LanceDB supports merge_insert (upsert) based on a key (path).
        We'll use standard insertion after aggressive deletion to mimic upsert safely for MVP.
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
                    print(f"Upserted {len(data)} notes.")
                    return
                except Exception as e:
                    print(f"merge_insert failed, fallback to delete+add: {e}")
            paths_to_update = [item['path'] for item in data]
            vault_id = data[0].get("vault_id")
            if vault_id:
                self.delete_by_paths(vault_id, paths_to_update)
            self.table.add(data)
            print(f"Inserted {len(data)} notes.")
        except Exception as e:
            print(f"Error inserting documents: {e}")

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
            print(f"Error searching: {e}")
            return []

    def clear_all(self):
        try:
            self.db.drop_table(COLLECTION_NAME)
            self._init_collection()
            print("Table cleared and recreated.")
        except Exception as e:
             print(f"Error clearing table: {e}")
