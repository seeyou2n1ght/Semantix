import os
import time
import logging
import secrets
import threading
import signal
import ctypes
from fastapi import FastAPI, HTTPException, Depends, Header, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime, timedelta
from typing import Dict, Optional

# Local imports
from models import (
    IndexDocument,
    BatchIndexRequest,
    DeleteIndexRequest,
    SemanticSearchRequest,
    SemanticSearchResponse,
    SearchResultItem,
    IndexStatusResponse,
    MetricsResponse,
    ClearIndexConfirmRequest,
)
from model_svc import model_svc
from db_svc import DatabaseService

API_TOKEN = os.getenv("SEMANTIX_API_TOKEN", "").strip() or None
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "SEMANTIX_ALLOWED_ORIGINS", 
        "http://localhost,http://127.0.0.1,app://obsidian.md,capacitor://localhost"
    ).split(",")
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
    "last_search_ms": None,
}

_pending_clear_requests: Dict[str, Dict] = {}

# --- Watchdog Configuration ---
LAST_ACTIVITY = time.time()
PARENT_PID = int(os.getenv("SEMANTIX_PARENT_PID", "0"))
WATCHDOG_INTERVAL = 20  # 检查频率 (秒)
ACTIVITY_TIMEOUT = 120  # 无响应自杀阈值 (秒)

def is_process_running(pid):
    """跨平台检查进程是否仍在运行"""
    if pid <= 0:
        return False
        
    # Windows 平台实现
    if os.name == 'nt':
        # PROCESS_QUERY_LIMITED_INFORMATION (0x1000)
        # 即使没有完全控制权，也能查询进程是否还在
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        return False
    else:
        # Unix 平台实现
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

def watchdog():
    """后台监控线程：检查心跳超时或父进程消失"""
    global LAST_ACTIVITY
    logger.info("Watchdog monitoring started (Interval: %ds, Timeout: %ds)", WATCHDOG_INTERVAL, ACTIVITY_TIMEOUT)
    
    while True:
        time.sleep(WATCHDOG_INTERVAL)
        now = time.time()
        
        # 1. 检查心跳超时
        if now - LAST_ACTIVITY > ACTIVITY_TIMEOUT:
            logger.warning("Heartbeat timeout (%ds). Sidecar initiating self-shutdown...", ACTIVITY_TIMEOUT)
            # 触发优雅退出逻辑
            os.kill(os.getpid(), signal.SIGTERM)
            break
            
        # 2. 检查父进程存活 (如果注入了 PID)
        if PARENT_PID > 0:
            if not is_process_running(PARENT_PID):
                logger.warning("Parent process (PID %d) lost. Sidecar initiating self-shutdown...", PARENT_PID)
                os.kill(os.getpid(), signal.SIGTERM)
                break


def verify_token(x_semantix_token: str | None = Header(default=None)):
    if API_TOKEN and x_semantix_token != API_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")


# Initialize FastAPI app
app = FastAPI(
    title="Semantix AI Backend", version="0.4.0", dependencies=[Depends(verify_token)]
)

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
    logger.info(
        "%s %s %s %.2fms",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    return response


# Initialize Database Service
# In production, this path could be configurable via env vars
db_path = os.getenv("SEMANTIX_DB_PATH", "./semantix.db")
db_svc = DatabaseService(db_path=db_path)


@app.on_event("startup")
def startup_event():
    # 启动看门狗线程
    thread = threading.Thread(target=watchdog, daemon=True)
    thread.start()
    logger.info("Semantix backend service started. Parent PID: %d", PARENT_PID)


@app.on_event("shutdown")
def shutdown_event():
    logger.info("Semantix backend service is shutting down...")
    db_svc.close()


# --- Routes ---


@app.get("/health", tags=["System"])
def health_check():
    """Simple health check endpoint."""
    if not model_svc.is_ready:
        return {"status": "loading", "message": "Model is loading..."}
    return {"status": "ok", "message": "Semantix backend is running."}


@app.get("/ping", tags=["System"])
def ping():
    """Heartbeat endpoint to keep the service alive."""
    global LAST_ACTIVITY
    LAST_ACTIVITY = time.time()
    return {"status": "alive", "timestamp": LAST_ACTIVITY}


@app.get("/ready", tags=["System"])
def readiness_check():
    """Kubernetes readiness probe endpoint."""
    if not model_svc.is_ready:
        raise HTTPException(status_code=503, detail="Model not ready")
    return {"status": "ready"}


@app.get("/index/status", response_model=IndexStatusResponse, tags=["Index"])
def get_index_status(vault_id: str = "default"):
    """Get statistics about the current index."""
    count = db_svc.count_notes(vault_id=vault_id)
    return IndexStatusResponse(
        total_notes=count, last_updated=METRICS["last_index_at"], vault_id=vault_id
    )


@app.get("/metrics", response_model=MetricsResponse, tags=["System"])
def get_metrics():
    return MetricsResponse(**METRICS)


@app.post("/index/batch", tags=["Index"])
def batch_index(request: BatchIndexRequest, background_tasks: BackgroundTasks):
    """Batch embed and index documents."""
    if not request.documents:
        return {"status": "success", "indexed": 0}

    start = time.perf_counter()

    # 准备文档数据（不在此处 encode，upsert_documents 内部按 chunk 粒度 encode）
    data_to_insert = [
        {
            "vault_id": doc.vault_id,
            "path": doc.path,
            "text": doc.text,
        }
        for doc in request.documents
    ]

    try:
        db_svc.upsert_documents(data_to_insert)
        # 标记 FTS 脏位，由节流逻辑决定是否真正 rebuild
        db_svc.mark_fts_dirty()
        background_tasks.add_task(db_svc.maybe_rebuild_fts_index)
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Database insertion failed: {str(e)}"
        )

    duration_ms = (time.perf_counter() - start) * 1000
    METRICS["total_indexed_docs"] += len(request.documents)
    METRICS["last_index_at"] = datetime.now().isoformat()
    METRICS["last_index_ms"] = duration_ms
    logger.info("Indexed %d documents in %.2fms", len(request.documents), duration_ms)

    return {"status": "success", "indexed": len(request.documents)}


@app.post("/index/delete", tags=["Index"])
def delete_index(request: DeleteIndexRequest, background_tasks: BackgroundTasks):
    """Delete specific paths from the index."""
    if not request.paths:
        return {"status": "success"}

    try:
        db_svc.delete_by_paths(request.vault_id, request.paths)
        db_svc.mark_fts_dirty()
        background_tasks.add_task(db_svc.maybe_rebuild_fts_index)
        return {"status": "success", "deleted": len(request.paths)}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Database deletion failed: {str(e)}"
        )


@app.post("/index/clear/request", tags=["Index"])
def request_clear_index(vault_id: Optional[str] = None):
    """
    第一步：请求清空索引，返回确认 token。
    客户端需要使用此 token 在 5 分钟内调用 /index/clear/confirm
    """
    token = secrets.token_urlsafe(16)
    _pending_clear_requests[token] = {
        "vault_id": vault_id,
        "created_at": datetime.now(),
        "expires_at": datetime.now() + timedelta(minutes=5),
    }

    scope = f"vault '{vault_id}'" if vault_id else "ALL VAULTS"
    logger.warning("Clear index requested for %s. Token: %s...", scope, token[:8])

    return {
        "status": "confirmation_required",
        "message": f"Use this token to confirm clearing {scope} within 5 minutes.",
        "confirmation_token": token,
        "scope": scope,
    }


@app.post("/index/clear/confirm", tags=["Index"])
def confirm_clear_index(request: ClearIndexConfirmRequest):
    """
    第二步：使用 token 确认清空操作
    """
    confirmation_token = request.confirmation_token
    vault_id = request.vault_id

    pending_request = _pending_clear_requests.pop(confirmation_token, None)

    if not pending_request:
        raise HTTPException(
            status_code=400, detail="Invalid or expired confirmation token"
        )

    token_scope_vault_id = pending_request.get("vault_id")
    if token_scope_vault_id != vault_id:
        raise HTTPException(
            status_code=400,
            detail="Confirmation token scope mismatch",
        )

    if datetime.now() > pending_request["expires_at"]:
        raise HTTPException(status_code=400, detail="Confirmation token expired")

    if vault_id:
        db_svc.clear_vault(vault_id)
        scope = f"vault '{vault_id}'"
    else:
        db_svc.clear_all()
        scope = "ALL VAULTS"

    logger.warning(
        "Index cleared: %s by token %s... at %s",
        scope,
        confirmation_token[:8],
        datetime.now(),
    )

    return {
        "status": "success",
        "message": f"Index cleared for {scope}.",
        "cleared_at": datetime.now().isoformat(),
    }


@app.post("/search/semantic", response_model=SemanticSearchResponse, tags=["Search"])
def semantic_search(request: SemanticSearchRequest):
    """Search for similar notes based on semantic meaning."""
    if not request.text or len(request.text.strip()) == 0:
        return SemanticSearchResponse(results=[])

    start = time.perf_counter()
    try:
        # Encode the query text with BGE instruction prefix
        # "为这个句子生成表示以用于检索相关文章：" is required for asymmetric retrieval with BAAI/bge-small-zh-v1.5
        query_text = f"为这个句子生成表示以用于检索相关文章：{request.text}"
        query_vector = model_svc.encode([query_text])[0]
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Embedding generation failed: {str(e)}"
        )

    try:
        raw_results = db_svc.search(
            vault_id=request.vault_id,
            query_vector=query_vector,
            top_k=request.top_k,
            exclude_paths=request.exclude_paths or [],
            min_similarity=request.min_similarity or 0.0,
            query_text=request.text,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database search failed: {str(e)}")

    duration_ms = (time.perf_counter() - start) * 1000
    METRICS["total_searches"] += 1
    METRICS["last_search_at"] = datetime.now().isoformat()
    METRICS["last_search_ms"] = duration_ms
    logger.info("Search completed in %.2fms", duration_ms)

    return SemanticSearchResponse(
        results=[SearchResultItem(**res) for res in raw_results]
    )


# To run: uvicorn main:app --reload --host 0.0.0.0 --port 8000
