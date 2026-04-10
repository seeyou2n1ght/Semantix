import os
import sys
import argparse
from sentence_transformers import SentenceTransformer, CrossEncoder
from huggingface_hub import login, hf_hub_download

# 默认模型
EMBED_MODEL = "BAAI/bge-small-zh-v1.5"
RERANK_MODEL = "BAAI/bge-reranker-base"

def download_models(token=None, use_mirror=True):
    """
    预下载 Semantix 依赖的 NLP 模型到本地缓存。
    """
    if use_mirror:
        print(">>> 检测到国内环境，启用 hf-mirror.com 镜像加速...")
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
    
    if token:
        print(">>> 正在使用提供好的 Token 进行 HuggingFace 鉴权...")
        login(token=token)
    else:
        print(">>> 未提供 Token，将尝试匿名下载（部分模型可能受限）...")

    print(f"\n[1/2] 正在拉取向量模型: {EMBED_MODEL}")
    try:
        # SentenceTransformer 会自动处理下载与缓存
        SentenceTransformer(EMBED_MODEL)
        print(f"✅ 向量模型 {EMBED_MODEL} 已就绪。")
    except Exception as e:
        print(f"❌ 向量模型下载失败: {e}")

    print(f"\n[2/2] 正在拉取精排模型: {RERANK_MODEL}")
    try:
        # CrossEncoder 同理
        CrossEncoder(RERANK_MODEL)
        print(f"✅ 精排模型 {RERANK_MODEL} 已就绪。")
    except Exception as e:
        print(f"❌ 精排模型下载失败: {e}")

    print("\n" + "="*40)
    print("✨ 所有依赖模型已完成预下载！")
    print("现在您可以正常启动 Semantix 后端或在离线环境下使用了。")
    print("="*40)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Semantix 模型预下载助手")
    parser.add_argument("token", nargs="?", help="HuggingFace Read Token (用于访问受限模型)")
    parser.add_argument("--no-mirror", action="store_true", help="禁用 hf-mirror 镜像加速")
    
    args = parser.parse_args()
    
    # 打印欢迎信息
    print("="*40)
    print("   Semantix Offline Model Downloader")
    print("="*40)
    
    download_models(token=args.token, use_mirror=not args.no_mirror)
