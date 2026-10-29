import math
from typing import List


class ScoreNormalizer:
    """
    负责将不同量纲与分布的打分（Cosine 向量相似度、CrossEncoder Logits、BM25 词面分）
    映射至 [0, 1] 的启发式排序特征，不代表跨查询稳定的匹配概率。
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
        if max_s <= 0:
            return [0.0] * len(scores)
        return [max(0.0, s) / max_s for s in scores]

    @staticmethod
    def normalize_evidence_lexical(
        scores: List[float], evidence_strengths: List[float],
    ) -> List[float]:
        """Keep weaker BM25 outliers out of stronger evidence's scale.

        Each positive evidence tier uses matches of equal or greater strength
        as its reference. Zero-evidence rows cannot set a reference. The caller
        still applies the evidence-strength cap after normalization. Batches
        with one positive strength tier retain the original relative scale.
        """
        if len(scores) != len(evidence_strengths):
            raise ValueError("Lexical scores and evidence strengths must align")
        references = {
            strength: max((score for score, other in zip(scores, evidence_strengths)
                           if other >= strength), default=0.0)
            for strength in set(evidence_strengths) if strength > 0
        }
        return [max(0.0, score) / references[strength]
                if strength > 0 and references[strength] > 0 else 0.0
                for score, strength in zip(scores, evidence_strengths)]
