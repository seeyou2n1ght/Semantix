import requests
import time
import sys

BASE_URL = "http://localhost:8000"
VAULT_ID = "test_vault"

def test_health():
    print("Testing /health...")
    try:
        resp = requests.get(f"{BASE_URL}/health")
        print(f"Status: {resp.status_code}, Body: {resp.json()}")
        return resp.status_code == 200
    except Exception as e:
        print(f"Error: {e}")
        return False

def test_batch_index():
    print("Testing /index/batch...")
    payload = {
        "documents": [
            {
                "vault_id": VAULT_ID,
                "path": "test_note_1.md",
                "text": "这是一篇关于人工智能的笔记。AI 正在改变世界。",
                "tags": ["AI", "Technology"],
                "links": []
            },
            {
                "vault_id": VAULT_ID,
                "path": "test_note_2.md",
                "text": "深度学习是人工智能的一个子集，主要使用神经网络。",
                "tags": ["DeepLearning", "AI"],
                "links": ["test_note_1.md"]
            }
        ]
    }
    resp = requests.post(f"{BASE_URL}/index/batch", json=payload)
    print(f"Status: {resp.status_code}, Body: {resp.json()}")
    return resp.status_code == 200

def test_search():
    print("Testing /search/semantic (Lightweight Mode)...")
    payload = {
        "vault_id": VAULT_ID,
        "text": "什么是人工智能？",
        "top_k": 5,
        "rerank": False
    }
    resp = requests.post(f"{BASE_URL}/search/semantic", json=payload)
    print(f"Status: {resp.status_code}, Body: {resp.json()}")
    results = resp.json().get("results", [])
    if len(results) > 0:
        print(f"First result: {results[0]['path']} (Score: {results[0]['score']})")
    return resp.status_code == 200

if __name__ == "__main__":
    print("Starting backend smoke tests...")
    if not test_health():
        print("Backend not reachable or not healthy. Is it running?")
        sys.exit(1)
        
    if test_batch_index():
        time.sleep(1) # Wait for FTS/Commit
        if test_search():
            print("\n✅ All smoke tests passed!")
        else:
            print("\n❌ Search test failed.")
    else:
        print("\n❌ Indexing test failed.")
