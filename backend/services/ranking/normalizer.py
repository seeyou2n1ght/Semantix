import math
from typing import List


class ScoreNormalizer:
    """
    负责将不同量纲与分布的打分（Cosine 向量相似度、CrossEncoder Logits、BM25 词面分）
    归一化校准至 [0, 1] 相对概率空间，避免不同特征间直接硬加权导致失真。
    """

    @staticmethod
    def normalize_cosine(score: float) -> float:
        """余弦相似度归一化至 [0, 1]"""
        return max(0.0, min(1.0, float(score)))

    @staticmethod
    def normalize_rerank_logit(logit: float, exponent: float = 0.7) -> float:
        """
        CrossEncoder logit 映射：标准 Sigmoid + 幂函数拉升 (Power Transform)
        Logit=0 -> prob=0.5 -> score=0.5^0.7 ≈ 0.61
        """
        try:
            prob = 1.0 / (1.0 + math.exp(-logit))
            return math.pow(prob, exponent)
        except OverflowError:
            return 0.0 if logit < 0 else 1.0

    @staticmethod
    def normalize_batch_lexical(scores: List[float]) -> List[float]:
        """对批次内的词面/BM25分数做 Min-Max 归一化"""
        if not scores:
            return []
        max_s = max(scores)
        min_s = min(scores)
        if max_s <= 0 or max_s == min_s:
            return [0.0] * len(scores)
        return [(s - min_s) / (max_s - min_s) for s in scores]
