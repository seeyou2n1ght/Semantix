import os
import sys
from types import SimpleNamespace

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.index_service import IndexService
from storage.lancedb_storage import LanceDBStorage


def _rows(storage, vault_id):
    return storage.table.search().where(f"vault_id = '{vault_id}'").limit(None).to_list()


def _snapshot(storage):
    return sorted(
        (row["vault_id"], row["path"], row["chunk_index"], row["text"],
         row["parent_text"], tuple(row["vector"]), row["fts_tokens"])
        for row in storage.table.search().limit(None).to_list()
    )


def test_long_heading_only_note_keeps_middle_and_tail_in_bounded_chunks(tmp_path):
    storage = LanceDBStorage(str(tmp_path / "heading"), dim=2)
    encoded = []

    def encode(chunks):
        encoded.extend(chunks)
        return [[1.0, 0.0] for _ in chunks]

    service = IndexService(storage, SimpleNamespace(encode=encode))
    text = "# headtoken " + "a" * 500 + " middletoken " + "b" * 500 + " tailtoken "
    result = service.upsert_documents([{"vault_id": "v", "path": "heading.md", "text": text}])

    assert result == {"indexed_chunks": len(encoded), "success_docs": 1, "failed_docs": []}
    assert len(encoded) > 1
    assert all(len(chunk) <= 400 + len("[heading]\n") for chunk in encoded)
    rows = sorted(_rows(storage, "v"), key=lambda row: row["chunk_index"])
    assert [row["chunk_index"] for row in rows] == list(range(len(encoded)))
    for token in ("headtoken", "middletoken", "tailtoken"):
        assert any(token in row["text"] for row in rows)
    storage.rebuild_fts_index()
    assert any(row["path"] == "heading.md" for row in
               storage.table.search("tailtoken", query_type="fts").where("vault_id = 'v'").to_list())

    def fail(_chunks):
        raise RuntimeError("controlled embedding failure")

    before = _snapshot(storage)
    failed = IndexService(storage, SimpleNamespace(encode=fail)).upsert_documents([
        {"vault_id": "v", "path": "heading.md", "text": "# replacement"}
    ])
    assert failed["failed_docs"] == ["heading.md"]
    assert _snapshot(storage) == before
    storage.close()


def test_normal_body_chunking_is_unchanged(tmp_path):
    storage = LanceDBStorage(str(tmp_path / "normal"), dim=2)
    encoded = []

    def encode(chunks):
        encoded.extend(chunks)
        return [[1.0, 0.0] for _ in chunks]

    result = IndexService(storage, SimpleNamespace(encode=encode)).upsert_documents([
        {"vault_id": "v", "path": "normal.md", "text": "# Title\nOrdinary body content."}
    ])
    assert result["indexed_chunks"] == 1
    assert encoded == ["[normal] [Title]\nOrdinary body content."]
    assert _rows(storage, "v")[0]["text"] == "Ordinary body content."
    storage.close()


def test_maintenance_keeps_rows_fts_vectors_and_recent_snapshot(tmp_path):
    storage = LanceDBStorage(str(tmp_path / "maintenance"), dim=2)
    service = IndexService(storage, SimpleNamespace(encode=lambda chunks: [[1.0, 0.0] for _ in chunks]))
    service.upsert_documents([
        {"vault_id": "a", "path": "same.md", "text": "oldvalue"},
        {"vault_id": "b", "path": "same.md", "text": "nebula"},
    ])
    old_version = storage.table.version
    service.upsert_documents([
        {"vault_id": "a", "path": "same.md", "text": "quartz"},
    ])
    storage.rebuild_fts_index()
    before = _snapshot(storage)
    fts_before = storage.table.search("quartz", query_type="fts").where("vault_id = 'a'").to_list()
    vector_before = storage.table.search([1.0, 0.0]).where("vault_id = 'b'").to_list()
    assert len(fts_before) == len(vector_before) == 1

    storage.optimize_database(retention_days=1)

    assert _snapshot(storage) == before
    assert len(storage.table.search("quartz", query_type="fts").where("vault_id = 'a'").to_list()) == 1
    assert len(storage.table.search([1.0, 0.0]).where("vault_id = 'b'").to_list()) == 1
    storage.table.checkout(old_version)
    assert {row["text"] for row in _rows(storage, "a")} == {"oldvalue"}
    assert {row["text"] for row in _rows(storage, "b")} == {"nebula"}
    storage.close()
