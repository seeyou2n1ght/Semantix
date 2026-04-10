from pydantic import BaseModel, Field
from typing import List, Optional, Dict

# --- Indexing Models ---


class IndexDocument(BaseModel):
    vault_id: str = Field(..., description="Obsidian vault id")
    path: str = Field(..., description="Obsidian vault relative path of the note")
    text: str = Field(..., description="Cleaned text content of the note")
    tags: Optional[List[str]] = []
    links: Optional[List[str]] = []


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
    current_path: Optional[str] = Field(
        None, description="Path of the currently active note for path-based boosting"
    )
    rerank: Optional[bool] = Field(
        True, description="Enable cross-encoder reranking for higher accuracy"
    )
    current_tags: Optional[List[str]] = []
    current_links: Optional[List[str]] = []

class MaintenanceRequest(BaseModel):
    retention_days: int = Field(7, ge=0, description="Number of days to keep old versions")
    vault_id: Optional[str] = Field(None, description="Optional vault id for scoped operations")


class SearchResultItem(BaseModel):
    path: str
    score: float
    snippet: str
    matched_chunk_index: Optional[int] = None
    reasons: List[str] = Field(default_factory=list)
    score_details: Dict[str, float] = Field(default_factory=dict)


class SemanticSearchResponse(BaseModel):
    results: List[SearchResultItem]


# --- Status Models ---


class IndexStatusResponse(BaseModel):
    total_notes: int
    last_updated: Optional[str]
    vault_id: Optional[str] = None
    vault_stopwords: List[str] = Field(default_factory=list)


class MetricsResponse(BaseModel):
    total_indexed_docs: int
    total_searches: int
    last_index_at: Optional[str]
    last_index_ms: Optional[float]
    last_search_at: Optional[str]
    last_search_ms: Optional[float]
    last_maintenance_at: Optional[str]
    db_size_bytes: int = 0
    current_retention_days: int = 7


class ClearIndexConfirmRequest(BaseModel):
    confirmation_token: str = Field(..., description="Token from /index/clear/request")
    vault_id: Optional[str] = Field(
        None, description="Optional vault id to clear specific vault"
    )
