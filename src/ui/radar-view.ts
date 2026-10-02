import { ItemView, WorkspaceLeaf, TFile, MarkdownView, Notice, HoverParent, HoverPopover, Keymap } from 'obsidian';
import SemantixPlugin, { IndexingState } from '../main';
import { RadarCardItem } from '../api/types';
import { t } from '../i18n/helpers';
import { PopoverPreview } from './popover-preview';
import { findSourceLines } from '../utils/source-location';

export const WHISPERER_VIEW_TYPE = "semantix-whisperer-view";
export const RADAR_VIEW_TYPE = WHISPERER_VIEW_TYPE;

export class RadarView extends ItemView implements HoverParent {
    plugin: SemantixPlugin;
    hoverPopover: HoverPopover | null = null;
    private indicatorEl!: HTMLElement;
    private statusTextEl!: HTMLElement;
    private contextBreadcrumbEl!: HTMLElement;
    private scanNoteBtnEl!: HTMLButtonElement;
    private scanBarEl!: HTMLElement;
    private searchErrorEl!: HTMLElement;
    private searchInfoEl!: HTMLElement;
    private isSearching = false;
    private isScanningNote = false;
    private renderedItems = new WeakMap<HTMLElement, string>();
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
            if (this.isScanningNote) this.plugin.radar.cancelSearch();
            else void this.plugin.radar.triggerNoteScan();
        });

        // 实时检索微光扫描条 (常驻顶栏下方，检索时优雅渐显，无 DOM 重排跳动)
        this.scanBarEl = wrapper.createDiv({ cls: "semantix-scan-bar" });
        this.searchErrorEl = wrapper.createDiv({ cls: "semantix-search-error is-hidden", attr: { role: "alert" } });
        this.searchInfoEl = wrapper.createDiv({ cls: "semantix-search-info is-hidden", attr: { role: "status" } });

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
        _queryText?: string,
        warnings: string[] = [],
        partial = false
    ) {
        if (!partial) this.clearLoading();
        this.searchErrorEl?.addClass("is-hidden");
        this.relatedContainerEl?.removeClass("is-stale");
        this.discoverContainerEl?.removeClass("is-stale");
        this.updateContextBreadcrumb(contextPath, contextHeading);
        if (this.searchInfoEl) {
            const messages = warnings.length ? [t('SEARCH_DEGRADED')] : [];
            if (partial) messages.unshift(t('SEARCH_PARTIAL'));
            this.searchInfoEl.setText(messages.join(' '));
            this.searchInfoEl.toggleClass('is-hidden', messages.length === 0);
        }

        // 渲染 Related
        this.renderCardList(this.relatedContainerEl, related, t('STREAM_RELATED_EMPTY'));

        // 渲染 Discover
        this.renderCardList(this.discoverContainerEl, discover, t('STREAM_DISCOVER_EMPTY'));
    }

    public showSearchError(retry: () => void) {
        if (!this.searchErrorEl) return;
        this.searchInfoEl?.addClass('is-hidden');
        this.searchErrorEl.empty();
        this.searchErrorEl.createSpan({ text: t('SEARCH_FAILED') });
        const button = this.searchErrorEl.createEl('button', { text: t('SEARCH_RETRY') });
        button.addEventListener('click', retry);
        this.searchErrorEl.removeClass('is-hidden');
        this.relatedContainerEl.addClass('is-stale');
        this.discoverContainerEl.addClass('is-stale');
    }

    public resetForContext() {
        if (this.relatedContainerEl) this.renderedItems.delete(this.relatedContainerEl);
        if (this.discoverContainerEl) this.renderedItems.delete(this.discoverContainerEl);
        this.searchInfoEl?.addClass('is-hidden');
        this.searchErrorEl?.addClass('is-hidden');
        this.relatedContainerEl?.removeClass('is-stale');
        this.discoverContainerEl?.removeClass('is-stale');
        this.relatedContainerEl?.empty();
        this.discoverContainerEl?.empty();
        this.relatedContainerEl?.createEl('p', { text: t('WAITING_INPUT'), cls: 'semantix-empty-text' });
        this.discoverContainerEl?.createEl('p', { text: t('DISCOVER_INITIAL'), cls: 'semantix-empty-text' });
    }

    private renderHighlightedSnippet(container: HTMLElement, snippet: string, keywords: string[]) {
        const p = container.createEl("p", { cls: "semantix-card-snippet" });
        if (!keywords || keywords.length === 0) {
            p.setText(snippet);
            return;
        }

        const escaped = [...new Set(keywords)]
            .filter(k => k.length >= 2)
            .sort((a, b) => b.length - a.length)
            .map(k => {
                const left = /^[a-zA-Z0-9_]/.test(k) ? '(?<![a-zA-Z0-9_])' : '';
                const right = /[a-zA-Z0-9_]$/.test(k) ? '(?![a-zA-Z0-9_])' : '';
                return left + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + right;
            });
        if (!escaped.length) {
            p.setText(snippet);
            return;
        }
        const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
        const parts = snippet.split(regex);

        for (const [index, part] of parts.entries()) {
            if (!part) continue;
            if (index % 2 === 1) {
                p.createEl("mark", { cls: "semantix-highlight", text: part });
            } else {
                p.appendText(part);
            }
        }
    }

    private renderCardList(container: HTMLElement, items: RadarCardItem[], emptyText: string) {
        if (!container) return;
        const signature = JSON.stringify([items, emptyText]);
        if (this.renderedItems.get(container) === signature) return;
        this.renderedItems.set(container, signature);
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
                let tierText = "●●○";
                let tierCls = "mid";
                let tierLabel = t('SCORE_LEVEL_MID');
                if (item.score >= 0.75) {
                    tierText = "●●●";
                    tierCls = "high";
                    tierLabel = t('SCORE_LEVEL_HIGH');
                } else if (item.score < 0.50) {
                    tierText = "●○○";
                    tierCls = "low";
                    tierLabel = t('SCORE_LEVEL_LOW');
                }
                rightGroup.createSpan({
                    cls: `semantix-card-score mod-${tierCls}`,
                    text: tierText,
                    attr: { "title": `${tierLabel} · ${t('SCORE_RELATIVE_HINT')}`, "aria-label": tierLabel }
                });
            }

            // 内容行 (摘要行，高亮关键词与自适应降噪)
            this.renderHighlightedSnippet(card, item.snippet, item.matched_terms || []);

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
            card.addEventListener("focus", () => {
                this.popoverPreview.scheduleShow(card, item, this.plugin.app, 150);
            });
            card.addEventListener("blur", () => {
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
                if (e.key === "Escape") {
                    this.popoverPreview.hide();
                    return;
                }
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
        const paneType = Keymap.isModEvent(event);
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
            const source = item.source_text || item.snippet.replace(/^\.\.\.|\.\.\.$/g, '').trim();
            const location = findSourceLines(editor.getValue(), source);
            if (location) {
                editor.setCursor({ line: location.start, ch: 0 });
                editor.scrollIntoView({ from: { line: location.start, ch: 0 },
                    to: { line: location.end, ch: editor.getLine(location.end).length } }, true);
            } else {
                new Notice(t('MATCH_POSITION_UNAVAILABLE'), 2500);
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
        this.isSearching = true;
        this.searchErrorEl?.addClass('is-hidden');
        if (this.scanNoteBtnEl) this.scanNoteBtnEl.disabled = false;
        if (this.scanBarEl) {
            this.scanBarEl.addClass("is-scanning");
        }
        if (this.indicatorEl && this.statusTextEl) {
            this.indicatorEl.className = 'semantix-status-indicator status-scanning';
            this.statusTextEl.setText(t('STATUS_SCANNING'));
        }
    }

    public updateNoteScanProgress(current: number, total: number) {
        this.isScanningNote = true;
        this.statusTextEl?.setText(t('SCAN_NOTE_PROGRESS', { current, total }));
        if (this.scanNoteBtnEl) {
            this.scanNoteBtnEl.disabled = false;
            this.scanNoteBtnEl.setText(t('SCAN_STOP'));
            this.scanNoteBtnEl.setAttribute('aria-label', t('SCAN_STOP'));
            this.scanNoteBtnEl.setAttribute('title', t('SCAN_STOP'));
        }
    }

    public showScanCancelled() {
        this.clearLoading();
        this.searchInfoEl?.setText(t('SCAN_CANCELLED'));
        this.searchInfoEl?.removeClass('is-hidden');
        this.relatedContainerEl?.addClass('is-stale');
        this.discoverContainerEl?.addClass('is-stale');
    }

    public clearLoading() {
        this.isSearching = false;
        this.isScanningNote = false;
        if (this.scanNoteBtnEl) {
            this.scanNoteBtnEl.disabled = false;
            this.scanNoteBtnEl.setText(t('BTN_SCAN_NOTE'));
            this.scanNoteBtnEl.setAttribute('aria-label', t('BTN_SCAN_NOTE'));
            this.scanNoteBtnEl.setAttribute('title', t('BTN_SCAN_NOTE_TOOLTIP'));
        }
        if (this.scanBarEl) {
            this.scanBarEl.removeClass("is-scanning");
        }
        this.updateStatus(this.plugin.getConnectionStatus());
    }

    public updateStatus(status: 'connected' | 'disconnected' | 'syncing' | 'disabled') {
        if (this.isSearching && status === 'connected') return;
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
