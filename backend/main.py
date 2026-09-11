import os
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
    SemanticSearchRequest,
    SemanticSearchResponse,
    SearchResultItem,
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
from db_svc import db_svc

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
WATCHDOG_INTERVAL = 10  # 检查频率 (秒，更快响应 Obsidian 退出)
ACTIVITY_TIMEOUT = int(os.getenv("SEMANTIX_WATCHDOG_TIMEOUT", "600"))  # 无响应自杀阈值 (秒, <=0 则禁用)
PID_FILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".semantix.pid")

def is_process_running(pid: int) -> bool:
    """跨平台检查进程是否仍在运行 (精准判定存活态)"""
    if pid <= 0:
        return False
        
    # Windows 平台实现
    if os.name == 'nt':
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            # 必须检查退出代码：STILL_ACTIVE = 259 (0x103)
            # 若父进程已被结束，句柄在完全销毁前可能仍然可开，但 exit_code 绝不是 STILL_ACTIVE
            exit_code = ctypes.c_ulong()
            if ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return exit_code.value == 259
            return False
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    else:
        # Unix 平台实现
        try:
            os.kill(pid, 0)
            return True
        except PermissionError:
            # 进程存在但无权限发送信号
            return True
        except OSError:
            return False

def watchdog():
    """后台监控线程：检查心跳超时或父进程消失"""
    global LAST_ACTIVITY
    logger.info("Watchdog monitoring started (Interval: %ds, Timeout: %ds, Parent PID: %d)", WATCHDOG_INTERVAL, ACTIVITY_TIMEOUT, PARENT_PID)
    
    while True:
        time.sleep(WATCHDOG_INTERVAL)
        now = time.time()
        
        # 1. 检查父进程存活 (优先判定 Obsidian 是否退出/崩溃)
        if PARENT_PID > 0:
            if not is_process_running(PARENT_PID):
                logger.warning("Parent process (PID %d) terminated. Sidecar initiating graceful self-shutdown...", PARENT_PID)
                cleanup_pid_file()
                os.kill(os.getpid(), signal.SIGTERM)
                break

        # 2. 检查心跳超时 (若配置了有效正数超时)
        if ACTIVITY_TIMEOUT > 0 and (now - LAST_ACTIVITY > ACTIVITY_TIMEOUT):
            logger.warning("Heartbeat timeout (%ds). Sidecar initiating self-shutdown...", ACTIVITY_TIMEOUT)
            cleanup_pid_file()
            os.kill(os.getpid(), signal.SIGTERM)
            break

def write_pid_file():
    """写入当前进程 PID 锁文件供前端精准识别与回收"""
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
    """清理 PID 锁文件"""
    try:
        if os.path.exists(PID_FILE_PATH):
            os.remove(PID_FILE_PATH)
    except Exception:
        pass


def verify_token(x_semantix_token: str | None = Header(default=None)):
    if API_TOKEN and x_semantix_token != API_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")


ENGINE_VERSION = "0.8.0"
API_VERSION = "1"
INDEX_VERSION = "1"

def maintenance_worker() -> None:
    """后台定时维护任务：清理过期版本，优化磁盘空间"""
    logger.info("Maintenance worker started.")
    last_run = 0.0
    while True:
        try:
            # 每 24 小时执行一次 (86400 秒)
            now = time.time()
            if now - last_run > 86400:
                retention = int(METRICS.get("current_retention_days", 7))
                db_svc.optimize_database(retention_days=retention)
                METRICS["last_maintenance_at"] = datetime.now().isoformat()
                METRICS["db_size_bytes"] = db_svc.get_storage_metrics()
                last_run = now
        except Exception as e:
            logger.error("Error in maintenance worker: %s", e)

        # 每 30 分钟检查一次是否需要执行（避免长期占用 CPU）
        time.sleep(1800)


@asynccontextmanager
async def lifespan(app_instance: FastAPI):
    """应用全局生命周期管理器 (替代已废弃的 on_event)"""
    # 启动看门狗线程
    thread = threading.Thread(target=watchdog, daemon=True)
    thread.start()
    # 启动后台维护线程
    mt_thread = threading.Thread(target=maintenance_worker, daemon=True)
    mt_thread.start()
    # 预加载精排模型
    reranker_service.start_loading()
    write_pid_file()
    logger.info("Semantix backend service started. Parent PID: %d", PARENT_PID)
    yield
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
    if not embedding_service.is_ready:
        return {
            "status": "loading",
            "message": "Model is loading...",
            "engine_version": ENGINE_VERSION,
            "api_version": API_VERSION,
            "embedding_model": embedding_service.model_name,
            "index_version": INDEX_VERSION,
        }
    return {
        "status": "ok",
        "message": "Semantix backend is ready.",
        "engine_version": ENGINE_VERSION,
        "api_version": API_VERSION,
        "embedding_model": embedding_service.model_name,
        "index_version": INDEX_VERSION,
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
    # 实时刷新数据库大小指标
    METRICS["db_size_bytes"] = db_svc.get_storage_metrics()
    return MetricsResponse(**{**METRICS, "total_indexed_docs": db_svc.count_notes(vault_id)})

@app.post("/maintenance/run", tags=["Maintenance"])
def run_maintenance(request: Optional[MaintenanceRequest] = None):
    """手动触发数据库深度维护，立即回收全部历史废弃版本。"""
    try:
        # 保存定时维护策略；手动操作本次仍以 0 天阈值立即回收空间。
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

    # 准备文档数据（不在此处 encode，upsert_documents 内部按 chunk 粒度 encode）
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
        upsert_res = db_svc.upsert_documents(data_to_insert)
        # 标记 FTS 脏位，由节流逻辑决定是否真正 rebuild
        db_svc.mark_fts_dirty()
        background_tasks.add_task(db_svc.maybe_rebuild_fts_index)
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


@app.post("/search/radar", response_model=RadarSearchResponse, tags=["Search"])
def radar_search(request: RadarSearchRequest):
    """
    Semantix Radar 核心双流端点：
    同时计算 Related (强相关) 与 Discover (意外关联) 两路结果，
    由前端生成 context_id 并原样 Echo，支持 fast / balanced / high_quality 精排。
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
        radar_result = db_svc.radar_search(
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


@app.post("/search/semantic", response_model=SemanticSearchResponse, tags=["Search"], deprecated=True)
def semantic_search(request: SemanticSearchRequest):
    """Deprecated adapter: 保持对旧客户端的向后兼容，内部转为 Radar 检索的 Related 流"""
    if not request.text or len(request.text.strip()) == 0:
        return SemanticSearchResponse(results=[])

    start = time.perf_counter()
    try:
        # Encode the query text with BGE instruction prefix via embedding_service
        query_vector = embedding_service.encode_query(request.text)
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
            current_path=request.current_path,
            current_tags=request.current_tags,
            current_links=request.current_links,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Database search failed: {str(e)}")

    duration_ms = (time.perf_counter() - start) * 1000
    METRICS["total_searches"] += 1
    METRICS["last_search_at"] = datetime.now().isoformat()
    METRICS["last_search_ms"] = duration_ms
    logger.info("Search completed in %.2fms", duration_ms)

    # 精排逻辑 (Phase 4) — 直接使用 services 模块单例
    final_results = raw_results
    if request.rerank and reranker_service.is_ready:
        try:
            texts = [c.get("snippet", "") for c in raw_results]
            scores = reranker_service.predict_scores(request.text, texts)
            for i, score in enumerate(scores):
                normalized = reranker_service.normalize_score(score)
                raw_results[i]["score"] = normalized
            raw_results.sort(key=lambda x: x["score"], reverse=True)
            final_results = raw_results[:request.top_k]
        except Exception as e:
            logger.error("Reranking stage failed: %s", e)

    return SemanticSearchResponse(
        results=[SearchResultItem(**res) for res in final_results]
    )


@app.post("/index/compute-stopwords", tags=["Index"])
def compute_stopwords_api(request: MaintenanceRequest):
    if not request.vault_id:
        raise HTTPException(status_code=422, detail="vault_id is required")
    try:
        noise_words = db_svc.compute_vault_stopwords(request.vault_id)
        return {"status": "success", "count": len(noise_words), "words": noise_words}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/index/rebuild-fts", tags=["Index"])
def rebuild_fts_api():
    """全量重建完成后显式触发 FTS 倒排索引构建，无需等待后台 30s 节流"""
    try:
        db_svc.rebuild_fts_index()
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

