import { Editor, MarkdownView, TFile, debounce } from 'obsidian';
import SemantixPlugin from '../main';
import { cleanMarkdown } from '../utils/markdown';
import { SearchResultItem } from '../api/types';
import { WHISPERER_VIEW_TYPE, WhispererView } from '../ui/whisperer-view';

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
     * 配置变更时重新创建 debounce 函数
     */
    public setupDebounce() {
        this.debouncedSearch = debounce(
            this.handleSearchTrigger.bind(this),
            this.plugin.settings.debounceDelay,
            false
        );
    }

    /**
     * 文件打开时触发搜索
     */
    public async onFileOpen(file: TFile | null) {
        if (!file || file.extension !== 'md') return;
        
        this.lastSearchedText = "";
        await this.handleSearchTrigger();
    }

    /**
     * 编辑器变更时触发防抖搜索
     */
    public onEditorChange(editor: Editor, view: MarkdownView) {
        this.debouncedSearch();
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

        // 构建排除列表
        let excludes: string[] = [view.file.path];

        if (this.plugin.settings.filterLinkedNotes) {
            const cache = this.plugin.app.metadataCache.resolvedLinks[view.file.path];
            if (cache) {
                const linkedPaths = Object.keys(cache);
                excludes = excludes.concat(linkedPaths);
            }
        }

        console.debug("Semantix Whisperer: Triggering semantic search...");

        const response = await this.plugin.apiClient.semanticSearch({
            vault_id: this.plugin.vaultId,
            text: cleaned,
            top_k: this.plugin.settings.topNResults,
            exclude_paths: excludes
        });

        if (response && response.results) {
            this.renderResults(response.results);
        }
    }

    private extractParagraph(editor: Editor, startLineNo: number): string {
        let text = editor.getLine(startLineNo);
        if (text.trim() === '') return '';
        
        // 向上扫描直到空行
        let currentLine = startLineNo - 1;
        while (currentLine >= 0) {
            const lineText = editor.getLine(currentLine);
            if (lineText.trim() === '') break;
            text = lineText + '\n' + text;
            currentLine--;
        }

        // 向下扫描直到空行
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

    private renderResults(results: SearchResultItem[]) {
        // 定位 WhispererView 并渲染结果
        const leaves = this.plugin.app.workspace.getLeavesOfType(WHISPERER_VIEW_TYPE);
        if (leaves.length === 0) return;

        const leaf = leaves[0];
        if (leaf && leaf.view instanceof WhispererView) {
            (leaf.view as WhispererView).renderWhispererResults(results);
        }
    }
}
