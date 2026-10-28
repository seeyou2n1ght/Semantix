"""Model selection and truthful availability without model downloads."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from types import SimpleNamespace
import pytest
from config.model_config import DEFAULT_RERANKER_MODEL, LEGACY_RERANKER_MODEL, RERANKER_MAX_LENGTH, DEFAULT_RERANKER_REVISION, get_reranker_model
from services.reranker_service import RerankerService
import importlib
reranking = importlib.import_module("services.reranker_service")


def test_explicit_model_selection(monkeypatch):
    monkeypatch.delenv("SEMANTIX_RERANKER_MODEL", raising=False)
    assert RerankerService().model_name == DEFAULT_RERANKER_MODEL
    monkeypatch.setenv("SEMANTIX_RERANKER_MODEL", LEGACY_RERANKER_MODEL)
    assert RerankerService().model_name == LEGACY_RERANKER_MODEL
    monkeypatch.setenv("SEMANTIX_RERANKER_MODEL", "unknown/model")
    with pytest.raises(ValueError, match="SEMANTIX_RERANKER_MODEL"):
        get_reranker_model()


@pytest.mark.parametrize("fail_cpu", [False, True])
def test_loader_cpu_fallback_retains_selected_model_and_bounds(monkeypatch, fail_cpu):
    calls = []
    def encoder(model, **kwargs):
        calls.append((model, kwargs))
        if kwargs["device"] != "cpu" or fail_cpu:
            raise RuntimeError("controlled load failure")
        return SimpleNamespace()
    monkeypatch.setattr(reranking, "CrossEncoder", encoder)
    monkeypatch.setattr(reranking.device_manager, "get_preferred_device", lambda: "cuda")
    monkeypatch.setattr(reranking.device_manager, "mark_fallback", lambda *a: None)
    service = RerankerService()
    service._load_model()
    assert [c[0] for c in calls] == [DEFAULT_RERANKER_MODEL] * 2
    assert all(c[1]["max_length"] == RERANKER_MAX_LENGTH == 512 and c[1]["trust_remote_code"] is False for c in calls)
    assert all(c[1]["revision"] == DEFAULT_RERANKER_REVISION and c[1]["model_kwargs"]["use_safetensors"] for c in calls)
    assert service.status == ("error" if fail_cpu else "ready")
    if fail_cpu:
        monkeypatch.setattr(service, "start_loading", lambda: pytest.fail("permanent failure retried"))
        assert service.predict_scores("q", ["p"]) is None
        assert service.active_device is None
    else:
        assert service.active_device == "cpu"


@pytest.mark.parametrize("state", ["not_loaded", "loading", "error", "ready"])
def test_health_exposes_reranker_state_without_breaking_semantic_health(monkeypatch, state):
    import main
    monkeypatch.setattr(main, "embedding_service", SimpleNamespace(is_ready=True, load_error=None, active_device="cpu", model_name="unchanged"))
    monkeypatch.setattr(main, "reranker_service", SimpleNamespace(status=state, is_ready=state == "ready", active_device="cpu" if state == "ready" else None, model_name=DEFAULT_RERANKER_MODEL, model_revision=DEFAULT_RERANKER_REVISION))
    result = main.health_check()
    assert result["status"] == "ok"
    assert result["reranker_status"] == state
    assert result["reranker_model"] == DEFAULT_RERANKER_MODEL
    if state != "ready":
        assert "degraded semantic" in result["message"]
    else:
        assert "degraded" not in result["message"]


@pytest.mark.parametrize("failure", [None, "embedding", "reranker"])
def test_downloader_uses_shared_selection_and_reports_partial_failure(monkeypatch, capsys, failure):
    import scripts.download_models as downloader
    monkeypatch.setenv("SEMANTIX_RERANKER_MODEL", LEGACY_RERANKER_MODEL)
    def embedding(model):
        if failure == "embedding": raise RuntimeError("controlled")
    def reranker(model, **kwargs):
        assert model == LEGACY_RERANKER_MODEL
        assert kwargs["max_length"] == 512 and kwargs["trust_remote_code"] is False
        if failure == "reranker": raise RuntimeError("controlled")
    monkeypatch.setattr(downloader, "SentenceTransformer", embedding)
    monkeypatch.setattr(downloader, "CrossEncoder", reranker)
    assert downloader.download_models(use_mirror=False) is (failure is None)
    output = capsys.readouterr().out
    assert ("所有依赖模型已完成预下载" in output) is (failure is None)


def test_cpu_inference_failure_marks_service_unavailable(monkeypatch):
    service = RerankerService()
    def fail(*args, **kwargs):
        raise RuntimeError("controlled CPU inference failure")
    service._model = SimpleNamespace(predict=fail)
    service.active_device = "cpu"
    assert service.predict_scores("query", ["passage"]) is None
    assert service.status == "error" and not service.is_ready
    assert service.load_error is not None
    monkeypatch.setattr(service, "start_loading", lambda: pytest.fail("failed inference retried"))
    assert service.predict_scores("query", ["passage"]) is None
