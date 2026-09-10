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


# --- Dual Stream Radar Models ---


class RadarContext(BaseModel):
    path: Optional[str] = Field(None, description="Current note path in vault")
    title: Optional[str] = Field(None, description="Current note title")
    heading: Optional[str] = Field(None, description="Current heading under cursor")
    text: str = Field(..., description="Query focus text or note content")
    tags: Optional[List[str]] = Field(default_factory=list, description="Tags associated with current note")
    links: Optional[List[str]] = Field(default_factory=list, description="Outgoing links from current note")
    scope: Optional[str] = Field("focus", description="Context scope: focus or note")


class RadarSearchRequest(BaseModel):
    vault_id: str = Field(..., description="Obsidian vault id")
    context_id: str = Field(..., description="Frontend generated stable context id")
    context: RadarContext = Field(..., description="Structured context")
    top_k_related: Optional[int] = Field(4, description="Count of related items to return")
    top_k_discover: Optional[int] = Field(4, description="Count of discover items to return")
    ranking_mode: Optional[str] = Field("balanced", description="fast, balanced, or high_quality")
    exclude_paths: Optional[List[str]] = Field(default_factory=list, description="Paths to exclude")
    mmr_lambda: Optional[float] = Field(0.65, ge=0.1, le=0.9, description="MMR diversity trade-off (lower = more diverse)")


class RadarCardItem(BaseModel):
    id: str = Field(..., description="Unique card/note identifier for UI tracking")
    path: str = Field(..., description="Vault relative path")
    title: str = Field(..., description="Note title")
    snippet: str = Field(..., description="Relevant context snippet")
    score: float = Field(..., description="Normalized score [0, 1]")
    labels: List[str] = Field(default_factory=list, description="Machine label codes (e.g. UNLINKED, CROSS_TOPIC)")
    matched_chunk_index: Optional[int] = None


class RadarSearchResponse(BaseModel):
    context_id: str = Field(..., description="Echoed context id from frontend request")
    related: List[RadarCardItem] = Field(default_factory=list)
    discover: List[RadarCardItem] = Field(default_factory=list)


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
