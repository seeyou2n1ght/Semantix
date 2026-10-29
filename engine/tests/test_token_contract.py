"""Token compatibility checks using temporary indexes and mocked embeddings."""
import os
import sys
from unittest.mock import MagicMock

os.environ['SEMANTIX_TESTING'] = '1'
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.index_service import IndexService
from services.lexical import highlight_terms, lexical_evidence_strength, matching_terms, query_terms
from services.retrieval_service import RetrievalService
from storage.lancedb_storage import LanceDBStorage


def _indexed_storage(tmp_path, texts):
    storage = LanceDBStorage(str(tmp_path / 'tokens'), dim=2)
    embedding = MagicMock()
    embedding.encode.side_effect = lambda chunks: [[1.0, 0.0] for _ in chunks]
    index = IndexService(storage, embedding)
    index.upsert_documents([
        {'vault_id': 'a', 'path': f'{number}.md', 'text': text}
        for number, text in enumerate(texts)
    ])
    storage.rebuild_fts_index()
    return storage, index


def test_single_ascii_evidence_is_separate_from_display():
    assert query_terms('C R') == ['c', 'r']
    assert lexical_evidence_strength('C R', ['c', 'r']) == 1.0
    assert lexical_evidence_strength('CR crate', ['c', 'r']) == 0.0
    for text in ['C++', 'C#', 'CR']:
        assert lexical_evidence_strength(text, ['c']) == 0.0
    for text in ['R2', 'CR']:
        assert lexical_evidence_strength(text, ['r']) == 0.0
    assert lexical_evidence_strength('R', ['r']) == 1.0
    assert lexical_evidence_strength('云 山', ['云', '山']) == 0.0
    assert matching_terms('C R 云 山', ['c', 'r', '云', '山']) == []
    assert highlight_terms('C R', 'C R', ['c', 'r']) == []


def test_adaptive_tokens_preserve_query_identities_and_chinese_minimum():
    text = 'C R Go GPT4o Python3 因为 the API 数据库 云'
    tokens = IndexService(None)._extract_tokens(text)
    assert tokens == ['c', 'r', 'go', 'gpt4o', 'python3', 'api', '数据库']
    assert 'gpt' not in tokens and 'python' not in tokens
    # Custom terms still match whole normalized tokens, never prefixes.
    assert query_terms('GPT4o Python3 Go', ['GPT', 'python']) == ['gpt4o', 'python3', 'go']
    assert query_terms('GPT4o Python3 Go', [' GPT4O ', 'PYTHON3', 'go']) == []


def test_real_fts_short_identifier_evidence_and_custom_filter(tmp_path):
    storage, _ = _indexed_storage(tmp_path, ['C', 'R', 'Go GPT4o Python3'])
    service = RetrievalService(storage)
    try:
        for term, path in [('C', '0.md'), ('R', '1.md')]:
            results = service.retrieve_candidates('a', [1.0, 0.0], term)
            hit = next(row for row in results if row.path == path)
            assert hit.lexical_score > 0
            assert hit.lexical_evidence_strength == 1.0
            assert hit.matched_terms == []
            excluded = service.retrieve_candidates('a', [1.0, 0.0], term, custom_stopwords=[term])
            assert all(row.lexical_score == 0 and row.lexical_evidence_strength == 0 for row in excluded)
        assert service.retrieve_candidates('other', [1.0, 0.0], 'C') == []
    finally:
        storage.close()


def test_real_adaptive_frequency_discounts_full_identifiers(tmp_path):
    storage, index = _indexed_storage(tmp_path, ['Go GPT4o Python3', 'Go GPT4o Python3'])
    try:
        details = index.compute_vault_stopword_details('a')
        assert details['words'] == ['go', 'gpt4o', 'python3']
        assert details['total_docs'] == 2 and details['min_doc_freq'] == 2
        service = RetrievalService(storage)
        for term in ['Go', 'GPT4o', 'Python3']:
            enabled = service.retrieve_candidates('a', [1.0, 0.0], term)
            disabled = service.retrieve_candidates('a', [1.0, 0.0], term, enable_adaptive_filtering=False)
            assert all(row.lexical_score > 0 and row.lexical_evidence_strength == 0.5 for row in enabled)
            assert all(row.lexical_evidence_strength == 1.0 for row in disabled)
            assert [(row.path, row.lexical_score, row.rrf_score) for row in enabled] == [
                (row.path, row.lexical_score, row.rrf_score) for row in disabled]
    finally:
        storage.close()


def test_punctuation_identifiers_remain_deferred_with_current_analyzer(tmp_path):
    storage, _ = _indexed_storage(tmp_path, ['C', 'C++', 'C#'])
    try:
        # The existing analyzer conflates these; query support would require
        # an index contract decision and cannot be fixed just in query_terms.
        assert query_terms('C++ C#') == []
        for term in ['C', 'C++', 'C#']:
            rows = storage.table.search(term, query_type='fts').limit(10).to_list()
            assert {row['text'] for row in rows} == {'C', 'C++', 'C#'}
        candidates = RetrievalService(storage).retrieve_candidates('a', [1.0, 0.0], 'C')
        assert {row.snippet: row.lexical_evidence_strength for row in candidates} == {
            'C': 1.0, 'C++': 0.0, 'C#': 0.0}
        assert all(row.lexical_score > 0 and row.matched_terms == [] for row in candidates)
    finally:
        storage.close()
