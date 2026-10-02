import { cleanMarkdown } from './markdown';

/** Locate a unique full match in the current source, preserving original lines.
 * No guessed position is returned for edited text or duplicate passages.
 */
export function findSourceLines(rawText: string, sourceText: string): { start: number; end: number } | null {
    const normalize = (text: string) => cleanMarkdown(text).replace(/\s+/g, ' ').trim();
    const needle = normalize(sourceText);
    if (!needle) return null;
    const lines = rawText.replace(/\r\n?/g, '\n').split('\n');
    let firstLine = 0;
    if (lines[0] === '---') {
        const end = lines.indexOf('---', 1);
        if (end >= 0) firstLine = end + 1;
    }
    let haystack = '';
    const offsets: { offset: number; line: number }[] = [];
    for (let line = firstLine; line < lines.length; line++) {
        const text = normalize(lines[line] || '');
        if (!text) continue;
        if (haystack) haystack += ' ';
        offsets.push({ offset: haystack.length, line });
        haystack += text;
    }
    const start = haystack.indexOf(needle);
    if (start < 0 || haystack.indexOf(needle, start + 1) >= 0) return null;
    const lineAt = (position: number) => {
        let found = firstLine;
        for (const entry of offsets) {
            if (entry.offset > position) break;
            found = entry.line;
        }
        return found;
    };
    return { start: lineAt(start), end: lineAt(start + needle.length - 1) };
}
