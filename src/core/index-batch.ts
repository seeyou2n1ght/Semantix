import type { TFile } from 'obsidian';
import type SemantixPlugin from '../main';
import type { IndexDocument } from '../api/types';
import { cleanMarkdown } from '../utils/markdown';

export async function readIndexDocument(plugin: SemantixPlugin, file: TFile): Promise<IndexDocument> {
    const text = cleanMarkdown(await plugin.app.vault.cachedRead(file));
    const context = plugin.getFileContext(file);
    // Empty text reaches the engine so its previous index is removed atomically.
    return { vault_id: plugin.vaultId, path: file.path, text, ...context };
}

export function indexBatchWouldOverflow(batch: IndexDocument[], next: IndexDocument): boolean {
    // A single large document remains indivisible; isolate it in its own request.
    return batch.length > 0 && (batch.length >= 25 ||
        batch.reduce((sum, doc) => sum + doc.text.length, 0) + next.text.length > 150_000);
}

export function* indexBatches(documents: IndexDocument[]): Generator<IndexDocument[]> {
    let batch: IndexDocument[] = [];
    for (const doc of documents) {
        if (indexBatchWouldOverflow(batch, doc)) {
            yield batch;
            batch = [];
        }
        batch.push(doc);
    }
    if (batch.length > 0) yield batch;
}
