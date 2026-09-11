import { ItemView, WorkspaceLeaf, TFile, MarkdownView, Notice } from 'obsidian';
import SemantixPlugin, { IndexingState } from '../main';
import { RadarCardItem } from '../api/types';
import { t } from '../i18n/helpers';
import { PopoverPreview } from './popover-preview';

export const WHISPERER_VIEW_TYPE = "semantix-whisperer-view";

export class WhispererView extends ItemView {
    plugin: SemantixPlugin;
    private indicatorEl!: HTMLElement;
    private statusTextEl!: HTMLElement;
    private contextBreadcrumbEl!: HTMLElement;
    private scanNoteBtnEl!: HTMLElement;
    private scanBarEl!: HTMLElement;
    private progressContainerEl!: HTMLElement;
    private progressTextEl!: HTMLElement;
    private progressCountEl!: HTMLElement;
    private progressBarEl!: HTMLElement;
    private relatedContainerEl!: HTMLElement;
    private discoverContainerEl!: HTMLElement;
    private popoverPreview: PopoverPreview;

    constructor(leaf: WorkspaceLeaf, plugin: SemantixPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.popoverPreview = new PopoverPreview();
        this.popoverPreview.setCallbacks(
            (item) => this.handleInsertLink(item),
            (item) => this.handleJumpToNote(item)
        );
    }

    getViewType() {
        return WHISPERER_VIEW_TYPE;
    }

    getDisplayText() {
        return "Semantix";
    }

    getIcon() {
        return "radar";
    }

    async onOpen() {
        const container = this.containerEl.children[1] as HTMLElement;
        if (!container) return;

        container.empty();

        if (this.plugin.isMobileHibernating) {
            container.createEl("div", { cls: "semantix-hibernating" }).createEl("p", {
                text: t('MOBILE_HIBERNATING'),
                cls: "semantix-empty-text"
            });
            return;
        }

        const wrapper = container.createEl("div", { cls: "semantix-sidebar-wrapper" });

        // --- 顶部状态与上下文信息栏 ---
        const topBar = wrapper.createEl("div", { cls: "semantix-top-bar" });

        const statusGroup = topBar.createEl("div", { cls: "semantix-status-group" });
        this.indicatorEl = statusGroup.createEl("div", { cls: "semantix-status-indicator" });
        this.statusTextEl = statusGroup.createEl("span", {
            text: t('TESTING'),
            cls: "semantix-status-text"
        });

        // 临时 Note Mode 扫描按钮
        this.scanNoteBtnEl = topBar.createEl("button", {
            cls: "semantix-btn-scan-note",
            text: t('BTN_SCAN_NOTE'),
            attr: { "title": t('BTN_SCAN_NOTE_TOOLTIP'), "aria-label": t('BTN_SCAN_NOTE') }
        });
        this.scanNoteBtnEl.addEventListener("click", () => {
            this.plugin.whisperer.triggerNoteScan();
        });

        // 实时检索微光扫描条 (常驻顶栏下方，检索时优雅渐显，无 DOM 重排跳动)
        this.scanBarEl = wrapper.createEl("div", { cls: "semantix-scan-bar" });

        // --- 动态进度反馈条 (全量索引与增量同步，仅展示分数/计数，不展示百分比) ---
        this.progressContainerEl = wrapper.createEl("div", { 
            cls: "semantix-indexing-progress-container is-hidden" 
        });
        const progressHeader = this.progressContainerEl.createEl("div", { cls: "semantix-progress-header" });
        this.progressTextEl = progressHeader.createEl("span", { 
            cls: "semantix-progress-text",
            text: "" 
        });
        this.progressCountEl = progressHeader.createEl("span", { 
            cls: "semantix-progress-count", 
            text: "" 
        });
        const progressTrack = this.progressContainerEl.createEl("div", { cls: "semantix-progress-track" });
        this.progressBarEl = progressTrack.createEl("div", { cls: "semantix-progress-bar" });

        // --- 主双流卡片区 ---
        const contentArea = wrapper.createEl("div", { cls: "semantix-content-area" });

        // 1. Related 区域
        const relatedSection = contentArea.createEl("div", { cls: "semantix-section" });
        relatedSection.createEl("div", { 
            cls: "semantix-section-header", 
            text: t('STREAM_RELATED_TITLE'),
            attr: { "title": t('STREAM_RELATED_TOOLTIP') }
        });
        this.relatedContainerEl = relatedSection.createEl("div", { cls: "semantix-card-list" });
        this.relatedContainerEl.createEl("p", {
            text: t('WAITING_INPUT'),
            cls: "semantix-empty-text"
        });

        // 2. Discover 区域
        const discoverSection = contentArea.createEl("div", { cls: "semantix-section" });
        discoverSection.createEl("div", { 
            cls: "semantix-section-header", 
            text: t('STREAM_DISCOVER_TITLE'),
            attr: { "title": t('STREAM_DISCOVER_TOOLTIP') }
        });
        this.discoverContainerEl = discoverSection.createEl("div", { cls: "semantix-card-list" });
        this.discoverContainerEl.createEl("p", {
            text: t('DISCOVER_INITIAL'),
            cls: "semantix-empty-text"
        });

        this.updateStatus(this.plugin.getConnectionStatus());

        const initialIndexingState = this.plugin.getIndexingState();
        if (initialIndexingState && initialIndexingState.active) {
            this.updateIndexingProgress(initialIndexingState);
        }
    }

    async onClose() {
        this.popoverPreview.destroy();
    }

    public updateContextBreadcrumb(_filePath?: string, _heading?: string) {
        // 顶部栏已精简化，移除 Connected 右侧冗余文件名，保持接口兼容
    }

    public renderRadarResults(
        related: RadarCardItem[],
        discover: RadarCardItem[],
        contextPath?: string,
        contextHeading?: string,
        queryText?: string
    ) {
        this.clearLoading();
        this.updateContextBreadcrumb(contextPath, contextHeading);

        const keywords = queryText ? this.extractKeywords(queryText) : [];

        // 渲染 Related
        this.renderCardList(this.relatedContainerEl, related, t('STREAM_RELATED_EMPTY'), keywords);

        // 渲染 Discover
        this.renderCardList(this.discoverContainerEl, discover, t('STREAM_DISCOVER_EMPTY'), keywords);
    }

    /**
     * 语言感知分词并提取关键词（结合权威停用词与自适应停用词）
     */
    public extractKeywords(text: string): string[] {
        if (!text) return [];

        const stopWords = new Set([
            '的', '了', '在', '是', '和', '与', '或', '也', '都', '就', '不', '有', '这', '那',
            '我', '你', '他', '她', '它', '们', '个', '上', '下', '中', '来', '去', '到', '说',
            '要', '会', '能', '对', '着', '过', '从', '把', '给', '向', '而', '但', '如', '所',
            '以', '为', '于', '之', '其', '者', '等', '时', '地', '得', '啊', '吗', '呢', '吧',
            '呀', '哦', '哈', '嗯', '哎', '唉', '且', '并', '若', '况', '非', '莫', '既',
            '怎么', '如何', '什么', '为什么', '哪里', '什么时候', '这样', '那样', '哪个', '哪些',
            '觉得', '认为', '就是', '其实', '大概', '可能', '虽然', '但是', '如果', '由于', '因此',
            '所以', '因为', '既然', '以此', '不仅', '而且', '此外', '或者', '否则', '还是', '甚至',
            '以及', '至于', '关于', '对于', '所谓', '比如', '例如', '总之', '最后', '首先', '其次',
            '已经', '曾经', '正在', '即将', '刚刚', '一直', '总是', '经常', '偶尔', '非常', '相当',
            '及其', '更加', '比较', '稍微', '几乎', '所有', '整个', '一切', '各种', '各个', '部分',
            '一些', '一点', '有些', '好多', '若干', '很多', '只有', '只要', '无论', '不管', '即使'
        ]);

        // 合并后端自适应停用词
        if (this.plugin.settings.enableAdaptiveFiltering && this.plugin.vaultStopwords?.length > 0) {
            for (const word of this.plugin.vaultStopwords) {
                stopWords.add(word.toLowerCase());
            }
        }

        // 合并用户自主定义的停用词
        if (this.plugin.settings.customStopwords) {
            const customList = this.plugin.settings.customStopwords
                .split(/[\n,，\s]+/)
                .map(w => w.trim().toLowerCase())
                .filter(Boolean);
            for (const word of customList) {
                stopWords.add(word);
            }
        }

        const keywords: Set<string> = new Set();
        try {
            const SegmenterConstructor = (Intl as unknown as { Segmenter?: new (locales: string, options: { granularity: string }) => { segment: (text: string) => Iterable<{ segment: string; isWordLike: boolean }> } }).Segmenter;
            if (SegmenterConstructor) {
                const segmenter = new SegmenterConstructor('zh', { granularity: 'word' });
                for (const { segment, isWordLike } of segmenter.segment(text)) {
                    if (!isWordLike) continue;
                    const lower = segment.toLowerCase().trim();
                    if (stopWords.has(lower) || /^\d+$/.test(lower)) continue;
                    if (lower.length >= 2) keywords.add(lower);
                }
            } else {
                throw new Error("Intl.Segmenter unavailable");
            }
        } catch {
            const words = text.match(/[\u4e00-\u9fa5]{2,}|[a-zA-Z]{3,}/g) || [];
            for (const word of words) {
                const lower = word.toLowerCase();
                if (!stopWords.has(lower)) keywords.add(lower);
            }
        }

        return Array.from(keywords).sort((a, b) => b.length - a.length).slice(0, 8);
    }

    private renderHighlightedSnippet(container: HTMLElement, snippet: string, keywords: string[]) {
        const p = container.createEl("p", { cls: "semantix-card-snippet" });
        if (!keywords || keywords.length === 0) {
            p.setText(snippet);
            return;
        }

        const escaped = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
        const parts = snippet.split(regex);

        for (const part of parts) {
            if (!part) continue;
            if (regex.test(part)) {
                p.createEl("mark", { cls: "semantix-highlight", text: part });
            } else {
                p.appendText(part);
            }
        }
    }

    private renderCardList(container: HTMLElement, items: RadarCardItem[], emptyText: string, keywords: string[] = []) {
        if (!container) return;
        container.empty();

        if (items.length === 0) {
            container.createEl("p", { text: emptyText, cls: "semantix-empty-text" });
            return;
        }

        for (const item of items) {
            const card = container.createEl("div", { cls: "semantix-radar-card" });
            card.setAttribute("title", t('CARD_CLICK_OPEN'));
            // A11y: 支持键盘导航与屏幕阅读器
            card.setAttribute("tabindex", "0");
            card.setAttribute("role", "button");

            // 顶行：仅展示相关度指示分数（移除卡片内冗余文件名与引用按钮，空间让渡给联想内容）
            if (typeof item.score === 'number' && !isNaN(item.score)) {
                const scoreVal = (Math.round(item.score * 100) / 100).toFixed(2);
                let tierText = "●●○";
                let tierCls = "mid";
                if (item.score >= 0.75) {
                    tierText = "●●●";
                    tierCls = "high";
                } else if (item.score < 0.50) {
                    tierText = "●○○";
                    tierCls = "low";
                }
                const headerRow = card.createEl("div", { cls: "semantix-card-header-row" });
                headerRow.createEl("span", {
                    cls: `semantix-card-score mod-${tierCls}`,
                    text: tierText,
                    attr: { "title": `${t('POPOVER_MATCH')}: ${scoreVal}` }
                });
            }

            // 摘要行 (高亮关键词与自适应降噪)
            this.renderHighlightedSnippet(card, item.snippet, keywords);

            // 标签徽标行
            if (item.labels && item.labels.length > 0) {
                const labelRow = card.createEl("div", { cls: "semantix-badge-row" });
                for (const code of item.labels) {
                    labelRow.createEl("span", {
                        cls: `semantix-badge badge-${code.toLowerCase()}`,
                        text: this.translateLabel(code)
                    });
                }
            }

            // 悬浮 Popover 预览 (展示更完整的关联元数据与段落)
            card.addEventListener("mouseenter", () => {
                this.popoverPreview.show(card, item);
            });
            card.addEventListener("mouseleave", () => {
                this.popoverPreview.scheduleHide();
            });

            // 点击卡片直接打开笔记并定位段落
            card.addEventListener("click", () => {
                this.handleJumpToNote(item);
            });
            // A11y: 键盘 Enter/Space 触发与点击等效行为
            card.addEventListener("keydown", (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    this.handleJumpToNote(item);
                }
            });
        }
    }

    private translateLabel(code: string): string {
        switch (code) {
            case 'KEYWORD_MATCH': return t('LABEL_KEYWORD_MATCH');
            case 'DEEP_SEMANTIC': return t('LABEL_DEEP_SEMANTIC');
            case 'SAME_FOLDER': return t('LABEL_SAME_FOLDER');
            case 'SHARED_TAGS': return t('LABEL_SHARED_TAGS');
            case 'CROSS_TOPIC': return t('LABEL_CROSS_TOPIC');
            case 'CROSS_FOLDER': return t('LABEL_CROSS_FOLDER');
            case 'UNLINKED': return t('LABEL_UNLINKED');
            case 'SERENDIPITY': return t('LABEL_SERENDIPITY');
            default: return code;
        }
    }

    private async handleJumpToNote(item: RadarCardItem) {
        this.popoverPreview.hide();
        const file = this.plugin.app.vault.getAbstractFileByPath(item.path);
        if (!file || !(file instanceof TFile)) return;

        // 在主编辑区原位打开并激活该活动叶子，显式聚焦编辑器，确保用户可直接编辑
        let leaf = this.plugin.app.workspace.getLeaf(false);
        if (!leaf || leaf.view instanceof WhispererView) {
            leaf = this.plugin.app.workspace.getLeaf('tab');
        }
        await leaf.openFile(file);
        this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });

        // 定位匹配段落并滚动高亮，无论是否匹配均聚焦编辑器
        if (leaf.view instanceof MarkdownView) {
            const editor = leaf.view.editor;
            editor.focus();
            if (item.snippet) {
                const cleanSnip = item.snippet.replace(/^\.\.\.|\.\.\.$/g, '').trim().slice(0, 25);
                const count = editor.lineCount();
                for (let i = 0; i < count; i++) {
                    const line = editor.getLine(i);
                    if (cleanSnip && line.includes(cleanSnip)) {
                        editor.setCursor({ line: i, ch: 0 });
                        editor.scrollIntoView({ from: { line: i, ch: 0 }, to: { line: i, ch: line.length } }, true);
                        break;
                    }
                }
            }
        }
    }

    private handleInsertLink(item: RadarCardItem) {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        const editor = view.editor;
        const cursor = editor.getCursor();
        const link = `[[${item.title}]]`;
        editor.replaceRange(link, cursor);
        editor.setCursor({ line: cursor.line, ch: cursor.ch + link.length });
        editor.focus();
        new Notice(`${t('CARD_INSERT_LINK_NOTICE')}[[${item.title}]]`, 1500);
    }

    public showLoading() {
        if (this.scanBarEl) {
            this.scanBarEl.addClass("is-scanning");
        }
        if (this.indicatorEl && this.statusTextEl) {
            this.indicatorEl.className = 'semantix-status-indicator status-scanning';
            this.statusTextEl.setText(t('STATUS_SCANNING'));
        }
    }

    public clearLoading() {
        if (this.scanBarEl) {
            this.scanBarEl.removeClass("is-scanning");
        }
        this.updateStatus(this.plugin.getConnectionStatus());
    }

    public updateStatus(status: 'connected' | 'disconnected' | 'syncing' | 'disabled') {
        if (!this.indicatorEl || !this.statusTextEl) return;
        this.indicatorEl.className = 'semantix-status-indicator';
        this.indicatorEl.classList.add(`status-${status}`);

        let text = t('STATUS_DISABLED');
        if (status === 'connected') text = t('STATUS_CONNECTED');
        else if (status === 'disconnected') text = t('STATUS_DISCONNECTED');
        else if (status === 'syncing') text = t('STATUS_SYNCING');
        this.statusTextEl.setText(text);
    }

    /**
     * 更新索引与同步进度视觉指示器
     */
    public updateIndexingProgress(state: IndexingState) {
        if (!this.progressContainerEl || !this.progressBarEl || !this.progressTextEl || !this.progressCountEl) {
            return;
        }

        const shouldShowBox = state && state.active && state.total > 0 && (state.label === 'full' || state.total >= 5);
        if (shouldShowBox) {
            this.progressContainerEl.removeClass("is-hidden");
            const pct = Math.min(100, Math.max(0, Math.round((state.current / state.total) * 100)));
            this.progressBarEl.setCssStyles({ width: `${pct}%` });
            this.progressCountEl.setText(`(${state.current}/${state.total})`);
            const label = state.label === 'sync' ? t('PROGRESS_LABEL_SYNC') : t('PROGRESS_LABEL_INDEX');
            this.progressTextEl.setText(label);
            this.updateStatus('syncing');
        } else {
            this.progressContainerEl.addClass("is-hidden");
            this.progressBarEl.setCssStyles({ width: '0%' });
            if (state && state.active && state.total > 0) {
                this.updateStatus('syncing');
            } else {
                this.updateStatus(this.plugin.getConnectionStatus());
            }
        }
    }

    public updateIndexStatus(_totalNotes: number, _lastUpdated?: string) {
        // 保留接口兼容性
    }
}
