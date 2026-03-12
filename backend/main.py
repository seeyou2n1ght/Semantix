import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Dict, Any
from datetime import datetime

# Local imports
from models import (
    IndexDocument, BatchIndexRequest, DeleteIndexRequest,
    SemanticSearchRequest, SemanticSearchResponse, SearchResultItem,
    IndexStatusResponse
)
from model_svc import model_svc
from db_svc import DatabaseService

# Initialize FastAPI app
app = FastAPI(title="Semantix AI Backend", version="0.2.0")

# Add CORS middleware (Obsidian uses file:// or similar, but we should allow all for local MVP)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Database Service
# In production, this path could be configurable via env vars
db_path = os.getenv("SEMANTIX_DB_PATH", "./semantix.db")
db_svc = DatabaseService(db_path=db_path)

# --- Routes ---

@app.get("/health", tags=["System"])
async def health_check():
    """Simple health check endpoint."""
    return {"status": "ok", "message": "Semantix backend is running."}

@app.get("/index/status", response_model=IndexStatusResponse, tags=["Index"])
async def get_index_status():
    """Get statistics about the current index."""
    count = db_svc.count_notes()
    return IndexStatusResponse(
        total_notes=count,
        last_updated=datetime.now().isoformat() # Placeholder for actual last touch time
    )

@app.post("/index/batch", tags=["Index"])
async def batch_index(request: BatchIndexRequest):
    """Batch embed and index documents."""
    if not request.documents:
        return {"status": "success", "indexed": 0}

    paths = [doc.path for doc in request.documents]
    texts = [doc.text for doc in request.documents]
    
    # 1. Generate embeddings
    print(f"Generating embeddings for {len(texts)} documents...")
    try:
        embeddings = model_svc.encode(texts)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Embedding generation failed: {str(e)}")

    # 2. Prepare data for Milvus
    data_to_insert = [
        {"vector": v, "path": p, "text": t}
        for p, t, v in zip(paths, texts, embeddings)
    ]
    
    # 3. Upsert into database
    try:
        db_svc.upsert_documents(data_to_insert)
    except Exception as e:
         raise HTTPException(status_code=500, detail=f"Database insertion failed: {str(e)}")

    return {"status": "success", "indexed": len(paths)}

@app.post("/index/delete", tags=["Index"])
async def delete_index(request: DeleteIndexRequest):
    """Delete specific paths from the index."""
    if not request.paths:
        return {"status": "success"}
    
    try:
         db_svc.delete_by_paths(request.paths)
         return {"status": "success", "deleted": len(request.paths)}
    except Exception as e:
         raise HTTPException(status_code=500, detail=f"Database deletion failed: {str(e)}")

@app.post("/index/clear", tags=["Index"])
async def clear_index():
    """Clear all documents from the index (Warning: destructive!)."""
    db_svc.clear_all()
    return {"status": "success", "message": "Index cleared."}

@app.post("/search/semantic", response_model=SemanticSearchResponse, tags=["Search"])
async def semantic_search(request: SemanticSearchRequest):
    """Search for similar notes based on semantic meaning."""
    if not request.text or len(request.text.strip()) == 0:
        return SemanticSearchResponse(results=[])

    try:
        # Encode the query text
        query_vector = model_svc.encode([request.text])[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Embedding generation failed: {str(e)}")

    try:
        # Search in Milvus
        raw_results = db_svc.search(
            query_vector=query_vector,
            top_k=request.top_k,
            exclude_paths=request.exclude_paths
        )
    except Exception as e:
         raise HTTPException(status_code=500, detail=f"Database search failed: {str(e)}")

    return SemanticSearchResponse(results=[SearchResultItem(**res) for res in raw_results])

# To run: uvicorn main:app --reload --host 0.0.0.0 --port 8000
