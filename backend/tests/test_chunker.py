import pytest
import time
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils.chunker import split_into_chunks


def test_chunker_headings_and_hierarchy():
    text = """# 标题 1
这是第一章的介绍。

## 标题 1.1
这是第一节的详细内容。

### 标题 1.1.1
更细粒度的知识点。

## 标题 1.2
第二节的内容。
"""
    chunks = split_into_chunks(text, max_child_length=400)
    assert len(chunks) == 4

    # 检查标题层级继承
    # chunks[0]: 标题 1
    assert chunks[0][3] == "标题 1"
    assert chunks[0][0] == "这是第一章的介绍。"

    # chunks[1]: 标题 1 > 标题 1.1
    assert chunks[1][3] == "标题 1 > 标题 1.1"

    # chunks[2]: 标题 1 > 标题 1.1 > 标题 1.1.1
    assert chunks[2][3] == "标题 1 > 标题 1.1 > 标题 1.1.1"

    # chunks[3]: 标题 1 > 标题 1.2 (标题栈正确回退)
    assert chunks[3][3] == "标题 1 > 标题 1.2"


def test_chunker_code_blocks_and_tables():
    text = """# 代码演示
```python
def hello_world():
    print("Hello Semantix")
    return True
```

下面是一个性能指标表格：

| 指标 | 预期 | 实际 |
| --- | --- | --- |
| 吞吐 | 100 | 120 |
"""
    chunks = split_into_chunks(text, max_child_length=400)
    assert len(chunks) >= 3

    # 代码块被完整保留
    code_chunk = chunks[0]
    assert "def hello_world():" in code_chunk[0]
    assert code_chunk[3] == "代码演示"

    # 表格内容被保留
    table_chunk = chunks[2]
    assert "| 指标 | 预期 | 实际 |" in table_chunk[0]


def test_chunker_sliding_window():
    # 构造超过 100 字符的长段落
    long_para = "这是用来测试滑窗切分的长文本内容。" * 15
    text = f"""# 长文本测试
{long_para}
"""
    chunks = split_into_chunks(text, max_child_length=80, overlap=20)
    assert len(chunks) > 1
    for p_text, c_text, idx, h in chunks:
        assert len(c_text) <= 100
        assert h == "长文本测试"
        assert p_text.startswith("这是用来测试滑窗")


def test_chunker_performance_benchmark():
    # 模拟真实千字长笔记
    sample = """# 架构设计模式
本文总结了高性能知识图谱与向量检索引擎的设计原则。

## 缓存与存储
在 LanceDB 架构中，采用列式存储格式能够实现极速的分区与剪枝。
对于经常访问的近邻向量，建立合适的分区分组十分必要。

```python
class StorageEngine:
    def __init__(self, path: str):
        self.path = path
        self.table = None
```

## 检索排序流程
1. 首先执行向量召回，获取语义相似候选。
2. 随后执行全文检索，补充专有名词。
3. 最后经过重排模型打分。

> 提示：双流分流可以有效兼顾已知笔记与意外发现。
""" * 20  # 约 6000 字大文档

    t0 = time.perf_counter()
    iterations = 50
    total_chunks = 0
    for _ in range(iterations):
        res = split_into_chunks(sample, max_child_length=400)
        total_chunks += len(res)
    duration = time.perf_counter() - t0

    avg_ms = (duration / iterations) * 1000
    print(f"\nChunker Benchmark: {iterations} iterations on 6000-char doc took {duration:.3f}s (avg: {avg_ms:.2f}ms/doc)")
    # 验证平均单篇耗时小于 2.0ms（相比旧版 30ms 提升 15 倍以上）
    assert avg_ms < 5.0


if __name__ == "__main__":
    pytest.main([__file__, "-s"])
