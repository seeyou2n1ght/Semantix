"""Behavioral guards; real-model relevance is evaluated separately."""
from types import SimpleNamespace
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.lexical import (highlight_terms, query_terms,
                              lexical_evidence_strength, is_weak_lexical_term)
from services.ranking.features import FeatureBuilder
from services.ranking.related import RelatedRanker
from services.ranking.discover import DiscoverRanker
from services.retrieval_service import RetrievalCandidate, RetrievalService


def candidate(path, semantic, lexical=0, tags=None, links=None):
    return RetrievalCandidate(path, path, 'source passage', [1., 0.], semantic,
                              lexical, 0, tags or [], links or [], path)


def test_diary_degree_words_do_not_drive_lexical_recall_or_highlights():
    query = '小宝退烧了，精神好多了，就是有点粘人。'
    terms = query_terms(query)
    assert '有点' not in terms
    assert {'小宝', '退烧', '精神', '粘人'} <= set(terms)
    assert highlight_terms(query, '小宝今天有点开心，去公园玩了一下午。', terms) == ['小宝']
    assert set(highlight_terms(query, '小宝上次退烧以后精神恢复了，但是特别粘人。', terms)) == {
        '小宝', '退烧', '精神', '粘人'}
    assert highlight_terms(query, '孩子体温恢复正常后仍然想一直被抱着。', terms) == []


def test_weak_modifiers_need_a_complete_shared_expression():
    query = '灵活的架构和高效的数据处理需要可靠的备份策略'
    assert highlight_terms(query, '灵活的安排、高效的工作和可靠的人际关系', query_terms(query)) == []
    for phrase in ['可靠传输', '高效算法', '最终一致性', '高可用']:
        assert phrase in highlight_terms(phrase, phrase, query_terms(phrase))
    for topic in ['幸福', '焦虑']:
        assert topic in highlight_terms(topic, topic, query_terms(topic))
    assert '可靠' in query_terms('可靠的备份策略')


@pytest.mark.parametrize('text', ['工作还算顺利', '工作做', '任务做', '我们可以', '解决问题'])
def test_ordinary_adjacent_words_are_not_promoted_to_highlight_phrases(text):
    highlights = highlight_terms(text, text, query_terms(text))
    assert text not in highlights
    assert not {'工作还', '算顺利', '我们可以', '解决问题'} & set(highlights)


def test_generic_composition_and_content_terms_have_distinct_evidence():
    assert is_weak_lexical_term('解决问题')
    assert not is_weak_lexical_term('操作系统')
    assert not is_weak_lexical_term('一致性')
    assert not is_weak_lexical_term('幸福')
    assert not is_weak_lexical_term('焦虑')
    assert lexical_evidence_strength('解决问题', ['解决问题']) == .25
    assert lexical_evidence_strength('操作系统', ['操作系统']) == 1
    assert lexical_evidence_strength('灵活 可靠', ['灵活', '可靠']) == .25
    assert lexical_evidence_strength('架构', ['架构'], ['架构']) == .5
    assert lexical_evidence_strength('架构 可靠', ['架构', '可靠']) == 1
    assert lexical_evidence_strength('架构', ['架构']) == 1
    assert lexical_evidence_strength('体温恢复正常', ['退烧']) == 0


def test_weak_bm25_credit_is_capped_after_batch_normalization():
    weak = candidate('weak.md', .35, lexical=100)
    weak.lexical_evidence_strength = .25
    weak.matched_terms = ['arbitrary display term']
    single = FeatureBuilder.build_features([weak])[0]
    assert single.lexical_norm == .25
    assert RelatedRanker.rank([single]) == []
    topical = candidate('topic.md', .35, lexical=80)
    topical.lexical_evidence_strength = 1
    features = FeatureBuilder.build_features([weak, topical])
    # A discounted BM25 maximum must not suppress informative lexical evidence.
    assert [f.lexical_norm for f in features] == [.25, 1.]
    assert [f.candidate.path for f in RelatedRanker.rank(features)] == ['topic.md']
    weak.matched_terms = []
    assert FeatureBuilder.build_features([weak])[0].lexical_norm == .25


def test_title_only_evidence_and_parent_context_remain_separate(tmp_path):
    from unittest.mock import MagicMock
    from services.index_service import IndexService
    from storage.lancedb_storage import LanceDBStorage

    storage = LanceDBStorage(str(tmp_path / 'support'))
    embedding = MagicMock()
    embedding.encode.side_effect = lambda chunks: [[1.] + [0.] * (storage.dim - 1) for _ in chunks]
    IndexService(storage, embedding).upsert_documents([
        {'vault_id': 'a', 'path': 'QuokkaGateway.md', 'text': 'A body about transport.'},
        {'vault_id': 'a', 'path': 'generic.md', 'text': '灵活 高效 可靠 解决问题'},
        {'vault_id': 'a', 'path': 'topic.md', 'text': '架构设计 备份策略 操作系统'},
    ])
    storage.rebuild_fts_index()
    service = RetrievalService(storage)
    vector = [1.] + [0.] * (storage.dim - 1)
    title = next(c for c in service.retrieve_candidates('a', vector, 'QuokkaGateway')
                 if c.path == 'QuokkaGateway.md')
    assert title.lexical_score > 0
    assert title.lexical_evidence_strength == 1
    assert title.matched_terms == []
    results = {c.path: c for c in service.retrieve_candidates(
        'a', vector, '灵活 高效 可靠 解决问题 架构设计 备份策略 操作系统')}
    assert results['generic.md'].lexical_score > 0
    assert results['generic.md'].lexical_evidence_strength == .25
    assert results['topic.md'].lexical_score > 0
    assert results['topic.md'].lexical_evidence_strength == 1

    # Expanded context can explain a card but cannot supply BM25 support
    # to a different child passage.
    row = dict(path='架构设计/parent.md', text='可靠', parent_text='架构设计 可靠',
               full_path='架构设计 > parent', chunk_index=0, vector=vector, _score=5,
               fts_tokens=storage.tokenize_for_fts('parent 可靠'))
    selected = service._fuse_and_aggregate([], [row], query_vector=vector)[0]
    assert '架构设计' in selected.snippet
    assert lexical_evidence_strength(
        selected.lexical_source, query_terms('架构设计 可靠')) == .25
    assert lexical_evidence_strength(selected.lexical_source, ['架构设计']) == 0


def test_semantic_paraphrase_survives_without_lexical_overlap():
    features = FeatureBuilder.build_features([candidate('paraphrase.md', .7)], rerank_scores=[3.])
    assert [f.candidate.path for f in RelatedRanker.rank(features)] == ['paraphrase.md']
    assert features[0].candidate.matched_terms == []


def test_explicit_link_keeps_its_lower_composite_threshold():
    features = FeatureBuilder.build_features([candidate('linked.md', .3)],
                                             current_path='current.md', current_links=['linked.md'])
    assert [f.candidate.path for f in RelatedRanker.rank(features)] == ['linked.md']


def test_aggregated_scores_describe_the_visible_evidence_not_other_chunks():
    def row(index, text, distance):
        return dict(path='daily.md', chunk_index=index, text=text, parent_text=text,
                    vector=[1., 0.], _distance=distance, full_path=f'daily > {index}')

    semantic_only = row(0, 'different semantic passage', .01)
    shared = row(1, 'visible passage in both channels', .4)
    lexical_only = row(2, 'unrelated lexical passage', .8)
    service = RetrievalService(SimpleNamespace())
    result = service._fuse_and_aggregate(
        [semantic_only, shared], [{**lexical_only, '_score': 100}, {**shared, '_score': 2}])
    assert len(result) == 1
    actual = result[0]
    assert actual.snippet == actual.source_text == semantic_only['text']
    assert actual.matched_chunk_index == 0
    assert actual.semantic_score == pytest.approx(.99)
    assert actual.lexical_score == 0
    assert actual.hit_count == 3



def test_fts_only_exact_term_retains_its_own_evidence():
    service = RetrievalService(SimpleNamespace())
    rows = [dict(path='api.md', chunk_index=3, text='QuokkaGateway API endpoint',
                 parent_text='QuokkaGateway API endpoint', vector=[.8, .6], _score=9.)]
    result = service._fuse_and_aggregate([], rows, query_vector=[1., 0.])
    assert len(result) == 1
    assert result[0].source_text == 'QuokkaGateway API endpoint'
    assert result[0].semantic_score == pytest.approx(.8)
    assert result[0].lexical_score == 9.
    assert result[0].matched_chunk_index == 3
