from typing import List


def split_into_chunks(text: str, max_length: int = 500, overlap: int = 50) -> List[str]:
    """
    Split text into overlapping chunks by length.
    The input is cleaned text (paragraph markers may be collapsed),
    so we use a length-based window with a soft whitespace break.
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
            # try to break at whitespace to avoid mid-word cuts
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
