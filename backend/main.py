import os
import time
import logging
from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime

# Local imports
from models import (
    IndexDocument, BatchIndexRequest, DeleteIndexRequest,
    SemanticSearchRequest, SemanticSearchResponse, SearchResultItem,
    IndexStatusResponse, MetricsResponse
)
from model_svc import model_svc
from db_svc import DatabaseService

API_TOKEN = os.getenv("SEMANTIX_API_TOKEN", "").strip() or None
ALLOWED_ORIGINS = [
    origin.strip() for origin in os.getenv("SEMANTIX_ALLOWED_ORIGINS", "http://localhost,http://127.0.0.1").split(",")
    if origin.strip()
]
LOG_LEVEL = os.getenv("SEMANTIX_LOG_LEVEL", "INFO").upper()

logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("semantix")

METRICS = {
    "total_indexed_docs": 0,
    "total_searches": 0,
    "last_index_at": None,
    "last_index_ms": None,
    "last_search_at": None,
    "last_search_ms": None
}

def verify_token(x_semantix_token: str | None = Header(default=None)):
    if API_TOKEN and x_semantix_token != API_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")

# Initialize FastAPI app
app = FastAPI(title="Semantix AI Backend", version="0.2.0", dependencies=[Depends(verify_token)])

# Add CORS middleware (Obsidian uses file:// or similar, but we should allow all for local MVP)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def log_requests(request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - start) * 1000
    logger.info("%s %s %s %.2fms", request.method, request.url.path, response.status_code, duration_ms)
    return response

# Initialize Database Service
# In production, this path could be configurable via env vars
db_path = os.getenv("SEMANTIX_DB_PATH", "./semantix.db")
db_svc = DatabaseService(db_path=db_path)

# --- Routes ---

@app.get("/health", tags=["System"])
def health_check():
    """Simple health check endpoint."""
    return {"status": "ok", "message": "Semantix backend is running."}

@app.get("/index/status", response_model=IndexStatusResponse, tags=["Index"])
def get_index_status(vault_id: str = "default"):
    """Get statistics about the current index."""
    count = db_svc.count_notes(vault_id=vault_id)
    return IndexStatusResponse(
        total_notes=count,
        last_updated=METRICS["last_index_at"],
        vault_id=vault_id
    )

@app.get("/metrics", response_model=MetricsResponse, tags=["System"])
def get_metrics():
    return MetricsResponse(**METRICS)

@app.post("/index/batch", tags=["Index"])
def batch_index(request: BatchIndexRequest):
    """Batch embed and index documents."""
    if not request.documents:
        return {"status": "success", "indexed": 0}

    start = time.perf_counter()
    paths = [doc.path for doc in request.documents]
    texts = [doc.text for doc in request.documents]
    vault_ids = [doc.vault_id for doc in request.documents]
    
    # 1. Generate embeddings
    logger.info("Generating embeddings for %s documents...", len(texts))
    try:
        embeddings = model_svc.encode(texts)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Embedding generation failed: {str(e)}")

    # 2. Prepare data for LanceDB
    data_to_insert = []
    for i, _ in enumerate(paths):
        data_to_insert.append({
            "vault_id": vault_ids[i],
            "vector": embeddings[i],
            "path": paths[i],
            "text": texts[i]
        })
    
    # 3. Upsert into database
    try:
        db_svc.upsert_documents(data_to_insert)
    except Exception as e:
         raise HTTPException(status_code=500, detail=f"Database insertion failed: {str(e)}")

    duration_ms = (time.perf_counter() - start) * 1000
    METRICS["total_indexed_docs"] += len(paths)
    METRICS["last_index_at"] = datetime.now().isoformat()
    METRICS["last_index_ms"] = duration_ms
    logger.info("Indexed %s docs in %.2fms", len(paths), duration_ms)

    return {"status": "success", "indexed": len(paths)}

@app.post("/index/delete", tags=["Index"])
def delete_index(request: DeleteIndexRequest):
    """Delete specific paths from the index."""
    if not request.paths:
        return {"status": "success"}
    
    try:
         db_svc.delete_by_paths(request.vault_id, request.paths)
         return {"status": "success", "deleted": len(request.paths)}
    except Exception as e:
         raise HTTPException(status_code=500, detail=f"Database deletion failed: {str(e)}")

@app.post("/index/clear", tags=["Index"])
def clear_index():
    """Clear all documents from the index (Warning: destructive!)."""
    db_svc.clear_all()
    return {"status": "success", "message": "Index cleared."}

@app.post("/search/semantic", response_model=SemanticSearchResponse, tags=["Search"])
def semantic_search(request: SemanticSearchRequest):
    """Search for similar notes based on semantic meaning."""
    if not request.text or len(request.text.strip()) == 0:
        return SemanticSearchResponse(results=[])

    start = time.perf_counter()
    try:
        # Encode the query text
        query_vector = model_svc.encode([request.text])[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Embedding generation failed: {str(e)}")

    try:
        # Search in LanceDB
        raw_results = db_svc.search(
            vault_id=request.vault_id,
            query_vector=query_vector,
            top_k=request.top_k,
            exclude_paths=request.exclude_paths
        )
    except Exception as e:
         raise HTTPException(status_code=500, detail=f"Database search failed: {str(e)}")

    duration_ms = (time.perf_counter() - start) * 1000
    METRICS["total_searches"] += 1
    METRICS["last_search_at"] = datetime.now().isoformat()
    METRICS["last_search_ms"] = duration_ms
    logger.info("Search completed in %.2fms", duration_ms)

    return SemanticSearchResponse(results=[SearchResultItem(**res) for res in raw_results])

# To run: uvicorn main:app --reload --host 0.0.0.0 --port 8000
