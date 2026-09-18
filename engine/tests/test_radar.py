import pytest
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient
from main import app
from services.ranking.normalizer import ScoreNormalizer
from services.ranking.mmr import select_by_mmr, cosine_similarity
from services.ranking.features import CandidateFeatures
from services.retrieval_service import RetrievalCandidate
from services.ranking.related import RelatedRanker
from services.ranking.discover import DiscoverRanker


@pytest.fixture
def client():
    return TestClient(app)


def test_score_normalizer():
    assert ScoreNormalizer.normalize_cosine(1.2) == 1.0
    assert ScoreNormalizer.normalize_cosine(-0.5) == 0.0
    assert 0.0 <= ScoreNormalizer.normalize_rerank_logit(0.0) <= 1.0
    lex = ScoreNormalizer.normalize_batch_lexical([10.0, 20.0, 30.0])
    assert lex == [0.0, 0.5, 1.0]


def test_mmr_selection():
    # 构造两个极其相似的向量和一个差异较大的向量
    c1 = {"id": "1", "score": 0.9, "vec": [1.0, 0.0, 0.0]}
    c2 = {"id": "2", "score": 0.88, "vec": [0.99, 0.05, 0.0]} # 和 c1 极似
    c3 = {"id": "3", "score": 0.75, "vec": [0.0, 1.0, 0.0]}   # 正交但依然有分

    selected = select_by_mmr(
        candidates=[c1, c2, c3],
        get_vector=lambda x: x["vec"],
        get_score=lambda x: x["score"],
        top_k=2,
        lambda_param=0.5,
    )
    selected_ids = [item["id"] for item in selected]
    # c1 基础分最高先入选，随后 c3 因多样性优势入选，c2 被抑制
    assert selected_ids == ["1", "3"]


def test_related_and_discover_mutual_exclusivity():
    # 模拟 5 个候选
    candidates = []
    for i in range(5):
        rc = RetrievalCandidate(
            path=f"note_{i}.md",
            title=f"Note {i}",
            snippet=f"Snippet for note {i}",
            vector=[1.0 if j == i else 0.0 for j in range(5)],
            semantic_score=0.8 - i * 0.05,
            lexical_score=float(5 - i),
            matched_chunk_index=0,
            tags=[],
            links=[],
            full_path=f"note_{i}",
        )
        feat = CandidateFeatures(
            candidate=rc,
            semantic_norm=rc.semantic_score,
            rerank_norm=rc.semantic_score,
            lexical_norm=0.5,
            is_direct_link=False,
            is_same_folder=False,
            tag_overlap=0,
        )
        candidates.append(feat)

    related = RelatedRanker.rank(candidates, top_k=2)
    assert len(related) == 2
    related_paths = {r.candidate.path for r in related}

    discover = DiscoverRanker.rank(
        all_features=candidates,
        related_selected=related,
        top_k=2,
        min_relevance=0.4,
    )
    discover_paths = {d.candidate.path for d in discover}

    # 验证绝对互斥
    assert related_paths.isdisjoint(discover_paths)
    assert len(discover) <= 2


def test_radar_search_empty_query(client):
    payload = {
        "vault_id": "test_vault",
        "context_id": "ctx_123",
        "context": {
            "path": "Inbox/Test.md",
            "title": "Test",
            "heading": "H1",
            "text": "",
            "tags": [],
            "links": [],
        },
        "top_k_related": 4,
        "top_k_discover": 4,
    }
    response = client.post("/search/radar", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["context_id"] == "ctx_123"
    assert data["related"] == []
    assert data["discover"] == []


def test_feature_builder_links_and_bridges():
    from services.ranking.features import FeatureBuilder

    # 构造候选 1: 具有与当前笔记反向链接 (候选 links 存了 basename "CurrentNote")
    c1 = RetrievalCandidate(
        path="folder/Candidate1.md",
        title="Candidate 1",
        snippet="Snippet 1",
        vector=[0.1] * 5,
        semantic_score=0.8,
        lexical_score=1.0,
        matched_chunk_index=0,
        tags=["ai"],
        links=["CurrentNote"],  # 历史未解析别名
        full_path="folder > Candidate1",
    )
    # 构造候选 2: 与当前笔记共享同一核心概念出链 (2-hop 共同引用)
    c2 = RetrievalCandidate(
        path="folder/Candidate2.md",
        title="Candidate 2",
        snippet="Snippet 2",
        vector=[0.2] * 5,
        semantic_score=0.75,
        lexical_score=1.0,
        matched_chunk_index=0,
        tags=["tech"],
        links=["System/Architecture.md"],  # 共享核心链接
        full_path="folder > Candidate2",
    )

    feats = FeatureBuilder.build_features(
        candidates=[c1, c2],
        current_path="Daily/CurrentNote.md",
        current_tags=["ai"],
        current_links=["System/Architecture.md"],
    )

    # 验证 c1 成功识别反向链接
    assert feats[0].is_direct_link is True
    assert feats[0].shared_links_count == 0

    # 验证 c2 无直接链接，但 2-hop 共同引用桥梁数精准命中 1
    assert feats[1].is_direct_link is False
    assert feats[1].shared_links_count == 1
    assert feats[1].concept_bridge_target.lower() == "architecture"


def test_related_relevance_rejection_gate():
    # 构造两个低分候选 (相关度 < 0.35) 和一个直接链接候选 (分数为 0.255，在 0.22 ~ 0.35 之间)
    c_low = RetrievalCandidate(
        path="low.md", title="Low", snippet="low", vector=[0.1]*5,
        semantic_score=0.2, lexical_score=0.0, matched_chunk_index=0, tags=[], links=[], full_path="low"
    )
    c_direct = RetrievalCandidate(
        path="direct.md", title="Direct", snippet="direct", vector=[0.1]*5,
        semantic_score=0.30, lexical_score=0.0, matched_chunk_index=0, tags=[], links=[], full_path="direct"
    )

    feat_low = CandidateFeatures(
        candidate=c_low, semantic_norm=0.2, rerank_norm=0.2, lexical_norm=0.0,
        is_direct_link=False, is_same_folder=False, tag_overlap=0
    )
    # relevance = 0.50 * 0.30 + 0.35 * 0.30 = 0.255 (满足 >= 0.22 豁免，但不满足 >= 0.35)
    feat_direct = CandidateFeatures(
        candidate=c_direct, semantic_norm=0.30, rerank_norm=0.30, lexical_norm=0.0,
        is_direct_link=True, is_same_folder=False, tag_overlap=0
    )

    # 仅低分候选时被全部拒答，返回空列表
    res1 = RelatedRanker.rank([feat_low], top_k=2)
    assert len(res1) == 0

    # 直接链接候选超过豁免门槛 (0.22) 时被成功保留
    res2 = RelatedRanker.rank([feat_low, feat_direct], top_k=2)
    assert len(res2) == 1
    assert res2[0].candidate.path == "direct.md"


def test_doc_diversity_guard():
    from services.retrieval_service import RetrievalService
    # 模拟 5 个分块来自同一篇长笔记，3 个来自另一篇
    rows = [
        {"path": "long_doc.md", "chunk_index": i, "_distance": 0.1 * i} for i in range(5)
    ] + [
        {"path": "short_doc.md", "chunk_index": i, "_distance": 0.2 * i} for i in range(3)
    ]

    guarded = RetrievalService._apply_doc_diversity_guard(rows, max_per_doc=2, target_limit=10)
    # long_doc.md 只能保留 2 个，short_doc.md 只能保留 2 个，总计 4 个
    assert len(guarded) == 4
    long_count = sum(1 for r in guarded if r["path"] == "long_doc.md")
    short_count = sum(1 for r in guarded if r["path"] == "short_doc.md")
    assert long_count == 2
    assert short_count == 2


def test_new_label_resolver_single_badge():
    from services.ranking.labels import LabelResolver
    c = RetrievalCandidate(
        path="folder/Note.md", title="Note", snippet="snippet", vector=[0.1]*5,
        semantic_score=0.8, lexical_score=0.0, matched_chunk_index=0, tags=[], links=[], full_path="folder > Note"
    )
    feat = CandidateFeatures(
        candidate=c, semantic_norm=0.8, rerank_norm=0.8, lexical_norm=0.0,
        is_direct_link=False, is_same_folder=False, tag_overlap=0,
        is_title_mentioned=True, is_cross_domain=True
    )
    feat.relevance_score = 0.85

    labels = LabelResolver.resolve_related_labels(feat)
    # 仲裁优先级：MISSING_LINK 优于 CROSS_DOMAIN，且严格只返回 1 个徽章
    assert len(labels) == 1
    assert labels[0] == "MISSING_LINK"


if __name__ == "__main__":
    pytest.main([__file__])


