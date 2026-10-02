import type { RadarCardItem, RadarSearchResponse } from '../api/types';

export function splitNoteQueries(text: string, maxLength = 240): string[] {
    const queries: string[] = [];
    let pending = '';
    for (const block of text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean)) {
        if (pending && pending.length + block.length + 2 > maxLength) {
            queries.push(pending);
            pending = '';
        }
        if (block.length > maxLength) {
            for (let start = 0; start < block.length; start += maxLength - 30) {
                queries.push(block.slice(start, start + maxLength));
                if (start + maxLength >= block.length) break;
            }
        } else {
            pending = pending ? `${pending}\n\n${block}` : block;
        }
    }
    if (pending) queries.push(pending);
    // Identical parts have identical request context and contribute no new
    // evidence to the per-path max merge. Preserve first-occurrence order.
    return [...new Set(queries)];
}

export function mergeNoteResults(responses: RadarSearchResponse[], limit: number) {
    const related = new Map<string, RadarCardItem>();
    const discover = new Map<string, RadarCardItem>();
    for (const response of responses) {
        for (const [items, target] of [[response.related, related], [response.discover, discover]] as const) {
            for (const item of items) {
                if (item.score > (target.get(item.path)?.score ?? -1)) target.set(item.path, item);
            }
        }
    }
    const sort = (items: Iterable<RadarCardItem>) => [...items].sort((a, b) => b.score - a.score);
    const selectedRelated = sort(related.values()).slice(0, limit);
    const relatedPaths = new Set(selectedRelated.map(item => item.path));
    return {
        related: selectedRelated,
        discover: sort(discover.values()).filter(item => !relatedPaths.has(item.path)).slice(0, limit),
        warnings: [...new Set(responses.flatMap(response => response.warnings || []))]
    };
}
