import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from storage.lancedb_storage import LanceDBStorage


def test_failed_stopword_replace_preserves_disk_and_memory(tmp_path, monkeypatch):
    storage = LanceDBStorage(str(tmp_path / "stopwords"))
    storage.set_vault_stopwords("a", ["old"])
    original = (tmp_path / "stopwords" / "custom_stopwords.json").read_bytes()

    def fail_replace(*args):
        raise OSError("controlled replacement failure")

    monkeypatch.setattr("storage.lancedb_storage.os.replace", fail_replace)
    with pytest.raises(OSError, match="controlled"):
        storage.set_vault_stopwords("a", ["new"])
    assert storage.get_vault_stopwords("a") == {"old"}
    assert (tmp_path / "stopwords" / "custom_stopwords.json").read_bytes() == original
    assert not list((tmp_path / "stopwords").glob("*.tmp"))
    storage.close()


def test_concurrent_vault_stopwords_survive_restart(tmp_path):
    path = str(tmp_path / "stopwords")
    storage = LanceDBStorage(path)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(storage.set_vault_stopwords, vault, [vault]) for vault in ["a", "b"]]
        for future in futures:
            future.result()
    assert json.loads((tmp_path / "stopwords" / "custom_stopwords.json").read_text()) == {
        "a": ["a"], "b": ["b"]
    }
    storage.close()
    reopened = LanceDBStorage(path)
    assert reopened.get_vault_stopwords("a") == {"a"}
    assert reopened.get_vault_stopwords("b") == {"b"}
    reopened.close()


def test_stopword_api_propagates_persistence_failure(tmp_path, monkeypatch):
    import main
    from fastapi.testclient import TestClient
    from services.index_service import IndexService

    storage = LanceDBStorage(str(tmp_path / "api"))
    service = IndexService(storage)
    monkeypatch.setattr(main, "index_service", service)

    def fail_save(*args):
        raise OSError("controlled persistence failure")

    monkeypatch.setattr(storage, "_save_custom_stopwords", fail_save)
    response = TestClient(main.app).post("/index/compute-stopwords", json={"vault_id": "a"})
    assert response.status_code == 500
    assert storage.get_vault_stopwords("a") == set()
    storage.close()
