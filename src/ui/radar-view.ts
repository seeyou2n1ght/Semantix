import { ItemView, WorkspaceLeaf, TFile, MarkdownView, Notice, HoverParent, HoverPopover, Keymap, UserEvent } from 'obsidian';
import SemantixPlugin, { IndexingState } from '../main';
import { RadarCardItem } from '../api/types';
import { t } from '../i18n/helpers';
import { PopoverPreview } from './popover-preview';

export const WHISPERER_VIEW_TYPE = "semantix-whisperer-view";
export const RADAR_VIEW_TYPE = WHISPERER_VIEW_TYPE;

export class RadarView extends ItemView implements HoverParent {
    plugin: SemantixPlugin;
    hoverPopover: HoverPopover | null = null;
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
            (item, event) => { void this.handleJumpToNote(item, event); }
        );
    }

    getViewType() {
        return RADAR_VIEW_TYPE;
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
            container.createDiv({ cls: "semantix-hibernating" }).createEl("p", {
                text: t('MOBILE_HIBERNATING'),
                cls: "semantix-empty-text"
            });
            return;
        }

        const wrapper = container.createDiv({ cls: "semantix-sidebar-wrapper" });

        // --- 顶部状态与上下文信息栏 ---
        const topBar = wrapper.createDiv({ cls: "semantix-top-bar" });

        const statusGroup = topBar.createDiv({ cls: "semantix-status-group" });
        this.indicatorEl = statusGroup.createDiv({ cls: "semantix-status-indicator" });
        this.statusTextEl = statusGroup.createSpan({
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
            void this.plugin.radar.triggerNoteScan();
        });

        // 实时检索微光扫描条 (常驻顶栏下方，检索时优雅渐显，无 DOM 重排跳动)
        this.scanBarEl = wrapper.createDiv({ cls: "semantix-scan-bar" });

        // --- 动态进度反馈条 (全量索引与增量同步，仅展示分数/计数，不展示百分比) ---
        this.progressContainerEl = wrapper.createDiv({ 
            cls: "semantix-indexing-progress-container is-hidden" 
        });
        const progressHeader = this.progressContainerEl.createDiv({ cls: "semantix-progress-header" });
        this.progressTextEl = progressHeader.createSpan({ 
            cls: "semantix-progress-text",
            text: "" 
        });
        this.progressCountEl = progressHeader.createSpan({ 
            cls: "semantix-progress-count", 
            text: "" 
        });
        const progressTrack = this.progressContainerEl.createDiv({ cls: "semantix-progress-track" });
        this.progressBarEl = progressTrack.createDiv({ cls: "semantix-progress-bar" });

        // --- 主双流卡片区 ---
        const contentArea = wrapper.createDiv({ cls: "semantix-content-area" });

        // 1. Related 区域
        const relatedSection = contentArea.createDiv({ cls: "semantix-section" });
        relatedSection.createDiv({ 
            cls: "semantix-section-header", 
            text: t('STREAM_RELATED_TITLE'),
            attr: { "title": t('STREAM_RELATED_TOOLTIP') }
        });
        this.relatedContainerEl = relatedSection.createDiv({ cls: "semantix-card-list" });
        this.relatedContainerEl.createEl("p", {
            text: t('WAITING_INPUT'),
            cls: "semantix-empty-text"
        });

        // 2. Discover 区域
        const discoverSection = contentArea.createDiv({ cls: "semantix-section" });
        discoverSection.createDiv({ 
            cls: "semantix-section-header", 
            text: t('STREAM_DISCOVER_TITLE'),
            attr: { "title": t('STREAM_DISCOVER_TOOLTIP') }
        });
        this.discoverContainerEl = discoverSection.createDiv({ cls: "semantix-card-list" });
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
            const card = container.createDiv({ cls: "semantix-radar-card" });
            card.setAttribute("title", t('CARD_CLICK_OPEN'));
            // A11y: 支持键盘导航与屏幕阅读器
            card.setAttribute("tabindex", "0");
            card.setAttribute("role", "button");

            // 顶行：左侧笔记名称，右侧快捷操作（单个引用按钮）+ 红绿灯分值点
            const headerRow = card.createDiv({ cls: "semantix-card-header-row" });
            const titleText = item.title ? item.title.replace(/\.md$/i, '') : item.path.split('/').pop()?.replace(/\.md$/i, '') || '';
            headerRow.createSpan({
                cls: "semantix-card-title",
                text: titleText,
                attr: { "title": `${item.title} (${item.path})` }
            });

            const rightGroup = headerRow.createDiv({ cls: "semantix-card-header-right" });

            // 悬浮淡现的唯一“引用”按钮
            const insertBtn = rightGroup.createEl("button", {
                cls: "semantix-card-action-btn mod-insert",
                text: "🔗",
                attr: {
                    "title": t('CARD_INSERT_LINK'),
                    "aria-label": t('CARD_INSERT_LINK')
                }
            });
            insertBtn.addEventListener("click", (e: MouseEvent) => {
                e.stopPropagation();
                this.handleInsertLink(item);
            });

            // 红绿灯分数 Badge
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
                rightGroup.createSpan({
                    cls: `semantix-card-score mod-${tierCls}`,
                    text: tierText,
                    attr: { "title": `${t('POPOVER_MATCH')}: ${scoreVal}` }
                });
            }

            // 内容行 (摘要行，高亮关键词与自适应降噪)
            this.renderHighlightedSnippet(card, item.snippet, keywords);

            // 底部行 (召回原因标签行：严格限制至多展示 1 个高熵徽章)
            if (item.labels && item.labels.length > 0) {
                const labelRow = card.createDiv({ cls: "semantix-badge-row" });
                for (const code of item.labels.slice(0, 1)) {
                    const baseCode = (code.split(':')[0] || '').toLowerCase();
                    labelRow.createSpan({
                        cls: `semantix-badge badge-${baseCode}`,
                        text: this.translateLabel(code)
                    });
                }
            }

            // 悬浮 Popover 预览 (支持 200ms 防抖调度与 Mod+Hover 原生 Page Preview)
            card.addEventListener("mouseenter", (e: MouseEvent) => {
                if (Keymap.isModifier(e, 'Mod')) {
                    this.popoverPreview.hide();
                    this.app.workspace.trigger('hover-link', {
                        event: e,
                        source: 'semantix',
                        hoverParent: this,
                        targetEl: card,
                        linktext: item.path,
                        sourcePath: this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path,
                    });
                    return;
                }
                this.popoverPreview.scheduleShow(card, item, this.plugin.app, 200);
            });
            card.addEventListener("mousemove", (e: MouseEvent) => {
                if (Keymap.isModifier(e, 'Mod')) {
                    this.popoverPreview.hide();
                    this.app.workspace.trigger('hover-link', {
                        event: e,
                        source: 'semantix',
                        hoverParent: this,
                        targetEl: card,
                        linktext: item.path,
                        sourcePath: this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path,
                    });
                }
            });
            card.addEventListener("mouseleave", () => {
                this.popoverPreview.cancelShow();
                this.popoverPreview.scheduleHide();
            });

            // 点击卡片直接打开笔记并定位段落（支持普通点击当前窗口，Shift+点击新标签页）
            card.addEventListener("click", (e: MouseEvent) => {
                void this.handleJumpToNote(item, e);
            });
            // 鼠标中键直接在新标签页打开
            card.addEventListener("auxclick", (e: MouseEvent) => {
                if (e.button === 1) {
                    e.preventDefault();
                    void this.handleJumpToNote(item, e);
                }
            });
            // A11y: 键盘 Enter/Space 打开；Mod+Enter 快捷插入双向链接
            card.addEventListener("keydown", (e: KeyboardEvent) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.handleInsertLink(item);
                    return;
                }
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void this.handleJumpToNote(item, e);
                }
            });
        }
    }

    private translateLabel(code: string): string {
        if (code.startsWith('CONCEPT_BRIDGE:')) {
            const target = code.slice('CONCEPT_BRIDGE:'.length).trim();
            return `🌉 [[${target}]]`;
        }
        switch (code) {
            case 'MISSING_LINK': return t('LABEL_MISSING_LINK');
            case 'ISLAND_WAKE': return t('LABEL_ISLAND_WAKE');
            case 'CONCEPT_BRIDGE': return t('LABEL_CONCEPT_BRIDGE');
            case 'CROSS_DOMAIN': return t('LABEL_CROSS_DOMAIN');
            case 'DEEP_ECHO': return t('LABEL_DEEP_ECHO');
            case 'TOPIC_TAG': return t('LABEL_TOPIC_TAG');
            case 'SAME_FOLDER': return t('LABEL_SAME_FOLDER');
            case 'SHARED_TAGS': return t('LABEL_SHARED_TAGS');
            // Legacy fallbacks for compatibility
            case 'KEYWORD_MATCH': return t('LABEL_KEYWORD_MATCH');
            case 'DEEP_SEMANTIC': return t('LABEL_DEEP_SEMANTIC');
            case 'CROSS_TOPIC': return t('LABEL_CROSS_TOPIC');
            case 'CROSS_FOLDER': return t('LABEL_CROSS_FOLDER');
            case 'UNLINKED': return t('LABEL_UNLINKED');
            case 'SERENDIPITY': return t('LABEL_SERENDIPITY');
            case 'RELEVANT': return t('LABEL_RELEVANT');
            case 'SHARED_CONCEPT': return t('LABEL_SHARED_CONCEPT');
            default: return code;
        }
    }

    private async handleJumpToNote(item: RadarCardItem, event?: MouseEvent | KeyboardEvent) {
        this.popoverPreview.hide();
        const file = this.plugin.app.vault.getAbstractFileByPath(item.path);
        if (!file || !(file instanceof TFile)) return;

        // 根据修饰键、Shift 键或中键决策打开位置
        const isShift = event ? Boolean((event as MouseEvent).shiftKey) : false;
        const paneType = Keymap.isModEvent(event as UserEvent);
        let leaf: WorkspaceLeaf | null = null;

        if (isShift || paneType === 'tab') {
            // Shift+点击 或 显式中键/Mod 点击：在新标签页打开
            leaf = this.plugin.app.workspace.getLeaf('tab');
        } else if (paneType) {
            leaf = this.plugin.app.workspace.getLeaf(paneType);
        } else {
            // 普通点击：在当前窗口打开。优先在当前活动的 Markdown 视图直接呈现
            const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView && activeView.leaf && !(activeView.leaf.view instanceof RadarView)) {
                leaf = activeView.leaf;
            } else {
                const existingLeaves = this.plugin.app.workspace.getLeavesOfType('markdown');
                const found = existingLeaves.find(l => (l.view as MarkdownView)?.file?.path === file.path);
                if (found) {
                    leaf = found;
                } else {
                    leaf = this.plugin.app.workspace.getLeaf(false);
                    if (!leaf || leaf.view instanceof RadarView) {
                        leaf = this.plugin.app.workspace.getLeaf('tab');
                    }
                }
            }
        }

        if (!leaf) {
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
        let link = `[[${item.title}]]`;
        const file = this.plugin.app.vault.getAbstractFileByPath(item.path);
        if (file instanceof TFile) {
            link = this.plugin.app.fileManager.generateMarkdownLink(file, view.file ? view.file.path : '');
        }
        editor.replaceRange(link, cursor);
        editor.setCursor({ line: cursor.line, ch: cursor.ch + link.length });
        editor.focus();
        new Notice(`${t('CARD_INSERT_LINK_NOTICE')}${link}`, 1500);
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

export { RadarView as WhispererView };
