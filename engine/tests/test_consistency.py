import pytest
import os
import sys
from typing import List, Dict, Any
from datetime import timedelta
from unittest.mock import MagicMock, patch

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.retrieval_service import RetrievalService, RetrievalCandidate
from services.ranking.features import FeatureBuilder, CandidateFeatures
from services.ranking.discover import DiscoverRanker
from services.ranking.labels import LabelResolver
from services.index_service import IndexService
from config import ranking_config


def test_upsert_documents_partial_failure_isolation():
    """测试当批次内某文档向量化异常时，成功的文档正常入库，失败文档被记录且旧索引不被误删"""
    mock_storage = MagicMock()
    mock_embedding = MagicMock()

    # 模拟两篇文档，第二篇编码抛出异常
    def fake_encode(chunks):
        if any("doc2" in c for c in chunks):
            raise RuntimeError("CUDA/Model Encoding Out Of Memory")
        return [[0.1] * 512 for _ in chunks]

    mock_embedding.encode.side_effect = fake_encode
    index_svc = IndexService(storage=mock_storage, embedding_svc=mock_embedding)

    data = [
        {"vault_id": "v1", "path": "doc1.md", "text": "Valid document content."},
        {"vault_id": "v1", "path": "doc2.md", "text": "Corrupted or problematic document."},
    ]

    result = index_svc.upsert_documents(data)

    assert result["success_docs"] == 1
    assert result["failed_docs"] == ["doc2.md"]
    assert result["indexed_chunks"] > 0

    # 验证 replace_documents 仅将 doc1.md 纳入事务，绝对没有将编码失败的 doc2.md 纳入
    mock_storage.replace_documents.assert_called_once()
    call_args = mock_storage.replace_documents.call_args[0]
    assert call_args[1] == {"v1": {"doc1.md"}}


def test_multi_vault_stopwords_isolation(tmp_path):
    """测试多 Vault 停用词在存储层按 vault_id 物理隔离，互不串词"""
    from storage.lancedb_storage import LanceDBStorage

    storage_dir = str(tmp_path / "test_lance")
    storage = LanceDBStorage(db_path=storage_dir)

    storage.set_vault_stopwords("vault_A", ["架构", "设计"])
    storage.set_vault_stopwords("vault_B", ["论文", "实验"])

    stops_a = storage.get_vault_stopwords("vault_A")
    stops_b = storage.get_vault_stopwords("vault_B")

    assert "架构" in stops_a
    assert "设计" in stops_a
    assert "论文" not in stops_a

    assert "论文" in stops_b
    assert "实验" in stops_b
    assert "架构" not in stops_b

    storage.set_vault_stopwords("vault_A", ["新词"])
    assert storage.get_vault_stopwords("vault_A") == {"新词"}


def test_stopword_fallback_uses_two_to_four_character_ngrams():
    """jieba 不可用时仍应覆盖 2、3、4 字滑窗，且不能把整句当成一个巨型词。"""
    index_svc = IndexService(storage=MagicMock(), embedding_svc=MagicMock())
    original_import = __import__

    def import_without_jieba(name, *args, **kwargs):
        if name == "jieba":
            raise ImportError("jieba unavailable")
        return original_import(name, *args, **kwargs)

    with patch("builtins.__import__", side_effect=import_without_jieba):
        tokens = index_svc._extract_tokens("这是一个关于笔记系统的测试")

    assert "这是" in tokens
    assert "这是一个" in tokens
    assert "这是一个关于笔记系统的测试" not in tokens


def test_stopword_threshold_uses_ceiling_document_frequency():
    """30% 阈值必须向上取整，避免 7 篇语料中仅出现 2 次的词被误判为噪音。"""
    rows = [
        {"path": "1.md", "text": "alpha beta"},
        {"path": "2.md", "text": "alpha beta"},
        {"path": "3.md", "text": "beta gamma"},
        {"path": "4.md", "text": "delta"},
        {"path": "5.md", "text": "epsilon"},
        {"path": "6.md", "text": "zeta"},
        {"path": "7.md", "text": "theta"},
    ]
    query = MagicMock()
    query.where.return_value = query
    query.limit.return_value = query
    query.select.return_value = query
    query.to_list.return_value = rows
    storage = MagicMock()
    storage.table.count_rows.return_value = len(rows)
    storage.table.search.return_value = query
    storage._escape_sql_string.return_value = "vault"
    index_svc = IndexService(storage=storage, embedding_svc=MagicMock())

    result = index_svc.compute_vault_stopwords("vault")

    assert result == ["beta"]
    storage.set_vault_stopwords.assert_called_once_with("vault", ["beta"])


def test_manual_database_optimization_prunes_all_old_versions():
    """存储优化必须通过 LanceDB 原生参数立即清理历史版本和未校验碎片。"""
    from storage.lancedb_storage import LanceDBStorage

    storage = LanceDBStorage.__new__(LanceDBStorage)
    storage.table = MagicMock()

    storage.optimize_database(retention_days=0)

    storage.table.optimize.assert_called_once_with(
        cleanup_older_than=timedelta(days=0),
        delete_unverified=True,
    )


def test_rrf_fusion_and_hit_bonus():
    """测试标准 RRF (Reciprocal Rank Fusion) 多路融合算法及多分块 Hit Bonus"""
    mock_storage = MagicMock()
    mock_embedding = MagicMock()
    retrieval_svc = RetrievalService(mock_storage, mock_embedding)

    # 模拟向量路与全文检索路
    vector_rows = [
        {"path": "A.md", "chunk_index": 0, "text": "Vec top chunk", "parent_text": "Vec top chunk", "_distance": 0.1},
        {"path": "B.md", "chunk_index": 0, "text": "Vec second chunk", "parent_text": "Vec second chunk", "_distance": 0.3},
    ]
    fts_rows = [
        {"path": "B.md", "chunk_index": 1, "text": "FTS top chunk", "parent_text": "FTS top chunk", "_score": 25.0},
        {"path": "C.md", "chunk_index": 0, "text": "FTS second chunk", "parent_text": "FTS second chunk", "_score": 15.0},
    ]

    candidates = retrieval_svc._fuse_and_aggregate(vector_rows, fts_rows, rrf_k=60.0)

    # B.md 命中了两个不同 chunk，且在向量与全文均有命中，应获得多块 Hit Bonus
    candidate_paths = [c.path for c in candidates]
    b_cand = next(c for c in candidates if c.path == "B.md")
    assert b_cand.hit_count == 2
    # B.md 由于双路命中且多分块，RRF 分数胜出
    assert candidate_paths[0] == "B.md"

    # 原生量纲保持独立解耦
    assert b_cand.semantic_score > 0.0
    assert b_cand.lexical_score > 0.0


def test_bridge_strength_features_and_labels():
    """测试 2-hop 共同引用与跨目录稀有标签正向 Bridge 奖励与 SHARED_CONCEPT 标签赋予"""
    c1 = RetrievalCandidate(
        path="DomainA/note1.md",
        title="Note 1",
        snippet="Snippet 1",
        vector=[1.0, 0.0, 0.0],
        semantic_score=0.85,
        lexical_score=10.0,
        matched_chunk_index=0,
        tags=["database"],
        links=["Core/DistributedSystem.md"],
        full_path="DomainA > Note 1",
    )
    c2 = RetrievalCandidate(
        path="DomainB/note2.md",
        title="Note 2",
        snippet="Snippet 2",
        vector=[0.0, 1.0, 0.0],
        semantic_score=0.75,
        lexical_score=8.0,
        matched_chunk_index=0,
        tags=["database", "consensus"],
        links=["Core/DistributedSystem.md"], # 2-hop 共同引用
        full_path="DomainB > Note 2",
    )

    current_path = "DomainC/current.md"
    current_links = ["Core/DistributedSystem.md"]
    current_tags = ["database"]

    features = FeatureBuilder.build_features(
        candidates=[c1, c2],
        current_path=current_path,
        current_tags=current_tags,
        current_links=current_links,
    )

    # 验证 2-hop 共同引用被准确识别
    feat2 = features[1]
    assert feat2.shared_links_count == 1
    assert feat2.is_direct_link is False
    assert feat2.is_cross_folder_shared_tag is True

    # 运行 DiscoverRanker
    selected_discover = DiscoverRanker.rank(
        all_features=features,
        related_selected=[],
        current_path=current_path,
        top_k=2,
    )

    # 验证 bridge_score 正向注入并赋予概念桥梁标签
    f2_disc = next(f for f in selected_discover if f.candidate.path == "DomainB/note2.md")
    assert f2_disc.bridge_score > 0.0
    assert any("CONCEPT" in l for l in f2_disc.labels)
