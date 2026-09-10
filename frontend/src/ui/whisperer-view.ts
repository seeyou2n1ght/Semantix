import { ItemView, WorkspaceLeaf, TFile, MarkdownView } from 'obsidian';
import SemantixPlugin from '../main';
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
    private relatedContainerEl!: HTMLElement;
    private discoverContainerEl!: HTMLElement;
    private loadingEl: HTMLElement | null = null;
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

        // 隐式 Focus：当前文件与 Heading 面包屑
        this.contextBreadcrumbEl = topBar.createEl("div", {
            cls: "semantix-context-breadcrumb",
            text: "Semantix"
        });

        // 临时 Note Mode 扫描按钮
        this.scanNoteBtnEl = topBar.createEl("button", {
            cls: "semantix-btn-scan-note",
            text: "扫描整篇"
        });
        this.scanNoteBtnEl.addEventListener("click", () => {
            this.plugin.whisperer.triggerNoteScan();
        });

        // --- 主双流卡片区 ---
        const contentArea = wrapper.createEl("div", { cls: "semantix-content-area" });

        // 1. Related 区域
        const relatedSection = contentArea.createEl("div", { cls: "semantix-section" });
        relatedSection.createEl("div", { cls: "semantix-section-header", text: "高度相关 · Related" });
        this.relatedContainerEl = relatedSection.createEl("div", { cls: "semantix-card-list" });
        this.relatedContainerEl.createEl("p", {
            text: t('WAITING_INPUT'),
            cls: "semantix-empty-text"
        });

        // 2. Discover 区域
        const discoverSection = contentArea.createEl("div", { cls: "semantix-section" });
        discoverSection.createEl("div", { cls: "semantix-section-header", text: "发现 · Discover" });
        this.discoverContainerEl = discoverSection.createEl("div", { cls: "semantix-card-list" });
        this.discoverContainerEl.createEl("p", {
            text: "写作时将自动发掘跨主题关联与未链接笔记...",
            cls: "semantix-empty-text"
        });

        this.updateStatus(this.plugin.getConnectionStatus());
    }

    async onClose() {
        this.popoverPreview.destroy();
    }

    public updateContextBreadcrumb(filePath?: string, heading?: string) {
        if (!this.contextBreadcrumbEl) return;
        if (!filePath) {
            this.contextBreadcrumbEl.setText("Semantix");
            return;
        }
        const fileName = filePath.split('/').pop()?.replace(/\.md$/, '') || filePath;
        const headingPart = heading ? ` > ${heading}` : "";
        this.contextBreadcrumbEl.setText(`${fileName}${headingPart}`);
    }

    public renderRadarResults(
        related: RadarCardItem[],
        discover: RadarCardItem[],
        contextPath?: string,
        contextHeading?: string
    ) {
        this.clearLoading();
        this.updateContextBreadcrumb(contextPath, contextHeading);

        // 渲染 Related
        this.renderCardList(this.relatedContainerEl, related, "暂无高度相关的已有笔记");

        // 渲染 Discover
        this.renderCardList(this.discoverContainerEl, discover, "暂无具有新颖度的意外关联");
    }

    private renderCardList(container: HTMLElement, items: RadarCardItem[], emptyText: string) {
        if (!container) return;
        container.empty();

        if (items.length === 0) {
            container.createEl("p", { text: emptyText, cls: "semantix-empty-text" });
            return;
        }

        for (const item of items) {
            const card = container.createEl("div", { cls: "semantix-radar-card" });

            // 标题行与匹配分
            const titleRow = card.createEl("div", { cls: "semantix-card-title-row" });
            titleRow.createEl("span", { cls: "semantix-card-title", text: item.title });

            // 摘要行 (紧凑两行)
            card.createEl("p", { cls: "semantix-card-snippet", text: item.snippet });

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

            // 悬浮 Popover 预览 (防自身高度形变导致布局抖动)
            card.addEventListener("mouseenter", () => {
                this.popoverPreview.show(card, item);
            });
            card.addEventListener("mouseleave", () => {
                this.popoverPreview.scheduleHide();
            });

            // 点击原位打开并定位段落
            card.addEventListener("click", () => {
                this.handleJumpToNote(item);
            });
        }
    }

    private translateLabel(code: string): string {
        switch (code) {
            case 'KEYWORD_MATCH': return '关键词匹配';
            case 'DEEP_SEMANTIC': return '深度相关';
            case 'SAME_FOLDER': return '同目录';
            case 'SHARED_TAGS': return '标签关联';
            case 'CROSS_TOPIC': return '跨主题';
            case 'CROSS_FOLDER': return '跨目录';
            case 'UNLINKED': return '未建立链接';
            case 'SERENDIPITY': return '潜在延伸';
            default: return code;
        }
    }

    private async handleJumpToNote(item: RadarCardItem) {
        const file = this.plugin.app.vault.getAbstractFileByPath(item.path);
        if (!file || !(file instanceof TFile)) return;

        // 在主编辑区原位打开（支持 Obsidian 历史后退）
        const leaf = this.plugin.app.workspace.getLeaf(false);
        await leaf.openFile(file);

        // 定位匹配段落并滚动高亮
        if (leaf.view instanceof MarkdownView && item.snippet) {
            const editor = leaf.view.editor;
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

    private handleInsertLink(item: RadarCardItem) {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        const editor = view.editor;
        const cursor = editor.getCursor();
        const link = `[[${item.title}]]`;
        editor.replaceRange(link, cursor);
        editor.setCursor({ line: cursor.line, ch: cursor.ch + link.length });
    }

    public showLoading() {
        if (!this.loadingEl && this.containerEl) {
            this.loadingEl = this.containerEl.createEl("div", { cls: "semantix-loading-bar" });
        }
    }

    public clearLoading() {
        if (this.loadingEl) {
            this.loadingEl.remove();
            this.loadingEl = null;
        }
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

    public updateIndexingProgress(_state: unknown) {
        // 保留接口兼容性
    }

    public updateIndexStatus(_totalNotes: number, _lastUpdated?: string) {
        // 保留接口兼容性
    }
}
