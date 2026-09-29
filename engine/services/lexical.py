"""Request-scoped lexical filtering shared by recall and snippet evidence."""
import re
from typing import Iterable, List

import jieba


# Function words only: domain vocabulary remains eligible for recall.
BASE_STOPWORDS = frozenset("""
的 了 在 是 和 与 或 也 都 就 不 有 这 那 我 你 他 她 它 们 个 上 下 中 来 去 到 说 要 会 能 对 着 过 从 把 给 向 而 但 如 所 以
为 于 之 其 者 等 时 地 得 啊 吗 呢 吧 呀 哦 哈 嗯 哎 唉 且 并 若 况 非 莫 既 怎么 如何 什么 为什么 哪里 什么时候 这样 那样 哪个 哪些
觉得 认为 就是 其实 大概 可能 虽然 但是 如果 由于 因此 所以 因为 既然 以此 不仅 而且 此外 或者 否则 还是 甚至 以及 至于 关于 对于 所谓 比如
例如 总之 最后 首先 其次 已经 曾经 正在 即将 刚刚 一直 总是 经常 偶尔 非常 相当 及其 更加 比较 稍微 几乎 所有 整个 一切 各种 各个 部分 一些
一点 有些 好多 若干 很多 只有 只要 无论 不管 即使
a an the and or but if then else as at by for from in into of on to with
is are was were be been being do does did have has had this that these those
it its i me my we our you your he she they them their not no so very also
""".split())

# Display-only: these words can still contribute to lexical recall. In a
# snippet, highlighting them usually explains little about the relationship.
LOW_VALUE_HIGHLIGHTS = frozenset("""
需要 通过 问题 方法 使用 进行 解决 作为 一种 我们 这个 不是 没有 时候 其他 之后 然后
""".split())


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


def matching_terms(snippet: str, terms: Iterable[str]) -> List[str]:
    # Chinese segmentation can differ between query and snippet. Match the
    # visible text, while ASCII boundaries prevent art matching partial.
    terms = [term for term in terms if len(term) >= 2]
    if not terms:
        return []
    matches = []
    for term in terms:
        left = r'(?<![a-zA-Z0-9_])' if re.match(r'[a-zA-Z0-9_]', term[0]) else ''
        right = r'(?![a-zA-Z0-9_])' if re.match(r'[a-zA-Z0-9_]', term[-1]) else ''
        if re.search(left + re.escape(term) + right, snippet, re.IGNORECASE):
            matches.append(term)
    return matches


def highlight_terms(query: str, snippet: str, terms: Iterable[str]) -> List[str]:
    """Choose a small set of truthful, informative overlaps for the card UI.

    Adjacent 2+1-character Chinese tokens may represent one term absent from
    jieba's dictionary (for example 树莓派 or 阿里云). Promote the complete
    span only when it occurs in both query and displayed snippet.
    """
    effective = set(terms)
    matches = [term for term in matching_terms(snippet, terms)
               if term not in LOW_VALUE_HIGHLIGHTS]
    promoted = []
    parts = list(jieba.tokenize(query))
    for (left, _, left_end), (right, right_start, _) in zip(parts, parts[1:]):
        if left_end != right_start or sorted((len(left), len(right))) != [1, 2]:
            continue
        if not re.fullmatch(r'[\u4e00-\u9fff]+', left + right):
            continue
        if not effective.issuperset((left.lower(), right.lower())):
            continue
        phrase = left + right
        if phrase in snippet and phrase not in promoted:
            promoted.append(phrase)

    candidates = promoted + [term for term in matches
                             if not any(term in phrase for phrase in promoted)]
    # The query's own order breaks ties; whole terms take priority over parts.
    return sorted(candidates, key=lambda term: -len(term))[:6]
