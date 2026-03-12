import re
from typing import List, Tuple


def split_into_paragraphs(text: str) -> List[str]:
    """
    Split text into paragraphs by empty lines.
    Returns list of non-empty paragraphs.
    """
    if not text:
        return []

    paragraphs = re.split(r"\n\s*\n", text.strip())
    return [p.strip() for p in paragraphs if p.strip()]


def split_long_paragraph(paragraph: str, max_length: int = 500) -> List[str]:
    """
    Split a long paragraph into smaller chunks at sentence boundaries.
    """
    if len(paragraph) <= max_length:
        return [paragraph]

    chunks = []
    sentences = re.split(r"([。！？.!?])", paragraph)

    current_chunk = ""
    i = 0
    while i < len(sentences):
        sentence = sentences[i]
        if i + 1 < len(sentences) and re.match(r"[。！？.!?]", sentences[i + 1]):
            sentence += sentences[i + 1]
            i += 1

        if len(current_chunk) + len(sentence) <= max_length:
            current_chunk += sentence
        else:
            if current_chunk:
                chunks.append(current_chunk.strip())
            current_chunk = sentence
        i += 1

    if current_chunk:
        chunks.append(current_chunk.strip())

    return chunks if chunks else [paragraph[:max_length]]


def split_into_chunks(
    text: str, max_chunk_length: int = 500, min_chunk_length: int = 50
) -> List[Tuple[str, int]]:
    """
    Split text into semantic chunks (paragraphs).

    Returns:
        List of (chunk_text, original_paragraph_index) tuples.
    """
    if not text:
        return []

    cleaned = text.strip()
    if not cleaned:
        return []

    paragraphs = split_into_paragraphs(cleaned)
    if not paragraphs:
        return []

    chunks: List[Tuple[str, int]] = []

    for para_idx, para in enumerate(paragraphs):
        if len(para) <= max_chunk_length:
            if len(para) >= min_chunk_length:
                chunks.append((para, para_idx))
        else:
            sub_chunks = split_long_paragraph(para, max_chunk_length)
            for sub_chunk in sub_chunks:
                if len(sub_chunk) >= min_chunk_length:
                    chunks.append((sub_chunk, para_idx))

    return chunks


def split_into_chunks_simple(
    text: str, max_length: int = 500, overlap: int = 50
) -> List[str]:
    """
    Legacy function for backward compatibility.
    Split text into overlapping chunks by length.
    """
    if not text:
        return []

    cleaned = text.strip()
    if not cleaned:
        return []

    if len(cleaned) <= max_length:
        return [cleaned]

    chunks: List[str] = []
    start = 0
    text_len = len(cleaned)

    while start < text_len:
        end = min(text_len, start + max_length)
        if end < text_len:
            soft_start = max(start, end - 80)
            split_at = cleaned.rfind(" ", soft_start, end)
            if split_at > start + 20:
                end = split_at

        chunk = cleaned[start:end].strip()
        if chunk:
            chunks.append(chunk)

        if end >= text_len:
            break

        start = max(0, end - overlap)

    return chunks
