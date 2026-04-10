import markdown
from bs4 import BeautifulSoup
import re
from typing import List, Tuple

def split_into_chunks(
    text: str, max_child_length: int = 400, overlap: int = 50, min_child_length: int = 20
) -> List[Tuple[str, str, int, str]]:
    """
    Split text into parent paragraphs and child chunks using Markdown AST.
    Returns:
        List of (parent_text, child_text, parent_index, headers_str) tuples.
    """
    if not text:
        return []

    # 1. 使用 Markdown 解析器转化为 HTML (保留结构)
    # 增加 extensions=['extra'] 以支持代码块等 GFM 语法
    html = markdown.markdown(text, extensions=['extra'])
    soup = BeautifulSoup(html, 'html.parser')

    results = []
    current_headers = []
    parent_idx = 0

    # 2. 遍历结构化元素
    # 我们关注标题、段落、列表项和预格式化代码块
    for el in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'pre']):
        if el.name.startswith('h'):
            level = int(el.name[1])
            # 更新标题栈：移除层级大于等于当前级别的旧标题
            current_headers = current_headers[:level-1]
            current_headers.append(el.get_text().strip())
            continue
        
        # 提取原始内容文本
        parent_text = el.get_text().strip()
        if len(parent_text) < min_child_length:
            continue
            
        header_str = " > ".join(current_headers)
        
        # 3. 对长段落执行带重叠的滑动窗口切分 (Child Chunks)
        if len(parent_text) <= max_child_length:
            results.append((parent_text, parent_text, parent_idx, header_str))
        else:
            chunks = _sliding_window_split(parent_text, max_child_length, overlap)
            for child_text in chunks:
                if len(child_text) >= min_child_length:
                    results.append((parent_text, child_text, parent_idx, header_str))
        
        parent_idx += 1

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
            for punc in ['。', '！', '？', '.', '!', '?', '\n']:
                pos = chunk.rfind(punc)
                if pos > last_punc:
                    last_punc = pos
            
            # 如果在后 20% 的范围内找到了标点，则在该处截断
            if last_punc > (max_len * 0.8):
                end = start + last_punc + 1
                chunk = text[start:end]
        
        chunks.append(chunk.strip())
        start = end - overlap
        
        # 防止死循环（如果 overlap >= max_len）
        if overlap >= max_len:
            start = end
            
    return chunks
