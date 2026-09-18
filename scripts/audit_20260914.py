"""Read-only audit probes; assertions reproduce current defects, not acceptance gates.

Run: uv run --project engine python scripts/audit_20260914.py
Models are stubbed, and every database write uses a fresh temporary directory.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
sys.modules["sentence_transformers"] = MagicMock()

from services.retrieval_service import RetrievalService, RetrievalCandidate
from services.ranking.features import FeatureBuilder
from services.ranking.normalizer import ScoreNormalizer
from services.reranker_service import RerankerService
from storage.lancedb_storage import LanceDBStorage
from utils.chunker import split_into_chunks

results = {}
svc = RetrievalService(MagicMock(), MagicMock())
row = {"path": "A.md", "chunk_index": 0, "text": "alpha", "vector": [1., 0.]}
candidate = svc._fuse_and_aggregate([{**row, "_distance": .2}], [{**row, "_score": 12.}])[0]
assert candidate.lexical_score == 12.0
results["same_chunk_bm25_preserved"] = candidate.lexical_score

vectors = [{**row, "chunk_index": i, "text": f"chunk-{i}", "_distance": .2} for i in range(3)]
candidate = svc._fuse_and_aggregate(vectors, [{**vectors[2], "_score": 12.}])[0]
assert candidate.matched_chunk_index == 2
results["strongest_chunk_is_2_selected"] = candidate.matched_chunk_index

reranker = RerankerService()
reranker._loading = True
scores = reranker.predict_scores("q", ["d"])
assert scores is None
results["unavailable_reranker_returns_none"] = True

candidate = RetrievalCandidate("B/shared.md", "shared", "text", [1., 0.], .8, 0., 0, ["ai"], [], "")
feature = FeatureBuilder.build_features([candidate], current_path="current.md", current_tags=["#ai"], current_links=["A/shared.md"])[0]
assert feature.tag_overlap == 1 and not feature.is_direct_link
results["tag_and_resolved_link_correct"] = {"tag_overlap": feature.tag_overlap, "is_direct_link": feature.is_direct_link}

chunks = split_into_chunks("# root\n### first\none\n### second\ntwo")
assert chunks[-1][3] == "root > second"
results["skipped_heading_level_correct_ancestry"] = chunks[-1][3]

svc.storage.table.search.side_effect = RuntimeError("controlled storage failure")
assert svc.retrieve_candidates("v", [1., 0.], "query") == []
results["both_recall_paths_fail_gracefully"] = True

with tempfile.TemporaryDirectory(prefix="semantix-audit-") as directory:
    storage = LanceDBStorage(str(Path(directory) / "probe"), dim=2)
    def data(vault, index, text):
        return {"vault_id": vault, "path": "a.md", "chunk_index": index,
                "vector": [1., 0.], "text": text, "parent_text": text,
                "full_path": "a", "tags": [], "links": []}
    storage.replace_documents([data("a", 0, "old"), data("a", 1, "old-tail"), data("b", 0, "other")], {"a": {"a.md"}, "b": {"a.md"}})
    storage.replace_documents([data("a", 0, "new")], {"a": {"a.md"}})
    assert storage.table.count_rows() == 2 and storage.count_notes("b") == 1
    try:
        storage.replace_documents([{**data("a", 0, "bad"), "vector": [1., 2., 3.]}], {"a": {"a.md"}})
    except Exception:
        pass
    assert storage.table.search().where("vault_id = 'a'").to_list()[0]["text"] == "new"
    storage.replace_documents([], {"a": {"a.md"}})
    assert storage.count_notes("a") == 0 and storage.count_notes("b") == 1
    results["real_storage_shrink_bad_input_empty_and_isolation"] = "passed; no injected mid-commit/crash test"
    storage.replace_documents([data("a", 0, "数据库系统设计与事务处理")], {"a": {"a.md"}})
    storage.rebuild_fts_index()
    results["chinese_fts_substring_hits"] = len(storage.table.search(storage.prepare_fts_query("数据库"), query_type="fts").where("vault_id = 'a'").to_list())
    results["chinese_fts_whole_string_hits"] = len(storage.table.search(storage.prepare_fts_query("数据库系统设计与事务处理"), query_type="fts").where("vault_id = 'a'").to_list())
    assert results["chinese_fts_substring_hits"] >= 1
    assert results["chinese_fts_whole_string_hits"] >= 1
    storage.close()

    os.environ["SEMANTIX_DB_PATH"] = str(Path(directory) / "api")
    import main
    from fastapi.testclient import TestClient
    main.API_TOKEN = None
    client = TestClient(main.app)  # No lifespan: no watchdog or maintenance threads.
    clear_vault = MagicMock()
    main.db_svc.clear_vault = clear_vault
    resp_unscoped = client.post("/index/clear/request")
    assert resp_unscoped.status_code == 400
    requested = client.post("/index/clear/request?vault_id=audit-vault").json()
    response = client.post("/index/clear/confirm", json={"confirmation_token": requested["confirmation_token"], "vault_id": "audit-vault"})
    assert response.status_code == 200 and clear_vault.call_count == 1
    results["unscoped_clear_rejected_and_scoped_cleared"] = True
    main.db_svc.close()

print(json.dumps(results, ensure_ascii=False, indent=2))
