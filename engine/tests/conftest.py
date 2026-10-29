import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Ensure pytest runs in deterministic testing mode
os.environ["SEMANTIX_TESTING"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"

# Isolate all application imports from real/default DB before test collection imports.
_SESSION_DB_DIR = tempfile.TemporaryDirectory(prefix="semantix_test_db_")
os.environ["SEMANTIX_DB_PATH"] = _SESSION_DB_DIR.name


def pytest_sessionfinish(session, exitstatus):
    """Release the shared application storage before removing its test database."""
    database_service = sys.modules.get("services.database_service")
    if database_service is not None:
        database_service.storage.close()
    _SESSION_DB_DIR.cleanup()
