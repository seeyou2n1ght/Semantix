from pydantic import BaseModel, Field
from typing import List, Optional

# --- Indexing Models ---

class IndexDocument(BaseModel):
    vault_id: str = Field(..., description="Obsidian vault id")
    path: str = Field(..., description="Obsidian vault relative path of the note")
    text: str = Field(..., description="Cleaned text content of the note")

class BatchIndexRequest(BaseModel):
    documents: List[IndexDocument]

class DeleteIndexRequest(BaseModel):
    vault_id: str = Field(..., description="Obsidian vault id")
    paths: List[str]

# --- Search Models ---

class SemanticSearchRequest(BaseModel):
    vault_id: str = Field(..., description="Obsidian vault id")
    text: str = Field(..., description="Search query text")
    top_k: int = Field(5, description="Number of results to return")
    exclude_paths: Optional[List[str]] = Field(default_factory=list, description="Paths to exclude from results")

class SearchResultItem(BaseModel):
    path: str
    score: float
    snippet: str

class SemanticSearchResponse(BaseModel):
    results: List[SearchResultItem]

# --- Status Models ---

class IndexStatusResponse(BaseModel):
    total_notes: int
    last_updated: Optional[str]
    vault_id: Optional[str] = None
