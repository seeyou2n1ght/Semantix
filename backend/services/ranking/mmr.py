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
    Maximal Marginal Relevance (MMR) 贪心选择：
    MMR = argmax_{d in C \ S} [ lambda * BaseScore(d) - (1 - lambda) * max_{s in S} Sim(d, s) ]
    """
    if not candidates or top_k <= 0:
        return []

    if len(candidates) <= top_k:
        return candidates

    selected: List[Any] = []
    selected_vectors: List[np.ndarray] = []
    remaining = list(candidates)

    while len(selected) < top_k and remaining:
        best_idx = -1
        best_mmr_val = -float("inf")

        for idx, item in enumerate(remaining):
            base_score = get_score(item)
            item_vec = np.asarray(get_vector(item), dtype=np.float32)
            norm_item = np.linalg.norm(item_vec)

            # 计算与已选集合的最大相似度
            if not selected_vectors or norm_item == 0:
                max_sim_to_selected = 0.0
            else:
                sims = [
                    float(np.dot(item_vec, s_vec) / (norm_item * np.linalg.norm(s_vec)))
                    for s_vec in selected_vectors
                ]
                max_sim_to_selected = max(sims) if sims else 0.0

            mmr_val = lambda_param * base_score - (1.0 - lambda_param) * max_sim_to_selected

            if mmr_val > best_mmr_val:
                best_mmr_val = mmr_val
                best_idx = idx

        if best_idx >= 0:
            chosen = remaining.pop(best_idx)
            selected.append(chosen)
            selected_vectors.append(np.asarray(get_vector(chosen), dtype=np.float32))
        else:
            break

    return selected
