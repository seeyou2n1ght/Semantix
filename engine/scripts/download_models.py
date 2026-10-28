import os
import sys
import argparse
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config.model_config import get_reranker_model, reranker_load_options

# Import Hugging Face consumers only after CLI mirror settings are applied.
def SentenceTransformer(*args, **kwargs):
    from sentence_transformers import SentenceTransformer as Encoder
    return Encoder(*args, **kwargs)


def CrossEncoder(*args, **kwargs):
    from sentence_transformers import CrossEncoder as Encoder
    return Encoder(*args, **kwargs)


# 默认模型
EMBED_MODEL = "BAAI/bge-small-zh-v1.5"


def download_models(token=None, use_mirror=True):
    """
    预下载 Semantix 依赖的 NLP 模型到本地缓存。
    """
    rerank_model = get_reranker_model()
    failures = []
    if use_mirror:
        print(">>> 使用 hf-mirror.com 镜像（--no-mirror 可禁用）...")
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
    
    if token:
        print(">>> 正在使用提供好的 Token 进行 HuggingFace 鉴权...")
        from huggingface_hub import login
        login(token=token)
    else:
        print(">>> 未提供 Token，将尝试匿名下载（部分模型可能受限）...")

    print(f"\n[1/2] 正在拉取向量模型: {EMBED_MODEL}")
    try:
        # SentenceTransformer 会自动处理下载与缓存
        SentenceTransformer(EMBED_MODEL)
        print(f"✅ 向量模型 {EMBED_MODEL} 已就绪。")
    except Exception as e:
        failures.append("embedding")
        print(f"❌ 向量模型下载失败: {e}")

    print(f"\n[2/2] 正在拉取精排模型: {rerank_model}")
    try:
        # CrossEncoder 同理
        CrossEncoder(rerank_model, device="cpu", **reranker_load_options(rerank_model))
        print(f"✅ 精排模型 {rerank_model} 已就绪。")
    except Exception as e:
        failures.append("reranker")
        print(f"❌ 精排模型下载失败: {e}")

    print("\n" + "="*40)
    if failures:
        print("模型预下载未完成: " + ", ".join(failures))
        return False
    print("✨ 所有依赖模型已完成预下载！")
    print("现在您可以正常启动 Semantix 后端或在离线环境下使用了。")
    print("="*40)
    return True

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Semantix 模型预下载助手")
    parser.add_argument("token", nargs="?", help="HuggingFace Read Token (用于访问受限模型)")
    parser.add_argument("--no-mirror", action="store_true", help="禁用 hf-mirror 镜像加速")
    
    args = parser.parse_args()
    
    # 打印欢迎信息
    print("="*40)
    print("   Semantix Offline Model Downloader")
    print("="*40)
    
    sys.exit(0 if download_models(token=args.token, use_mirror=not args.no_mirror) else 1)
