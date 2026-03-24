import re
from typing import List, Tuple


def split_into_chunks(
    text: str, max_child_length: int = 150, min_child_length: int = 20
) -> List[Tuple[str, str, int, str]]:
    """
    Split text into parent paragraphs and child chunks, extracting MD headers.
    Returns:
        List of (parent_text, child_text, parent_index, headers_str) tuples.
    """
    if not text:
        return []

    lines = text.split('\n')
    current_headers = {}
    in_code_block = False
    
    parents = []
    current_parent_lines = []
    
    for line in lines:
        stripped = line.strip()
        
        if stripped.startswith("```"):
            in_code_block = not in_code_block
            current_parent_lines.append(line)
            continue
            
        if not in_code_block and stripped.startswith("#"):
            match = re.match(r"^(#{1,6})\s+(.*)$", stripped)
            if match:
                level = len(match.group(1))
                h_text = match.group(2).strip()
                
                if current_parent_lines:
                    p_text = "\n".join(current_parent_lines).strip()
                    if p_text:
                        active = sorted(current_headers.items())
                        h_str = " > ".join([v for _, v in active[-2:]]) if active else ""
                        parents.append((p_text, h_str))
                    current_parent_lines = []
                
                current_headers[level] = h_text
                keys_to_remove = [k for k in current_headers.keys() if k > level]
                for k in keys_to_remove:
                    del current_headers[k]
                continue

        if not in_code_block and not stripped:
            if current_parent_lines:
                p_text = "\n".join(current_parent_lines).strip()
                if p_text:
                    active = sorted(current_headers.items())
                    h_str = " > ".join([v for _, v in active[-2:]]) if active else ""
                    parents.append((p_text, h_str))
                current_parent_lines = []
        else:
            current_parent_lines.append(line)
            
    if current_parent_lines:
        p_text = "\n".join(current_parent_lines).strip()
        if p_text:
            active = sorted(current_headers.items())
            h_str = " > ".join([v for _, v in active[-2:]]) if active else ""
            parents.append((p_text, h_str))

    results = []
    for para_idx, (p_text, h_str) in enumerate(parents):
        if len(p_text) <= max_child_length:
            if len(p_text) >= min_child_length:
                results.append((p_text, p_text, para_idx, h_str))
        else:
            sentences = re.split(r"([。！？.!?\n])", p_text)
            child = ""
            for i in range(0, len(sentences), 2):
                s = sentences[i]
                punc = sentences[i+1] if i+1 < len(sentences) else ""
                part = s + punc
                
                if len(child) + len(part) <= max_child_length:
                    child += part
                else:
                    if child and len(child.strip()) >= min_child_length:
                        results.append((p_text, child.strip(), para_idx, h_str))
                    child = part
                    
            if child and len(child.strip()) >= min_child_length:
                results.append((p_text, child.strip(), para_idx, h_str))

    return results
