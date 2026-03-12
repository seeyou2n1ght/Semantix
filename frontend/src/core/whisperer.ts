import { Editor, MarkdownView, TFile, debounce } from 'obsidian';
import { ViewPlugin, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import SemantixPlugin from '../main';
import { cleanMarkdown } from '../utils/markdown';
import { SearchResultItem } from '../api/types';
import { WHISPERER_VIEW_TYPE, WhispererView } from '../ui/whisperer-view';

export class Whisperer {
    plugin: SemantixPlugin;
    
    private lastSearchedText: string = "";
    private lastParagraphText: string = "";
    
    public debouncedSearch: () => void;
    private cursorActivityTimer: number | null = null;

    constructor(plugin: SemantixPlugin) {
        this.plugin = plugin;
        this.setupDebounce();
    }

    public setupDebounce() {
        this.debouncedSearch = debounce(
            this.handleSearchTrigger.bind(this),
            this.plugin.settings.debounceDelay,
            false
        );
    }

    public getCursorActivityExtension(): Extension {
        return ViewPlugin.define(() => ({
            update: (update: ViewUpdate) => {
                if (update.selectionSet) {
                    this.onCursorActivity();
                }
            }
        }));
    }

    public async onFileOpen(file: TFile | null) {
        if (!file || file.extension !== 'md') return;
        
        this.lastSearchedText = "";
        this.lastParagraphText = "";
        await this.handleSearchTrigger();
    }

    public onEditorChange(_editor: Editor, _view: MarkdownView): void {
        this.debouncedSearch();
    }

    public onCursorActivity(): void {
        if (this.plugin.settings.whispererScope === 'document') return;
        
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return;
        
        const editor = view.editor;
        const cursor = editor.getCursor();
        const paragraphText = this.extractParagraph(editor, cursor.line);
        const cleaned = this.cleanText(paragraphText);
        
        if (cleaned === this.lastParagraphText) return;
        this.lastParagraphText = cleaned;
        
        if (this.cursorActivityTimer !== null) {
            window.clearTimeout(this.cursorActivityTimer);
        }
        
        this.cursorActivityTimer = window.setTimeout(() => {
            this.handleSearchTrigger();
        }, 300);
    }

    private cleanText(text: string): string {
        return cleanMarkdown(text).trim().slice(0, 100);
    }

    private async handleSearchTrigger() {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return;

        let extractText = "";
        if (this.plugin.settings.whispererScope === 'document') {
            extractText = view.editor.getValue();
        } else {
            const cursor = view.editor.getCursor();
            extractText = this.extractParagraph(view.editor, cursor.line);
        }

        const cleaned = cleanMarkdown(extractText);
        if (cleaned.length < 5) return;

        if (cleaned === this.lastSearchedText) return;
        this.lastSearchedText = cleaned;

        let excludes: string[] = [view.file.path];

        if (this.plugin.settings.filterLinkedNotes) {
            const cache = this.plugin.app.metadataCache.resolvedLinks[view.file.path];
            if (cache) {
                const linkedPaths = Object.keys(cache);
                excludes = excludes.concat(linkedPaths);
            }
        }

        console.debug("Semantix Whisperer: Triggering semantic search...");
        this.showLoading();

        const response = await this.plugin.apiClient.semanticSearch({
            vault_id: this.plugin.vaultId,
            text: cleaned,
            top_k: this.plugin.settings.topNResults,
            exclude_paths: excludes,
            min_similarity: this.plugin.settings.minSimilarityThreshold,
            with_context: this.plugin.settings.enableExplainableResults
        });

        if (response && response.results) {
            this.renderResults(response.results, cleaned, {
                colorThresholdHigh: this.plugin.settings.colorThresholdHigh,
                colorThresholdMedium: this.plugin.settings.colorThresholdMedium
            });
        } else {
            this.clearLoading();
        }
    }

    private extractParagraph(editor: Editor, startLineNo: number): string {
        let text = editor.getLine(startLineNo);
        if (text.trim() === '') return '';
        
        let currentLine = startLineNo - 1;
        while (currentLine >= 0) {
            const lineText = editor.getLine(currentLine);
            if (lineText.trim() === '') break;
            text = lineText + '\n' + text;
            currentLine--;
        }

        currentLine = startLineNo + 1;
        const totalLines = editor.lineCount();
        while (currentLine < totalLines) {
            const lineText = editor.getLine(currentLine);
            if (lineText.trim() === '') break;
            text = text + '\n' + lineText;
            currentLine++;
        }

        return text;
    }

    private renderResults(results: SearchResultItem[], queryText: string, colorSettings?: { colorThresholdHigh: number; colorThresholdMedium: number }) {
        const leaves = this.plugin.app.workspace.getLeavesOfType(WHISPERER_VIEW_TYPE);
        if (leaves.length === 0) return;

        const leaf = leaves[0];
        if (leaf && leaf.view instanceof WhispererView) {
            (leaf.view as WhispererView).renderWhispererResults(results, queryText, colorSettings);
        }
    }

    private showLoading() {
        const leaves = this.plugin.app.workspace.getLeavesOfType(WHISPERER_VIEW_TYPE);
        if (leaves.length === 0) return;

        const leaf = leaves[0];
        if (leaf && leaf.view instanceof WhispererView) {
            (leaf.view as WhispererView).showLoading();
        }
    }

    private clearLoading() {
        const leaves = this.plugin.app.workspace.getLeavesOfType(WHISPERER_VIEW_TYPE);
        if (leaves.length === 0) return;

        const leaf = leaves[0];
        if (leaf && leaf.view instanceof WhispererView) {
            (leaf.view as WhispererView).clearLoading();
        }
    }
}