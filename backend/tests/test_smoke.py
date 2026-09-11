import pytest
from fastapi.testclient import TestClient
import os
import sys
from unittest.mock import MagicMock

# Add root to sys.path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import app

client = TestClient(app)


def test_health_endpoint():
    """测试健康检查接口及能力协商协议"""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] in ["ok", "loading"]
    assert data["api_version"] == "1"
    assert data["engine_version"] == "0.8.0"
    assert "embedding_model" in data


def test_ping_endpoint():
    """测试心跳接口"""
    response = client.get("/ping")
    assert response.status_code == 200
    assert "timestamp" in response.json()


def test_metrics_endpoint():
    """测试指标接口"""
    response = client.get("/metrics")
    assert response.status_code == 200
    assert "total_indexed_docs" in response.json()


def test_manual_maintenance_forces_deep_cleanup(monkeypatch):
    """手动维护必须忽略历史保留配置并以 0 天阈值立即清理旧版本。"""
    import main

    optimize = MagicMock()
    monkeypatch.setattr(main.db_svc, "optimize_database", optimize)
    monkeypatch.setattr(main.db_svc, "get_storage_metrics", lambda: 0)
    monkeypatch.setitem(main.METRICS, "current_retention_days", 7)

    response = client.post("/maintenance/run", json={"retention_days": 30})

    assert response.status_code == 200
    optimize.assert_called_once_with(retention_days=0)
    assert main.METRICS["current_retention_days"] == 30


def test_ready_endpoint():
    """测试就绪检查接口"""
    response = client.get("/ready")
    assert response.status_code == 200
    assert response.json()["status"] in ["ok", "loading"]


def test_auth_behavior(monkeypatch):
    """测试当环境变量设置 TOKEN 时的鉴权校验"""
    import main
    monkeypatch.setattr(main, "API_TOKEN", "secret-token")

    # 未带 token 访问受保护接口应返回 401
    unauth_resp = client.post("/search/radar", json={"query": "test", "vault_id": "test"})
    assert unauth_resp.status_code == 401

    # 带正确 token 访问通过鉴权层 (可能因无数据返回 200 或业务状态)
    auth_resp = client.post(
        "/search/radar",
        headers={"X-Semantix-Token": "secret-token"},
        json={"query": "test", "vault_id": "test"}
    )
    assert auth_resp.status_code in [200, 422, 500]


if __name__ == "__main__":
    pytest.main([__file__])
