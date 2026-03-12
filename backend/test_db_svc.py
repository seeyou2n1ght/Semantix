import sys
from unittest.mock import MagicMock

# Mock missing modules before they are imported by db_svc
mock_lancedb = MagicMock()
sys.modules["lancedb"] = mock_lancedb
mock_pa = MagicMock()
sys.modules["pyarrow"] = mock_pa

import pytest
from db_svc import DatabaseService

@pytest.fixture
def mock_db_service():
    # Reset mock for each test
    mock_lancedb.connect.reset_mock()
    mock_db = MagicMock()
    mock_lancedb.connect.return_value = mock_db
    mock_db.table_names.return_value = []
    # Mock create_table to avoid needing pyarrow schema in simple tests
    mock_db.create_table.return_value = MagicMock()

    service = DatabaseService()
    return service

def test_count_notes_success(mock_db_service):
    # Mock the table to return a specific length
    mock_table = MagicMock()
    mock_table.__len__.return_value = 10
    mock_db_service.table = mock_table

    assert mock_db_service.count_notes() == 10

def test_count_notes_no_table(mock_db_service):
    # Set table to None
    mock_db_service.table = None

    assert mock_db_service.count_notes() == 0

def test_count_notes_exception(mock_db_service):
    # Mock the table to raise an exception when len() is called
    mock_table = MagicMock()
    mock_table.__len__.side_effect = Exception("LanceDB error")
    mock_db_service.table = mock_table

    # It should catch the exception and return 0
    assert mock_db_service.count_notes() == 0
