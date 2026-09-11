import re
from typing import List, Tuple


def split_into_chunks(
    text: str, max_child_length: int = 400, overlap: int = 50, min_child_length: int = 20
) -> List[Tuple[str, str, int, str]]:
    """
    基于流式行级状态机切分 Markdown 文本，提取各级结构与正文段落。
    完全摆脱外部 HTML/DOM 解析器，性能大幅提升并完整覆盖引用块与表格。

    Returns:
        List of (parent_text, child_text, parent_index, headers_str) tuples.
    """
    if not text:
        return []
    if max_child_length <= 0 or not 0 <= overlap < max_child_length:
        raise ValueError("Chunk length must be positive and overlap smaller than chunk length")

    lines = text.splitlines()
    results: List[Tuple[str, str, int, str]] = []
    current_headers: List[str] = []
    parent_idx = 0

    buffer: List[str] = []
    in_code_block = False

    def flush_buffer():
        nonlocal parent_idx
        if not buffer:
            return
        parent_text = "\n".join(buffer).strip()
        buffer.clear()
        if not parent_text:
            return

        header_str = " > ".join(current_headers)
        if len(parent_text) <= max_child_length:
            results.append((parent_text, parent_text, parent_idx, header_str))
        else:
            chunks = _sliding_window_split(parent_text, max_child_length, overlap)
            for child_text in chunks:
                if child_text:
                    results.append((parent_text, child_text, parent_idx, header_str))
        parent_idx += 1

    heading_pattern = re.compile(r"^(#{1,6})\s+(.+)$")

    for line in lines:
        stripped = line.strip()

        # 代码块边界检测
        if stripped.startswith("```"):
            buffer.append(line)
            if in_code_block:
                in_code_block = False
                flush_buffer()
            else:
                in_code_block = True
            continue

        if in_code_block:
            buffer.append(line)
            continue

        # 标题行匹配
        h_match = heading_pattern.match(stripped)
        if h_match:
            flush_buffer()
            level = len(h_match.group(1))
            heading_title = h_match.group(2).strip()
            # 维护标题栈：只保留小于当前层级的祖先标题
            current_headers = current_headers[:level - 1]
            current_headers.append(heading_title)
            continue

        # 空行视为自然段落分界
        if not stripped:
            flush_buffer()
            continue

        buffer.append(line)

    flush_buffer()
    return results


def _sliding_window_split(text: str, max_len: int, overlap: int) -> List[str]:
    """带有重叠度的文本切分助手"""
    if not text:
        return []

    chunks = []
    start = 0
    text_len = len(text)

    while start < text_len:
        end = start + max_len
        chunk = text[start:end]

        # 尝试在句末符号处截断，避免截断语义
        if end < text_len:
            # 查找最后一个句号、感叹号或换行符
            last_punc = -1
            for punc in ["。", "！", "？", ".", "!", "?", "\n"]:
                pos = chunk.rfind(punc)
                if pos > last_punc:
                    last_punc = pos

            # 如果在后 20% 的范围内找到了标点，则在该处截断
            if last_punc > (max_len * 0.8):
                end = start + last_punc + 1
                chunk = text[start:end]

        chunks.append(chunk.strip())
        if end >= text_len:
            break
        start = end - overlap

        # 防止死循环（如果 overlap >= max_len）
        if overlap >= max_len:
            start = end

    return chunks
