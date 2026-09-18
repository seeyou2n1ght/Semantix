import os
import sys
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import torch
from services.device_service import DeviceManager
from main import app

client = TestClient(app)


def test_device_manager_basic():
    dm = DeviceManager()
    pref = dm.get_preferred_device()
    assert pref in ["cuda", "mps", "cpu"]

    info = dm.get_device_info()
    assert "device" in info
    assert "device_name" in info
    assert "acceleration" in info
    assert "cuda_available" in info
    assert "is_degraded" in info
    assert info["is_degraded"] is False
    assert info["fallback_reason"] is None


def test_device_manager_probe_cuda_failure():
    dm = DeviceManager()
    with patch("torch.cuda.is_available", return_value=True), \
         patch("torch.zeros", side_effect=RuntimeError("CUDA driver initialization failed")):
        assert dm.probe_cuda() is False


def test_device_manager_mark_fallback():
    dm = DeviceManager()
    dm.mark_fallback("reranker", "CUDA OOM test")
    info = dm.get_device_info()
    assert info["is_degraded"] is True
    assert "reranker: CUDA OOM test" in info["fallback_reason"]


def test_health_endpoint_includes_hardware():
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert "hardware" in data
    hw = data["hardware"]
    assert "device" in hw
    assert "device_name" in hw
    assert "acceleration" in hw
    assert "cuda_available" in hw
    assert "is_degraded" in hw
