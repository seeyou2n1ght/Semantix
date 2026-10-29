"""Request-scoped lexical filtering shared by recall and snippet evidence."""
import re
from functools import lru_cache
from typing import Iterable, List

import jieba
import jieba.posseg

from config import ranking_config


# Function words only: domain vocabulary remains eligible for recall.
BASE_STOPWORDS = frozenset("""
的 了 在 是 和 与 或 也 都 就 不 有 这 那 我 你 他 她 它 们 个 上 下 中 来 去 到 说 要 会 能 对 着 过 从 把 给 向 而 但 如 所 以
为 于 之 其 者 等 时 地 得 啊 吗 呢 吧 呀 哦 哈 嗯 哎 唉 且 并 若 况 非 莫 既 怎么 如何 什么 为什么 哪里 什么时候 这样 那样 哪个 哪些
觉得 认为 就是 其实 大概 可能 虽然 但是 如果 由于 因此 所以 因为 既然 以此 不仅 而且 此外 或者 否则 还是 甚至 以及 至于 关于 对于 所谓 比如
例如 总之 最后 首先 其次 已经 曾经 正在 即将 刚刚 一直 总是 经常 偶尔 非常 相当 及其 更加 比较 稍微 几乎 所有 整个 一切 各种 各个 部分 一些
一点 有点 有点儿 有些 好多 若干 很多 只有 只要 无论 不管 即使
a an the and or but if then else as at by for from in into of on to with
is are was were be been being do does did have has had this that these those
it its i me my we our you your he she they them their not no so very also
""".split())

# Display-only: these words can still contribute to lexical recall. In a
# snippet, highlighting them usually explains little about the relationship.
LOW_VALUE_HIGHLIGHTS = frozenset("""
需要 通过 问题 方法 使用 进行 解决 作为 一种 我们 这个 不是 没有 时候 其他 之后 然后
""".split())

# These modifiers explain little on their own, but remain valid recall terms
# and can be useful in a complete shared expression (e.g. 可靠传输).
WEAK_STANDALONE_MODIFIERS = frozenset("""
灵活 高效 可靠 重要 简单 复杂 良好 明显 有效 最终
""".split())

# Ranking policy is independent of which terms the UI chooses to display.
WEAK_LEXICAL_TERMS = frozenset("""
需要 通过 问题 方法 使用 进行 解决 作为 一种 我们 这个 不是 没有 时候 其他 之后 然后
灵活 高效 可靠 重要 简单 复杂 良好 明显 有效 最终
""".split())

# Established compounds whose dictionary POS is ambiguous (派=v, 高=a).
# This bounded glossary preserves existing technical examples; it is not a
# general rule that arbitrary adjacent Chinese tokens form a meaningful term.
DOMAIN_COMPOUNDS = frozenset({'树莓派', '高可用'})


@lru_cache(maxsize=4096)
def _term_flag(term: str) -> str:
    parts = list(jieba.posseg.cut(term))
    return parts[0].flag if len(parts) == 1 else ''


def _basic_weak_term(term: str) -> bool:
    flag = _term_flag(term)
    return (term in BASE_STOPWORDS | WEAK_LEXICAL_TERMS
            or flag in {'d', 'ad', 'p', 'c', 'e', 'y', 'o'}
            or flag.startswith(('r', 'm', 'q', 'u')))


def is_weak_lexical_term(term: str) -> bool:
    if _basic_weak_term(term):
        return True
    # Jieba can emit a whole generic expression as a noun (解决问题).
    # Require every proper component to be weak; never remove substrings from
    # an informative word such as 操作系统.
    components = {part for part in jieba.cut_for_search(term)
                  if part != term and len(part) >= 2}
    if not components or not all(_basic_weak_term(part) for part in components):
        return False
    # A proper substring alone does not establish the meaning of the whole
    # term (一致 is tagged ad, but does not cover the noun 一致性).
    covered = {0}
    for start in range(len(term)):
        if start in covered:
            covered.update(start + len(part) for part in components
                           if term.startswith(part, start))
    return len(term) in covered


def lexical_evidence_strength(text: str, terms: Iterable[str],
                              frequent_terms: Iterable[str] = ()) -> float:
    """Qualify final lexical credit without changing BM25 recall or its score."""
    matches = matching_terms(text, terms, include_single_ascii=True)
    if not matches:
        return 0.0
    frequent = {term.strip().lower() for term in frequent_terms}
    strengths = [ranking_config.LEXICAL_WEAK_TERM_STRENGTH
                 if is_weak_lexical_term(term)
                 else ranking_config.LEXICAL_FREQUENT_TERM_STRENGTH
                 if term in frequent else 1.0 for term in matches]
    # Additional weak overlaps must not reduce already informative evidence.
    # One informative overlap is enough for ordinary BM25 credit; this is an
    # evidence cap, not a calibrated measure of whole-note relevance.
    return max(strengths)


def query_terms(text: str, stopwords: Iterable[str] = ()) -> List[str]:
    stops = BASE_STOPWORDS | {word.strip().lower() for word in stopwords}
    terms = []
    seen = set()
    for part in jieba.cut(text):
        token = part.strip().lower()
        if not token or token in stops or token in seen:
            continue
        if not any(char.isalpha() for char in token):
            continue
        if not all(char.isalnum() or char == '_' for char in token):
            continue
        terms.append(token)
        seen.add(token)
    return terms


def matching_terms(snippet: str, terms: Iterable[str], *,
                   include_single_ascii: bool = False) -> List[str]:
    # Chinese segmentation can differ between query and snippet. Match the
    # visible text, while ASCII boundaries prevent art matching partial.
    # Single-letter identifiers are valid recall evidence (C, R), while the
    # card display retains its two-character minimum. Never relax Hanzi.
    terms = [term for term in terms if len(term) >= 2
             or (include_single_ascii and re.fullmatch(r'[a-zA-Z]', term))]
    if not terms:
        return []
    matches = []
    for term in terms:
        if len(term) == 1:
            # Ranking reads pretokenized FTS evidence. Its analyzer conflates
            # C/C++/C#, so require the exact whitespace-delimited source token.
            if re.search(r'(?<!\S)' + re.escape(term) + r'(?!\S)', snippet, re.IGNORECASE):
                matches.append(term)
            continue
        left = r'(?<![a-zA-Z0-9_])' if re.match(r'[a-zA-Z0-9_]', term[0]) else ''
        right = r'(?![a-zA-Z0-9_])' if re.match(r'[a-zA-Z0-9_]', term[-1]) else ''
        if re.search(left + re.escape(term) + right, snippet, re.IGNORECASE):
            matches.append(term)
    return matches


def highlight_terms(query: str, snippet: str, terms: Iterable[str]) -> List[str]:
    """Choose a small set of truthful, informative overlaps for the card UI.

    Promote noun/name compounds and a bounded technical glossary only when
    the complete span occurs in both query and displayed snippet. Adjacency
    alone does not justify joining a function word or an arbitrary verb.
    """
    effective = set(terms)
    matches = [term for term in matching_terms(snippet, effective)
               if term not in LOW_VALUE_HIGHLIGHTS
               and not is_weak_lexical_term(term)]
    promoted = []
    parts = list(jieba.tokenize(query))
    for (left, _, left_end), (right, right_start, _) in zip(parts, parts[1:]):
        if left_end != right_start:
            continue
        phrase = left + right
        noun_pair = (_term_flag(left).startswith('n')
                     and _term_flag(right).startswith('n'))
        is_compound = (sorted((len(left), len(right))) == [1, 2]
                       and (phrase in DOMAIN_COMPOUNDS
                            or (noun_pair and not is_weak_lexical_term(left)
                                and not is_weak_lexical_term(right))))
        is_modified_term = (left in WEAK_STANDALONE_MODIFIERS
                            and not is_weak_lexical_term(right)
                            and _term_flag(right).startswith(('n', 'v'))
                            and 2 <= len(right) <= 5)
        if not (is_compound or is_modified_term):
            continue
        if not re.fullmatch(r'[\u4e00-\u9fff]+', left + right):
            continue
        if not effective.issuperset((left.lower(), right.lower())):
            continue
        if phrase in snippet and phrase not in promoted:
            promoted.append(phrase)

    candidates = promoted + [term for term in matches
                             if not any(term in phrase for phrase in promoted)]
    # The query's own order breaks ties; whole terms take priority over parts.
    return sorted(candidates, key=lambda term: (-len(term), query.lower().find(term.lower())))[:6]
