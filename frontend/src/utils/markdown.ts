/**
 * Markdown 文本降噪处理
 * @param text 原始 Markdown 文本
 * @returns 降噪后的纯文本，保留语义特征（如 #tag）
 */
export function cleanMarkdown(text: string): string {
    if (!text) return "";

    let cleaned = text;

    // 1. 去除 YAML フロントマター (Frontmatter)
    cleaned = cleaned.replace(/^---\n[\s\S]*?\n---\n/g, "");

    // 2. 去除代码块 (Code blocks)
    cleaned = cleaned.replace(/```[\s\S]*?```/g, "");
    
    // 3. 去除行内代码
    cleaned = cleaned.replace(/`[^`]+`/g, "");

    // 4. 处理图片/嵌入语法 (![[...]] 或 ![alt](url)) -> 直接移除
    cleaned = cleaned.replace(/!\[\[.*?\]\]/g, "");
    cleaned = cleaned.replace(/!\[.*?\]\(.*?\)/g, "");

    // 5. 处理双向链接 ([[target|alias]] 或 [[target]]) -> 保留纯文本
    cleaned = cleaned.replace(/\[\[(.*?)\]\]/g, (match, p1) => {
        // 如果有 alias，保留 alias，否则保留 target
        const parts = p1.split('|');
        return parts.length > 1 ? parts[1] : parts[0];
    });

    // 6. 处理普通外部链接 ([text](url)) -> 保留 text
    cleaned = cleaned.replace(/\[(.*?)\]\(.*?\)/g, "$1");

    // 7. 去除 Markdown 格式符 (粗体，斜体，删除线)
    // 注意：不要去除了 #tag，所以我们要小心处理 # 号。通常 # 标题符号可以去除或者转空格。
    cleaned = cleaned.replace(/(\*\*|__)(.*?)\1/g, "$2"); // **粗体** 或 __粗体__
    cleaned = cleaned.replace(/(\*|_)(.*?)\1/g, "$2"); // *斜体* 或 _斜体_
    cleaned = cleaned.replace(/~~(.*?)~~/g, "$1"); // ~~删除线~~

    // 8. 统一将标题符号 # 转为空格（如果是作为标题开头），保留 #tag
    // 带有空格的 `# ` 表示标题
    cleaned = cleaned.replace(/^#+\s+/gm, "");

    // 9. 去除 > 引用符，列表符等
    cleaned = cleaned.replace(/^[>\-\*\+]\s+/gm, "");
    
    // 10. 去除 HTML 标签 (简单正则)
    cleaned = cleaned.replace(/<[^>]*>?/gm, "");

    // 11. 将多个换行符合并，去除头尾多余空白
    cleaned = cleaned.replace(/\s*\n\s*/g, "\n");
    cleaned = cleaned.replace(/\n{2,}/g, "\n"); // 收紧段落
    cleaned = cleaned.replace(/\s+/g, " "); // 全部转为空格或者保持原样？为了语义提取，转空格比较好

    return cleaned.trim();
}
