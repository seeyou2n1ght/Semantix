import numpy as np
from typing import List, Callable, Any


def cosine_similarity(v1: List[float], v2: List[float]) -> float:
    """计算两个向量的余弦相似度（假设通常已归一化，但作防御性模长检查）"""
    if not v1 or not v2:
        return 0.0
    a = np.asarray(v1, dtype=np.float32)
    b = np.asarray(v2, dtype=np.float32)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def select_by_mmr(
    candidates: List[Any],
    get_vector: Callable[[Any], List[float]],
    get_score: Callable[[Any], float],
    top_k: int = 4,
    lambda_param: float = 0.6,
) -> List[Any]:
    r"""
    Maximal Marginal Relevance (MMR) 贪心选择（全矢量化加速版）：
    MMR = argmax_{d in C \ S} [ lambda * BaseScore(d) - (1 - lambda) * max_{s in S} Sim(d, s) ]
    """
    if not candidates or top_k <= 0:
        return []

    if len(candidates) <= top_k:
        return candidates

    # 1. 预先提取所有向量与基础分，一次性转为连续内存 2D 归一化矩阵
    vectors = [get_vector(c) for c in candidates]
    scores = np.array([get_score(c) for c in candidates], dtype=np.float32)

    vec_matrix = np.array(vectors, dtype=np.float32)
    norms = np.linalg.norm(vec_matrix, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0
    norm_matrix = vec_matrix / norms

    n = len(candidates)
    selected_indices: List[int] = []
    unselected_mask = np.ones(n, dtype=bool)

    # 记录未选元素到已选集合的最大相似度 (初始为 0)
    max_sim_to_selected = np.zeros(n, dtype=np.float32)

    while len(selected_indices) < top_k and np.any(unselected_mask):
        # 矢量化 MMR 评价公式
        mmr_scores = np.full(n, -np.inf, dtype=np.float32)
        mmr_scores[unselected_mask] = (
            lambda_param * scores[unselected_mask]
            - (1.0 - lambda_param) * max_sim_to_selected[unselected_mask]
        )

        best_idx = int(np.argmax(mmr_scores))
        if mmr_scores[best_idx] == -np.inf:
            break

        selected_indices.append(best_idx)
        unselected_mask[best_idx] = False

        if len(selected_indices) >= top_k:
            break

        # 增量单次矩阵点积更新与已选集合的最大相似度
        best_vec = norm_matrix[best_idx]
        sims_to_new = np.dot(norm_matrix, best_vec)
        max_sim_to_selected = np.maximum(max_sim_to_selected, sims_to_new)

    return [candidates[i] for i in selected_indices]
