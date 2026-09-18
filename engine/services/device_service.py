import logging
import threading
from typing import Dict, Any, Optional
import torch

logger = logging.getLogger("semantix")


class DeviceManager:
    """
    负责硬件加速设备的探测、健康度校验及多级故障回退管理。
    优先采用 CUDA / MPS 加速，若驱动损坏、显存耗尽或探测失败则平滑回退至 CPU。
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._preferred_device: Optional[str] = None
        self._is_degraded: bool = False
        self._fallback_reasons: Dict[str, str] = {}

    def probe_cuda(self) -> bool:
        """探针检测：通过实际分配微量显存验证 CUDA 驱动与上下文是否真正健康可用"""
        if not torch.cuda.is_available():
            return False
        try:
            probe = torch.zeros((1,), device="cuda")
            del probe
            torch.cuda.empty_cache()
            return True
        except Exception as e:
            logger.warning("CUDA is reported available but hardware probe failed: %s", e)
            return False

    def probe_mps(self) -> bool:
        """探针检测：验证 Apple Silicon MPS 运行时是否可用"""
        if not hasattr(torch.backends, "mps"):
            return False
        if not (torch.backends.mps.is_available() and torch.backends.mps.is_built()):
            return False
        try:
            probe = torch.zeros((1,), device="mps")
            del probe
            return True
        except Exception as e:
            logger.warning("MPS is reported available but hardware probe failed: %s", e)
            return False

    def get_preferred_device(self) -> str:
        """获取系统首选算力设备（仅在首次探测时缓存）"""
        with self._lock:
            if self._preferred_device is not None:
                return self._preferred_device

            if self.probe_cuda():
                self._preferred_device = "cuda"
                logger.info(
                    "Hardware acceleration active: CUDA (%s)",
                    torch.cuda.get_device_name(0),
                )
            elif self.probe_mps():
                self._preferred_device = "mps"
                logger.info("Hardware acceleration active: Apple Silicon MPS")
            else:
                self._preferred_device = "cpu"
                logger.info("Hardware acceleration inactive: using CPU")

            return self._preferred_device

    def mark_fallback(self, component: str, reason: str):
        """记录降级事件与原因"""
        with self._lock:
            self._is_degraded = True
            self._fallback_reasons[component] = reason
            logger.warning("Component [%s] degraded to CPU. Reason: %s", component, reason)

    def get_device_info(self, active_device: Optional[str] = None) -> Dict[str, Any]:
        """获取当前运行态硬件遥测信息，用于健康检查与状态呈现"""
        current = active_device or self.get_preferred_device()
        is_cuda = current.startswith("cuda")
        is_mps = current.startswith("mps")

        vram_total_mb = None
        vram_used_mb = None
        device_name = "CPU"

        if is_cuda and torch.cuda.is_available():
            try:
                device_idx = 0
                device_name = torch.cuda.get_device_name(device_idx)
                props = torch.cuda.get_device_properties(device_idx)
                vram_total_mb = int(props.total_memory / (1024 * 1024))
                vram_used_mb = int(torch.cuda.memory_allocated(device_idx) / (1024 * 1024))
            except Exception as e:
                logger.debug("Failed to read CUDA memory info: %s", e)
        elif is_mps:
            device_name = "Apple Silicon GPU"

        acceleration = "gpu" if is_cuda else ("mps" if is_mps else "none")

        fallback_reason = None
        if self._is_degraded and self._fallback_reasons:
            fallback_reason = "; ".join(f"{k}: {v}" for k, v in self._fallback_reasons.items())

        return {
            "device": current,
            "device_name": device_name,
            "acceleration": acceleration,
            "cuda_available": torch.cuda.is_available(),
            "vram_total_mb": vram_total_mb,
            "vram_used_mb": vram_used_mb,
            "is_degraded": self._is_degraded,
            "fallback_reason": fallback_reason,
        }


# 全局单例
device_manager = DeviceManager()
