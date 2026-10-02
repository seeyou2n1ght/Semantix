from typing import List

import numpy as np


def cosine_similarity(v1: List[float], v2: List[float]) -> float:
    """Shared geometry for recall evidence and diversity ranking."""
    if not v1 or not v2:
        return 0.0
    a = np.asarray(v1, dtype=np.float32)
    b = np.asarray(v2, dtype=np.float32)
    norm = np.linalg.norm(a) * np.linalg.norm(b)
    if norm == 0.0:
        return 0.0
    return float(np.dot(a, b) / norm)
