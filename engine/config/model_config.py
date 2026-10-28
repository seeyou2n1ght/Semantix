"""Shared model identity and inference bounds; embedding/index profile is unchanged."""
import os

DEFAULT_RERANKER_MODEL = "BAAI/bge-reranker-v2-m3"
LEGACY_RERANKER_MODEL = "BAAI/bge-reranker-base"
DEFAULT_RERANKER_REVISION = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"
RERANKER_MAX_LENGTH = 512


def get_reranker_model() -> str:
    model = os.getenv("SEMANTIX_RERANKER_MODEL", DEFAULT_RERANKER_MODEL).strip()
    if model not in {DEFAULT_RERANKER_MODEL, LEGACY_RERANKER_MODEL}:
        raise ValueError("SEMANTIX_RERANKER_MODEL must be BAAI/bge-reranker-v2-m3 or BAAI/bge-reranker-base")
    return model


def reranker_load_options(model: str) -> dict:
    options = {"max_length": RERANKER_MAX_LENGTH, "trust_remote_code": False}
    if model == DEFAULT_RERANKER_MODEL:
        options.update(revision=DEFAULT_RERANKER_REVISION, model_kwargs={"use_safetensors": True})
    return options
