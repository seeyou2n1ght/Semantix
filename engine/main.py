import os
import sys
import json
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
from contextlib import asynccontextmanager

# Local imports
from models import (
    IndexDocument,
    BatchIndexRequest,
    DeleteIndexRequest,
    IndexStatusResponse,
    MetricsResponse,
    ClearIndexConfirmRequest,
    MaintenanceRequest,
    RadarSearchRequest,
    RadarSearchResponse,
    RadarCardItem,
)
from services.embedding_service import embedding_service
from services.reranker_service import reranker_service
from services.device_service import device_manager
from services.database_service import db_svc, storage, index_service, radar_pipeline

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
    "last_search_ms": 0.0,
    "last_maintenance_at": None,
    "db_size_bytes": 0,
    "current_retention_days": 7,
}

_pending_clear_requests: Dict[str, Dict] = {}

# --- Watchdog Configuration ---
LAST_ACTIVITY = time.time()
PARENT_PID = int(os.getenv("SEMANTIX_PARENT_PID", "0"))
WATCHDOG_INTERVAL = 10  # µúÇµƒÑÚóæþÄç (þºÆ´╝îµø┤Õ┐½ÕôìÕ║ö Obsidian ÚÇÇÕç║)
ACTIVITY_TIMEOUT = int(os.getenv("SEMANTIX_WATCHDOG_TIMEOUT", "600"))  # µùáÕôìÕ║öÞç¬µØÇÚÿêÕÇ╝ (þºÆ, <=0 ÕêÖþªüþö¿)
PID_FILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".semantix.pid")

def is_process_running(pid: int) -> bool:
    """ÞÀ¿Õ╣│ÕÅ░µúÇµƒÑÞ┐øþ¿ïµÿ»ÕÉªõ╗ìÕ£¿Þ┐ÉÞíî (þ▓¥ÕçåÕêñÕ«ÜÕ¡ÿµ┤╗µÇü)"""
    if pid <= 0:
        return False
        
    # Windows Õ╣│ÕÅ░Õ«×þÄ░
    if os.name == 'nt':
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            # Õ┐àÚí╗µúÇµƒÑÚÇÇÕç║õ╗úþáü´╝ÜSTILL_ACTIVE = 259 (0x103)
            # ÞïÑþêÂÞ┐øþ¿ïÕÀ▓Þó½þ╗ôµØƒ´╝îÕÅÑµƒäÕ£¿Õ«îÕà¿ÚöÇµ»üÕëìÕÅ»Þâ¢õ╗ìþäÂÕÅ»Õ╝Ç´╝îõ¢å exit_code þ╗Øõ©ìµÿ» STILL_ACTIVE
            exit_code = ctypes.c_ulong()
            if ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return exit_code.value == 259
            return False
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    else:
        # Unix Õ╣│ÕÅ░Õ«×þÄ░
        try:
            os.kill(pid, 0)
            return True
        except PermissionError:
            # Þ┐øþ¿ïÕ¡ÿÕ£¿õ¢åµùáµØâÚÖÉÕÅæÚÇüõ┐íÕÅÀ
            return True
        except OSError:
            return False

def watchdog():
    """ÕÉÄÕÅ░þøæµÄºþ║┐þ¿ï´╝ÜµúÇµƒÑÕ┐âÞÀ│ÞÂàµùÂµêûþêÂÞ┐øþ¿ïµÂêÕñ▒"""
    global LAST_ACTIVITY
    logger.info("Watchdog monitoring started (Interval: %ds, Timeout: %ds, Parent PID: %d)", WATCHDOG_INTERVAL, ACTIVITY_TIMEOUT, PARENT_PID)
    
    while True:
        time.sleep(WATCHDOG_INTERVAL)
        now = time.time()
        
        # 1. µúÇµƒÑþêÂÞ┐øþ¿ïÕ¡ÿµ┤╗ (õ╝ÿÕàêÕêñÕ«Ü Obsidian µÿ»ÕÉªÚÇÇÕç║/Õ┤®µ║â)
        if PARENT_PID > 0:
            if not is_process_running(PARENT_PID):
                logger.warning("Parent process (PID %d) terminated. Sidecar initiating graceful self-shutdown...", PARENT_PID)
                cleanup_pid_file()
                os.kill(os.getpid(), signal.SIGTERM)
                break

        # 2. µúÇµƒÑÕ┐âÞÀ│ÞÂàµùÂ (ÞïÑÚàìþ¢«õ║åµ£ëµòêµ¡úµò░ÞÂàµùÂ)
        if ACTIVITY_TIMEOUT > 0 and (now - LAST_ACTIVITY > ACTIVITY_TIMEOUT):
            logger.warning("Heartbeat timeout (%ds). Sidecar initiating self-shutdown...", ACTIVITY_TIMEOUT)
            cleanup_pid_file()
            os.kill(os.getpid(), signal.SIGTERM)
            break

def write_pid_file():
    """ÕåÖÕàÑÕ¢ôÕëìÞ┐øþ¿ï PID Úöüµûçõ╗Âõ¥øÕëìþ½»þ▓¥ÕçåÞ»åÕê½õ©ÄÕø×µöÂ"""
    try:
        with open(PID_FILE_PATH, "w", encoding="utf-8") as f:
            f.write(json.dumps({
                "pid": os.getpid(),
                "parent_pid": PARENT_PID,
                "started_at": datetime.now().isoformat()
            }))
    except Exception as e:
        logger.warning("Failed to write PID file: %s", e)

def cleanup_pid_file():
    """µ©àþÉå PID Úöüµûçõ╗Â"""
    try:
        if os.path.exists(PID_FILE_PATH):
            os.remove(PID_FILE_PATH)
    except Exception:
        pass


def verify_token(x_semantix_token: str | None = Header(default=None)):
    if API_TOKEN and x_semantix_token != API_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")


ENGINE_VERSION = "0.9.0"
API_VERSION = "1"
INDEX_VERSION = "1"

def maintenance_worker() -> None:
    """ÕÉÄÕÅ░Õ«ÜµùÂþ╗┤µèñõ╗╗Õèí´╝Üµ©àþÉåÞ┐çµ£ƒþëêµ£¼´╝îõ╝ÿÕîûþúüþøÿþ®║Úù┤"""
    logger.info("Maintenance worker started.")
    last_run = 0.0
    while True:
        try:
            # µ»Å 24 Õ░ÅµùÂµëºÞíîõ©Çµ¼í (86400 þºÆ)
            now = time.time()
            if now - last_run > 86400:
                retention = int(METRICS.get("current_retention_days", 7))
                db_svc.optimize_database(retention_days=retention)
                METRICS["last_maintenance_at"] = datetime.now().isoformat()
                METRICS["db_size_bytes"] = db_svc.get_storage_metrics()
                last_run = now
        except Exception as e:
            logger.error("Error in maintenance worker: %s", e)

        # µ»Å 30 ÕêåÚÆƒµúÇµƒÑõ©Çµ¼íµÿ»ÕÉªÚ£ÇÞªüµëºÞíî´╝êÚü┐ÕàìÚò┐µ£ƒÕìáþö¿ CPU´╝ë
        time.sleep(1800)


@asynccontextmanager
async def lifespan(app_instance: FastAPI):
    """应用全局生命周期管理器 (替代已废弃的 on_event)"""
    is_testing = os.getenv("SEMANTIX_TESTING", "").lower() in ("1", "true") or "pytest" in sys.modules
    if not is_testing:
        thread = threading.Thread(target=watchdog, daemon=True)
        thread.start()
        mt_thread = threading.Thread(target=maintenance_worker, daemon=True)
        mt_thread.start()
        reranker_service.start_loading()
        write_pid_file()
        logger.info("Semantix backend service started. Parent PID: %d", PARENT_PID)
    yield
    if not is_testing:
        logger.info("Semantix backend service is shutting down...")
        cleanup_pid_file()
        db_svc.close()


# Initialize FastAPI app
app = FastAPI(
    title="Semantix Engine",
    version=ENGINE_VERSION,
    dependencies=[Depends(verify_token)],
    lifespan=lifespan,
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
    global LAST_ACTIVITY
    LAST_ACTIVITY = time.time()
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


# --- Routes ---


@app.get("/health", tags=["System"])
def health_check():
    """Health check and capability negotiation endpoint."""
    active_dev = getattr(reranker_service, "active_device", None) or getattr(embedding_service, "active_device", None)
    hardware_info = device_manager.get_device_info(active_device=active_dev)

    if not embedding_service.is_ready:
        return {
            "status": "loading",
            "message": "Model is loading...",
            "engine_version": ENGINE_VERSION,
            "api_version": API_VERSION,
            "embedding_model": embedding_service.model_name,
            "index_version": INDEX_VERSION,
            "hardware": hardware_info,
        }
    return {
        "status": "ok",
        "message": "Semantix backend is ready.",
        "engine_version": ENGINE_VERSION,
        "api_version": API_VERSION,
        "embedding_model": embedding_service.model_name,
        "index_version": INDEX_VERSION,
        "hardware": hardware_info,
    }


@app.get("/ping", tags=["System"])
def ping():
    """Heartbeat endpoint to keep the service alive."""
    global LAST_ACTIVITY
    LAST_ACTIVITY = time.time()
    return {"status": "alive", "timestamp": LAST_ACTIVITY}


@app.get("/ready", tags=["System"])
def readiness_check():
    """Alias for health_check, kept for compatibility."""
    return health_check()


@app.get("/index/status", response_model=IndexStatusResponse, tags=["Index"])
def get_index_status(vault_id: str = "default"):
    """Get statistics about the current index."""
    count = db_svc.count_notes(vault_id=vault_id)
    return IndexStatusResponse(
        total_notes=count, 
        last_updated=METRICS["last_index_at"], 
        vault_id=vault_id,
        vault_stopwords=list(db_svc.get_vault_stopwords(vault_id))
    )


@app.get("/metrics", response_model=MetricsResponse, tags=["Status"])
def get_metrics(vault_id: Optional[str] = None):
    # Õ«×µùÂÕêÀµû░µò░µì«Õ║ôÕñºÕ░Åµîçµáç
    METRICS["db_size_bytes"] = db_svc.get_storage_metrics()
    return MetricsResponse(**{**METRICS, "total_indexed_docs": db_svc.count_notes(vault_id)})

@app.post("/maintenance/run", tags=["Maintenance"])
def run_maintenance(request: Optional[MaintenanceRequest] = None):
    """µëïÕè¿ÞºªÕÅæµò░µì«Õ║ôµÀ▒Õ║ªþ╗┤µèñ´╝îþ½ïÕì│Õø×µöÂÕà¿Úâ¿ÕÄåÕÅ▓Õ║ƒÕ╝âþëêµ£¼ÒÇé"""
    try:
        # õ┐ØÕ¡ÿÕ«ÜµùÂþ╗┤µèñþ¡ûþòÑ´╝øµëïÕè¿µôìõ¢£µ£¼µ¼íõ╗ìõ╗Ñ 0 Õñ®ÚÿêÕÇ╝þ½ïÕì│Õø×µöÂþ®║Úù┤ÒÇé
        if request is not None:
            METRICS["current_retention_days"] = max(0, request.retention_days)
        db_svc.optimize_database(retention_days=0)
        
        METRICS["last_maintenance_at"] = datetime.now().isoformat()
        METRICS["db_size_bytes"] = db_svc.get_storage_metrics()
        
        return {"status": "ok", "message": "Manual maintenance completed."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/index/batch", tags=["Index"])
def batch_index(request: BatchIndexRequest, background_tasks: BackgroundTasks):
    """Batch embed and index documents."""
    if not request.documents:
        return {"status": "success", "indexed": 0}

    start = time.perf_counter()

    # ÕçåÕñçµûçµíúµò░µì«´╝êõ©ìÕ£¿µ¡ñÕñä encode´╝îupsert_documents ÕåàÚâ¿µîë chunk þ▓ÆÕ║ª encode´╝ë
    data_to_insert = [
        {
            "vault_id": doc.vault_id,
            "path": doc.path,
            "text": doc.text,
            "tags": doc.tags or [],
            "links": doc.links or [],
        }
        for doc in request.documents
    ]

    try:
        upsert_res = index_service.upsert_documents(data_to_insert)
        # 标记 FTS 脏位，由节流逻辑决定是否真正 rebuild
        storage.mark_fts_dirty()
        background_tasks.add_task(storage.maybe_rebuild_fts_index)
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Database insertion failed: {str(e)}"
        )

    success_docs = upsert_res["success_docs"]
    indexed_chunks = upsert_res["indexed_chunks"]
    failed_docs = upsert_res["failed_docs"]

    duration_ms = (time.perf_counter() - start) * 1000
    METRICS["total_indexed_docs"] += success_docs
    METRICS["last_index_at"] = datetime.now().isoformat()
    METRICS["last_index_ms"] = duration_ms
    logger.info("Indexed %d chunks (%d documents, %d failed) in %.2fms", indexed_chunks, success_docs, len(failed_docs), duration_ms)

    return {
        "status": "success",
        "indexed": success_docs,
        "indexed_chunks": indexed_chunks,
        "failed_paths": failed_docs,
    }


@app.post("/index/delete", tags=["Index"])
def delete_index(request: DeleteIndexRequest, background_tasks: BackgroundTasks):
    """Delete specific paths from the index."""
    if not request.paths:
        return {"status": "success"}

    try:
        storage.delete_by_paths(request.vault_id, request.paths)
        storage.mark_fts_dirty()
        background_tasks.add_task(storage.maybe_rebuild_fts_index)
        return {"status": "success", "deleted": len(request.paths)}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Database deletion failed: {str(e)}"
        )


@app.post("/index/clear/request", tags=["Index"])
def request_clear_index(vault_id: Optional[str] = None):
    """
    第一步：请求清空指定 vault 索引，返回确认 token。
    客户端需要在 5 分钟内调用 /index/clear/confirm
    """
    if not vault_id or not vault_id.strip():
        raise HTTPException(
            status_code=400,
            detail="vault_id is required. Unscoped clear operation is disabled for safety."
        )

    clean_vault_id = vault_id.strip()
    token = secrets.token_urlsafe(16)
    _pending_clear_requests[token] = {
        "vault_id": clean_vault_id,
        "created_at": datetime.now(),
        "expires_at": datetime.now() + timedelta(minutes=5),
    }

    scope = f"vault '{clean_vault_id}'"
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
    第二步：使用 token 确认清空指定 vault 索引
    """
    confirmation_token = request.confirmation_token
    vault_id = request.vault_id

    if not vault_id or not vault_id.strip():
        raise HTTPException(
            status_code=400,
            detail="vault_id is required. Unscoped clear operation is disabled for safety."
        )

    clean_vault_id = vault_id.strip()
    pending_request = _pending_clear_requests.pop(confirmation_token, None)

    if not pending_request:
        raise HTTPException(
            status_code=400, detail="Invalid or expired confirmation token"
        )

    token_scope_vault_id = pending_request.get("vault_id")
    if token_scope_vault_id != clean_vault_id:
        raise HTTPException(
            status_code=400,
            detail="Confirmation token scope mismatch",
        )

    if datetime.now() > pending_request["expires_at"]:
        raise HTTPException(status_code=400, detail="Confirmation token expired")

    db_svc.clear_vault(clean_vault_id)
    scope = f"vault '{clean_vault_id}'"

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


@app.post("/search/radar", response_model=RadarSearchResponse, tags=["Search"])
def radar_search(request: RadarSearchRequest):
    """
    Semantix Radar µá©Õ┐âÕÅîµÁüþ½»þé╣´╝Ü
    ÕÉîµùÂÞ«íþ«ù Related (Õ╝║þø©Õà│) õ©Ä Discover (µäÅÕñûÕà│Þüö) õ©ñÞÀ»þ╗ôµ×£´╝î
    þö▒Õëìþ½»þöƒµêÉ context_id Õ╣ÂÕÄƒµáÀ Echo´╝îµö»µîü fast / balanced / high_quality þ▓¥µÄÆÒÇé
    """
    start = time.perf_counter()
    ctx = request.context
    query_text = ctx.text.strip() if ctx.text else ""
    if not query_text:
        return RadarSearchResponse(
            context_id=request.context_id,
            related=[],
            discover=[]
        )

    try:
        radar_result = radar_pipeline.execute(
            vault_id=request.vault_id,
            query_text=query_text,
            current_path=ctx.path,
            title=ctx.title,
            heading=ctx.heading,
            current_tags=ctx.tags,
            current_links=ctx.links,
            exclude_paths=request.exclude_paths,
            top_k_related=request.top_k_related or 4,
            top_k_discover=request.top_k_discover or 4,
            ranking_mode=request.ranking_mode or "balanced",
            mmr_lambda=request.mmr_lambda if request.mmr_lambda is not None else 0.65,
        )
    except Exception as e:
        logger.error("Radar search failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Radar search failed: {str(e)}")

    duration_ms = (time.perf_counter() - start) * 1000
    METRICS["total_searches"] += 1
    METRICS["last_search_at"] = datetime.now().isoformat()
    METRICS["last_search_ms"] = duration_ms
    logger.info("Radar search [%s] completed in %.2fms", request.context_id, duration_ms)

    return RadarSearchResponse(
        context_id=request.context_id,
        related=[RadarCardItem(**item) for item in radar_result.get("related", [])],
        discover=[RadarCardItem(**item) for item in radar_result.get("discover", [])],
    )


@app.post("/index/compute-stopwords", tags=["Index"])
def compute_stopwords_api(request: MaintenanceRequest):
    if not request.vault_id:
        raise HTTPException(status_code=422, detail="vault_id is required")
    try:
        noise_words = index_service.compute_vault_stopwords(request.vault_id)
        return {"status": "success", "count": len(noise_words), "words": noise_words}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/index/rebuild-fts", tags=["Index"])
def rebuild_fts_api():
    """全量重构完成后显式触发 FTS 倒排索引构建，无需等待后台 30s 节流"""
    try:
        storage.rebuild_fts_index()
        return {"status": "success", "message": "FTS inverted index rebuilt successfully."}
    except Exception as e:
        logger.error("Explicit rebuild FTS failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("SEMANTIX_HOST", "127.0.0.1")
    raw_port = os.getenv("SEMANTIX_PORT", "8000")
    try:
        port = int(raw_port)
    except ValueError:
        logger.warning("Invalid SEMANTIX_PORT '%s', falling back to 8000", raw_port)
        port = 8000

    log_level = os.getenv("SEMANTIX_LOG_LEVEL", "info").lower()
    logger.info("Starting Semantix Engine via CLI on %s:%d (log_level=%s)...", host, port, log_level)
    uvicorn.run("main:app", host=host, port=port, reload=False, log_level=log_level)

