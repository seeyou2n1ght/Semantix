from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import torch

from config import ranking_config
from services.ranking.features import FeatureBuilder
from services.ranking.normalizer import ScoreNormalizer
from services.ranking.related import RelatedRanker
from services.retrieval_service import RetrievalService, RetrievalCandidate
from services.reranker_service import RerankerService
from services.device_service import device_manager
from storage.lancedb_storage import LanceDBStorage


@pytest.mark.parametrize('fail_once', [False, True])
def test_reranker_returns_logits_including_cpu_fallback(monkeypatch, fail_once):
    service = RerankerService()
    calls = []

    def predict(pairs, activation_fn):
        calls.append(pairs)
        if fail_once and len(calls) == 1:
            raise RuntimeError('controlled device failure')
        return activation_fn(torch.tensor([4.0, -10.0])).tolist()

    class Model:
        device = torch.device('cuda' if fail_once else 'cpu')

        def to(self, device):
            self.device = torch.device(device)
            return self

    class Encoder:
        model = Model()

        @property
        def device(self):
            return self.model.device

    service._model = Encoder()
    service._model.predict = predict
    service.active_device = 'cuda' if fail_once else 'cpu'
    monkeypatch.setattr(device_manager, 'mark_fallback', lambda *args: None)
    logits = service.predict_scores('query', ['relevant', 'unrelated'])
    assert logits == [4.0, -10.0]
    assert ScoreNormalizer.normalize_rerank_logit(logits[1]) < 0.001
    assert len(calls) == (2 if fail_once else 1)
    assert service._model.device == torch.device('cpu')


def test_document_refill_and_fts_semantics_on_real_storage(tmp_path):
    storage = LanceDBStorage(str(tmp_path / 'recall'), dim=2)
    rows = []
    for vault in ['a', 'b']:
        for i in range(100):
            rows.append(dict(vault_id=vault, path='long.md', chunk_index=i,
                             vector=[1.0, 0.0], text='docker', parent_text='docker',
                             full_path='long', tags=[], links=[], fts_tokens='docker'))
        rows.append(dict(vault_id=vault, path="other's.md", chunk_index=0,
                         vector=[0.8, 0.6], text='docker quartz', parent_text='docker quartz',
                         full_path='other', tags=[], links=[], fts_tokens='docker quartz'))
    storage.replace_documents(rows, {v: {'long.md', "other's.md"} for v in ['a', 'b']})
    storage.rebuild_fts_index()
    service = RetrievalService(storage)
    recalled = service.retrieve_candidates('a', [1.0, 0.0], 'docker', candidate_limit=2)
    assert {c.path for c in recalled} == {'long.md', "other's.md"}
    assert all(c.hit_count <= 2 * ranking_config.MAX_CHUNKS_PER_DOC_RECALL for c in recalled)
    excluded = service.retrieve_candidates('a', [1.0, 0.0], 'docker',
                                           exclude_paths=["other's.md"], candidate_limit=2)
    assert [c.path for c in excluded] == ['long.md']
    assert service.retrieve_candidates('missing', [1.0, 0.0], 'docker') == []

    # This candidate cannot enter vector recall at 0.95, but FTS returns it.
    recalled = service.retrieve_candidates('a', [1.0, 0.0], 'quartz', min_similarity=0.95)
    lexical = next(c for c in recalled if c.path == "other's.md")
    assert lexical.semantic_score == pytest.approx(0.8)
    assert lexical.lexical_score > 0
    assert lexical in [f.candidate for f in RelatedRanker.rank(FeatureBuilder.build_features(recalled))]


def test_refill_has_a_fixed_work_bound():
    storage = SimpleNamespace(_escape_sql_string=lambda s: s.replace("'", "''"))
    service = RetrievalService(storage)
    filters = []

    def fetch(scoped_filter, limit):
        filters.append(scoped_filter)
        return [{'path': f'long{len(filters)}.md', 'chunk_index': i} for i in range(limit)]

    rows = service._recall_documents(fetch, "vault_id = 'a'", 45)
    assert len(filters) == ranking_config.RECALL_MAX_ROUNDS
    assert all(f.startswith("vault_id = 'a'") for f in filters)
    assert 'long1.md' in filters[1]
    assert len(rows) == ranking_config.RECALL_MAX_ROUNDS * ranking_config.MAX_CHUNKS_PER_DOC_RECALL

    warnings = []
    fetch_partial = MagicMock(side_effect=[
        [{'path': 'valid.md', 'chunk_index': i} for i in range(80)],
        RuntimeError('refill failure'),
    ])
    retained = service._recall_documents(fetch_partial, "vault_id = 'a'", 45, warnings, 'vector')
    assert len(retained) == 2
    assert warnings == ['vector_refill_incomplete']


def test_unscored_candidates_cannot_bypass_reranker(monkeypatch):
    from services.radar_service import RadarPipeline
    import services.radar_service as radar

    candidates = [RetrievalCandidate(f'{i}.md', str(i), 'text', [1., 0.],
                                     0.8, 0., 0, [], [], '') for i in range(25)]
    retrieval = MagicMock()
    retrieval.retrieve_candidates.return_value = candidates
    monkeypatch.setattr(radar.embedding_service, 'encode_query', lambda text: [1., 0.])
    predict = MagicMock(return_value=[-10.] * ranking_config.RERANK_LIMIT_BALANCED)
    monkeypatch.setattr(radar.reranker_service, 'predict_scores', predict)
    pipeline = RadarPipeline(retrieval)
    assert pipeline.execute('a', 'query') == {'related': [], 'discover': [], 'warnings': []}
    predict.assert_called_once()
    predict.reset_mock()
    assert pipeline.execute('a', 'query', ranking_mode='fast')['related']
    predict.assert_not_called()
    predict.return_value = None
    assert pipeline.execute('a', 'query')['related']
    assert pipeline.execute('a', 'query')['warnings'] == ['reranker_unavailable']


def test_channel_failure_is_distinct_from_empty_results():
    def search(query, **kwargs):
        if kwargs.get('query_type') == 'fts':
            raise RuntimeError('controlled FTS failure')
        builder = MagicMock()
        builder.metric.return_value = builder
        builder.limit.return_value = builder
        builder.where.return_value = builder
        builder.to_list.return_value = []
        return builder

    storage = SimpleNamespace(table=SimpleNamespace(search=search),
                              _escape_sql_string=lambda s: s,
                              get_vault_stopwords=lambda v: [])
    service = RetrievalService(storage)
    warnings = []
    assert service.retrieve_candidates('a', [1., 0.], 'docker', warnings=warnings) == []
    assert warnings == ['lexical_unavailable']
    storage.table.search = MagicMock(side_effect=RuntimeError('controlled failure'))
    with pytest.raises(RuntimeError, match='No retrieval channel'):
        service.retrieve_candidates('a', [1., 0.], 'docker')
