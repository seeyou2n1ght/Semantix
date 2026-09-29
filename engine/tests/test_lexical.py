import os
import sys
from unittest.mock import MagicMock

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.lexical import query_terms, matching_terms, highlight_terms
from services.index_service import IndexService
from services.retrieval_service import RetrievalService
from storage.lancedb_storage import LanceDBStorage


def test_noise_and_token_boundaries():
    assert query_terms('因为 所以 the AND 123 !!!') == []
    assert query_terms('API api 量子纠缠', [' API ']) == ['量子', '纠缠']
    assert matching_terms('partial ART artful 量子纠缠', ['art', '量子', '不存在']) == ['art', '量子']
    assert matching_terms('API知识图谱', ['api', '知识', '图谱']) == ['api', '知识', '图谱']
    assert matching_terms('知识图谱', ['知识', '图谱']) == ['知识', '图谱']
    assert highlight_terms('树莓派内网穿透与阿里云', '树莓派连接阿里云进行内网穿透',
                           query_terms('树莓派内网穿透与阿里云')) == ['树莓派', '阿里云', '内网', '穿透']
    assert highlight_terms('我觉得这个问题需要通过一些方法来解决',
                           '这个问题需要一些方法来解决',
                           query_terms('我觉得这个问题需要通过一些方法来解决')) == []
    assert highlight_terms('数据库检索', '数据库支持检索',
                           query_terms('数据库检索')) == ['数据库', '检索']


def test_request_filters_and_card_evidence(tmp_path, monkeypatch):
    """Real FTS + deterministic vectors: settings do not mutate shared state."""
    storage = LanceDBStorage(str(tmp_path / 'lexical'))
    embedding = MagicMock()
    embedding.encode.side_effect = lambda chunks: [[0.1] * storage.dim for _ in chunks]
    IndexService(storage, embedding).upsert_documents([
        {'vault_id': vault, 'path': 'QuartzPlanet.md', 'text': '因为 QuartzPlanet ART partial 知识图谱'}
        for vault in ['a', 'b']
    ])
    storage.rebuild_fts_index()
    storage.set_vault_stopwords('a', ['quartzplanet'])
    service = RetrievalService(storage)
    search = MagicMock(wraps=storage.table.search)
    monkeypatch.setattr(storage.table, 'search', search)

    def retrieve(vault='a', text='因为 QuartzPlanet', **kwargs):
        return service.retrieve_candidates(vault, [0.1] * storage.dim, text, **kwargs)

    filtered = retrieve()
    assert len(filtered) == 1
    assert filtered[0].lexical_score == 0
    assert filtered[0].matched_terms == []
    assert all(call.kwargs.get('query_type') != 'fts' for call in search.call_args_list)
    enabled = retrieve(enable_adaptive_filtering=False)
    assert enabled[0].lexical_score > 0
    assert enabled[0].matched_terms == ['quartzplanet']
    custom = retrieve(enable_adaptive_filtering=False, custom_stopwords=['QUARTZPLANET'])
    assert custom[0].lexical_score == 0
    assert custom[0].matched_terms == []
    other_vault = retrieve('b')
    assert len(other_vault) == 1
    assert other_vault[0].lexical_score > 0
    assert storage.get_vault_stopwords('a') == {'quartzplanet'}
    assert storage.get_vault_stopwords('b') == set()


def test_api_passes_filters_and_returns_evidence(monkeypatch):
    from fastapi.testclient import TestClient
    import main
    from services.radar_service import RadarPipeline
    from services.retrieval_service import RetrievalCandidate
    import services.radar_service as radar

    candidate = RetrievalCandidate('a.md', 'A', 'API', [1.0], 0.99, 1.0,
                                   0, [], [], 'a.md', matched_terms=['api'])
    retrieval = MagicMock()
    retrieval.retrieve_candidates.return_value = [candidate]
    monkeypatch.setattr(main, 'radar_pipeline', RadarPipeline(retrieval))
    encode = MagicMock(return_value=[1.0])
    monkeypatch.setattr(radar.embedding_service, 'encode_query', encode)
    response = TestClient(main.app).post('/search/radar', json={
        'vault_id': 'a', 'context_id': 'ctx', 'context': {'text': '因为 API'},
        'ranking_mode': 'fast', 'enable_adaptive_filtering': False,
        'custom_stopwords': ['example']
    })
    assert response.status_code == 200
    assert response.json()['context_id'] == 'ctx'
    assert response.json()['related'][0]['matched_terms'] == ['api']
    kwargs = retrieval.retrieve_candidates.call_args.kwargs
    assert kwargs['enable_adaptive_filtering'] is False
    assert kwargs['custom_stopwords'] == ['example']
    assert kwargs['query_text'] == '因为 API'
    encode.assert_called_once_with('因为 API')
