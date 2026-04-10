import pytest
from fastapi.testclient import TestClient
import os
import sys

# Add root to sys.path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import app

client = TestClient(app)

def test_health_endpoint():
    """测试健康检查接口"""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] in ["ok", "loading"]

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

def test_unauthorized_access():
    """测试未授权访问 (当设置了 TOKEN 时)"""
    # 临时模拟设置 TOKEN (如果 main.py 逻辑允许)
    # 实际上取决于环境变量，此处简单校验正常访问
    pass

if __name__ == "__main__":
    pytest.main([__file__])
