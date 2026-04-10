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
    private currentSearchId: number = 0;
    
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
        const onCursorActivity = () => this.onCursorActivity();
        return ViewPlugin.fromClass(class {
            update(update: ViewUpdate) {
                if (update.selectionSet) {
                    onCursorActivity();
                }
            }
        });
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

        // 捕获当前搜索 ID 以处理竞态条件
        const searchId = ++this.currentSearchId;

        // P1: 为全篇搜索注入增强上下文
        let queryText = cleaned;
        if (this.plugin.settings.whispererScope === 'document') {
            const cache = this.plugin.app.metadataCache.getFileCache(view.file);
            const tags = cache?.tags?.map(t => t.tag) || [];
            const uniqueTags = [...new Set(tags)];
            const tagStr = uniqueTags.length > 0 ? `标签: ${uniqueTags.join(' ')}\n` : '';
            queryText = `标题: ${view.file.basename}\n${tagStr}${cleaned}`;
        }

        const response = await this.plugin.apiClient.semanticSearch({
            vault_id: this.plugin.vaultId,
            text: queryText,
            top_k: this.plugin.settings.topNResults,
            exclude_paths: excludes,
            min_similarity: this.plugin.settings.minSimilarityThreshold,
            with_context: this.plugin.settings.enableExplainableResults
        });

        // 如果搜索 ID 已过时，丢弃结果
        if (searchId !== this.currentSearchId) {
            return;
        }

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