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
    exclude_paths: Optional[List[str]] = Field(
        default_factory=list, description="Paths to exclude from results"
    )
    min_similarity: Optional[float] = Field(
        0.0, ge=0.0, le=1.0, description="Minimum similarity threshold (0.0-1.0)"
    )
    with_context: Optional[bool] = Field(
        False, description="Return most relevant chunk snippet if enabled"
    )


class SearchResultItem(BaseModel):
    path: str
    score: float
    snippet: str
    matched_chunk_index: Optional[int] = None


class SemanticSearchResponse(BaseModel):
    results: List[SearchResultItem]


# --- Status Models ---


class IndexStatusResponse(BaseModel):
    total_notes: int
    last_updated: Optional[str]
    vault_id: Optional[str] = None


class MetricsResponse(BaseModel):
    total_indexed_docs: int
    total_searches: int
    last_index_at: Optional[str]
    last_index_ms: Optional[float]
    last_search_at: Optional[str]
    last_search_ms: Optional[float]


class ClearIndexConfirmRequest(BaseModel):
    confirmation_token: str = Field(..., description="Token from /index/clear/request")
    vault_id: Optional[str] = Field(
        None, description="Optional vault id to clear specific vault"
    )
