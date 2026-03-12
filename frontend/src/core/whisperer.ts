import { Editor, MarkdownView, TFile, debounce } from 'obsidian';
import SemantixPlugin from '../main';
import { cleanMarkdown } from '../utils/markdown';
import { SearchResultItem } from '../api/types';
import { SEMANTIX_SIDEBAR_VIEW, SemantixSidebarView } from '../ui/sidebar';

export class Whisperer {
    plugin: SemantixPlugin;
    
    // 缓存上一次发送的文本，避免无意义的重复搜索
    private lastSearchedText: string = "";
    
    // 防抖发送请求
    public debouncedSearch: () => void;

    constructor(plugin: SemantixPlugin) {
        this.plugin = plugin;
        this.setupDebounce();
    }

    /**
     * Recreate debounce function when settings change (debounceDelay)
     */
    public setupDebounce() {
        this.debouncedSearch = debounce(
            this.handleSearchTrigger.bind(this),
            this.plugin.settings.debounceDelay,
            true
        );
    }

    /**
     * Handle explicit file open bounds
     */
    public async onFileOpen(file: TFile | null) {
        if (!file || file.extension !== 'md') return;
        
        // When opening a new file, we usually want to trigger a search
        this.lastSearchedText = ""; // reset history
        await this.handleSearchTrigger();
    }

    /**
     * Handle Editor changes
     */
    public onEditorChange(editor: Editor, view: MarkdownView) {
        // Just ping the debounced func
        this.debouncedSearch();
    }

    private async handleSearchTrigger() {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return;

        let extractText = "";
        if (this.plugin.settings.whispererScope === 'document') {
            extractText = view.editor.getValue();
        } else {
            // Default to 'paragraph' extraction
            const cursor = view.editor.getCursor();
            const lineHtml = view.editor.getLine(cursor.line);
            
            // NOTE for MVP: We just grab the current line. 
            // Real paragraph bounding requires empty line search.
            // Let's implement full block extraction (up and down until empty lines).
            extractText = this.extractParagraph(view.editor, cursor.line);
        }

        const cleaned = cleanMarkdown(extractText);
        if (cleaned.length < 5) return; // Ignore very short texts

        if (cleaned === this.lastSearchedText) return; // Same search
        this.lastSearchedText = cleaned;

        // Perform search
        let excludes: string[] = [view.file.path];

        // Process Filter Linked Notes
        if (this.plugin.settings.filterLinkedNotes) {
            const cache = this.plugin.app.metadataCache.resolvedLinks[view.file.path];
            if (cache) {
                const linkedPaths = Object.keys(cache);
                excludes = excludes.concat(linkedPaths);
            }
        }

        console.debug("Semantix Whisperer: Triggering semantic search...");

        const response = await this.plugin.apiClient.semanticSearch({
            text: cleaned,
            top_k: this.plugin.settings.topNResults,
            exclude_paths: excludes
        });

        if (response && response.results) {
            this.renderResults(response.results, view.file.path);
        }
    }

    private extractParagraph(editor: Editor, startLineNo: number): string {
        let text = editor.getLine(startLineNo);
        if (text.trim() === '') return ''; // Empty block
        
        // Scan upwards
        let currentLine = startLineNo - 1;
        while (currentLine >= 0) {
            const lineText = editor.getLine(currentLine);
            if (lineText.trim() === '') break;
            text = lineText + '\n' + text;
            currentLine--;
        }

        // Scan downwards
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

    private renderResults(results: SearchResultItem[], currentFile: string) {
        // Update Sidebar View
        const leaves = this.plugin.app.workspace.getLeavesOfType(SEMANTIX_SIDEBAR_VIEW);
        if (leaves.length === 0) return;

        const leaf = leaves[0];
        if (leaf && leaf.view instanceof SemantixSidebarView) {
            (leaf.view as SemantixSidebarView).renderWhispererResults(results);
        }
    }
}
