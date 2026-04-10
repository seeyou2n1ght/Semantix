/**
 * Lightweight Markdown cleaning that preserves document structure for chunking.
 * The backend relies on headings and paragraph boundaries to build better chunks,
 * so this cleaner removes noise but does not collapse the whole note into one line.
 */
export function cleanMarkdown(text: string): string {
    if (!text) return "";

    let cleaned = text.replace(/\r\n?/g, "\n");

    // 1. Remove YAML frontmatter
    cleaned = cleaned.replace(/^---\n[\s\S]*?\n---\n?/g, "");

    // 2. Strip fenced code block markers but preserve content
    cleaned = cleaned.replace(/```[\s\S]*?```/g, (match) => {
        // Remove the prefix ```lang and suffix ```
        return match.replace(/^```[a-zA-Z0-9-]*\n?/, "").replace(/```$/, "").trim();
    });
    // Strip inline code markers
    cleaned = cleaned.replace(/`([^`]+)`/g, "$1");

    // 3. Remove image/embed syntax
    cleaned = cleaned.replace(/!\[\[.*?\]\]/g, "");
    cleaned = cleaned.replace(/!\[.*?\]\(.*?\)/g, "");

    // 4. Convert wikilinks and normal links to visible text
    cleaned = cleaned.replace(/\[\[(.*?)\]\]/g, (_match, target) => {
        const parts = target.split("|");
        return parts.length > 1 ? parts[1] : parts[0];
    });
    cleaned = cleaned.replace(/\[(.*?)\]\(.*?\)/g, "$1");

    // 5. Strip common formatting markers but keep heading markers for chunking
    cleaned = cleaned.replace(/(\*\*|__)(.*?)\1/g, "$2");
    cleaned = cleaned.replace(/(\*|_)(.*?)\1/g, "$2");
    cleaned = cleaned.replace(/~~(.*?)~~/g, "$1");

    // 6. Remove quote and list markers while keeping each item on its own line
    cleaned = cleaned.replace(/^[>\-\*+]\s+/gm, "");

    // 7. Remove HTML tags
    cleaned = cleaned.replace(/<[^>]*>?/gm, "");

    // 8. Normalize whitespace without destroying headings or paragraph breaks
    cleaned = cleaned
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/g, "").trimStart())
        .join("\n");

    cleaned = cleaned.replace(/\n[ \t]+\n/g, "\n\n");
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
    cleaned = cleaned.replace(/[ \t]{2,}/g, " ");

    return cleaned.trim();
}
