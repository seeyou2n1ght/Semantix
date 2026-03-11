import os
from sentence_transformers import SentenceTransformer
from typing import List

class ModelService:
    def __init__(self, model_name: str = "BAAI/bge-small-zh-v1.5"):
        print(f"Loading embedding model: {model_name}...")
        # device='cpu' is fine for Raspberry Pi
        self.model = SentenceTransformer(model_name)
        self.embedding_dim = self.model.get_sentence_embedding_dimension()
        print(f"Model loaded. Embedding dimension: {self.embedding_dim}")

    def encode(self, texts: List[str]) -> List[List[float]]:
        # For BGE models, we might want to add instructional prefixes for queries, but for MVP keep it simple
        embeddings = self.model.encode(texts, normalize_embeddings=True)
        return embeddings.tolist()

# Singleton instance
model_svc = ModelService()
