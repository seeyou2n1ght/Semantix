import { ItemView, WorkspaceLeaf } from 'obsidian';
import SemantixPlugin from '../main';
import { SearchResultItem } from '../api/types';

export const WHISPERER_VIEW_TYPE = "semantix-whisperer-view";

/**
 * 动态灵感视图 —— 独立侧边栏面板
 * 实时展示与当前编辑/阅读内容语义相关的历史笔记
 */
export class WhispererView extends ItemView {
    plugin: SemantixPlugin;
    private indicatorEl: HTMLElement;
    private statusTextEl: HTMLElement;
    private indexStatusEl: HTMLElement;
    private indexTimestampEl: HTMLElement;
    private indexProgressTextEl: HTMLElement;
    private indexProgressBarEl: HTMLElement;
    private indexProgressRowEl: HTMLElement;
    private whispererContainer: HTMLElement;
    private whispererResultsEl: HTMLElement;
    private loadingEl: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: SemantixPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() {
        return WHISPERER_VIEW_TYPE;
    }

    getDisplayText() {
        return "Whisperer 动态灵感";
    }

    getIcon() {
        return "message-circle";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        if (!container) return;

        container.empty();

        // 移动端休眠检测
        if (this.plugin.isMobileHibernating) {
            container.createEl("div", { cls: "semantix-hibernating" }).createEl("p", {
                text: "Semantix is hibernating on mobile. Enable it in settings if you want to run it here.",
                cls: "semantix-empty-text"
            });
            return;
        }
        
        const wrapper = container.createEl("div", { cls: "semantix-sidebar-wrapper" });
        
        // --- 状态指示灯 ---
        const statusArea = wrapper.createEl("div", { cls: "semantix-status-area" });
        statusArea.style.display = "block";
        statusArea.style.padding = "10px";
        statusArea.style.borderBottom = "1px solid var(--background-modifier-border)";

        const statusRow = statusArea.createEl("div");
        statusRow.style.display = "flex";
        statusRow.style.alignItems = "center";
        statusRow.style.gap = "8px";

        this.indicatorEl = statusRow.createEl("div");
        this.indicatorEl.style.width = "10px";
        this.indicatorEl.style.height = "10px";
        this.indicatorEl.style.borderRadius = "50%";
        this.indicatorEl.style.backgroundColor = "var(--color-yellow)";
        
        this.statusTextEl = statusRow.createEl("span", { text: "Connecting..." });
        this.statusTextEl.style.fontSize = "0.9em";
        this.statusTextEl.style.color = "var(--text-muted)";

        this.indexStatusEl = statusArea.createEl("span", { text: "Indexed: -" });
        this.indexStatusEl.style.fontSize = "0.8em";
        this.indexStatusEl.style.color = "var(--text-muted)";
        this.indexStatusEl.style.display = "block";
        this.indexStatusEl.style.marginTop = "4px";

        this.indexTimestampEl = statusArea.createEl("span", { text: "" });
        this.indexTimestampEl.style.fontSize = "0.75em";
        this.indexTimestampEl.style.color = "var(--text-muted)";
        this.indexTimestampEl.style.display = "none";

        this.indexProgressRowEl = statusArea.createEl("div", { cls: "semantix-indexing-row" });
        this.indexProgressRowEl.style.display = "none";
        this.indexProgressRowEl.style.flexDirection = "column";
        this.indexProgressRowEl.style.gap = "4px";
        this.indexProgressRowEl.style.marginTop = "6px";

        this.indexProgressTextEl = this.indexProgressRowEl.createEl("span", { text: "Indexing: 0 / 0" });
        this.indexProgressTextEl.style.fontSize = "0.8em";
        this.indexProgressTextEl.style.color = "var(--text-muted)";

        const progressBar = this.indexProgressRowEl.createEl("div", { cls: "semantix-progress-bar" });
        progressBar.style.height = "6px";
        progressBar.style.background = "var(--background-modifier-border)";
        progressBar.style.borderRadius = "999px";
        progressBar.style.overflow = "hidden";

        this.indexProgressBarEl = progressBar.createEl("div", { cls: "semantix-progress-bar-fill" });
        this.indexProgressBarEl.style.height = "100%";
        this.indexProgressBarEl.style.width = "0%";
        this.indexProgressBarEl.style.background = "var(--interactive-accent)";

        // --- 动态灵感结果区 ---
        const contentArea = wrapper.createEl("div", { cls: "semantix-content-area" });
        contentArea.style.padding = "10px";
        
        contentArea.createEl("h4", { text: "动态灵感" });
        
        this.whispererContainer = contentArea.createEl("div", { cls: "semantix-whisperer-results" });
        this.whispererContainer.style.transition = "opacity 150ms ease";
        this.whispererResultsEl = this.whispererContainer.createEl("div", { cls: "semantix-whisperer-results-inner" });
        this.whispererResultsEl.createEl("p", { 
            text: "Waiting for input...", 
            cls: "semantix-empty-text" 
        });

        this.updateIndexingProgress(this.plugin.getIndexingState());
    }

    async onClose() {
        // 清理
    }

    /**
     * 渲染 Whisperer 的检索结果
     */
    public renderWhispererResults(results: SearchResultItem[], colorSettings?: { colorThresholdHigh: number; colorThresholdMedium: number }) {
        if (!this.whispererContainer || !this.whispererResultsEl) return;
        this.clearLoading();
        this.whispererResultsEl.empty();

        if (results.length === 0) {
            this.whispererResultsEl.createEl("p", { 
                text: "没有找到相关度高的笔记。", 
                cls: "semantix-empty-text" 
            });
            return;
        }

        const defaultSettings = {
            colorThresholdHigh: this.plugin.settings.colorThresholdHigh || 0.85,
            colorThresholdMedium: this.plugin.settings.colorThresholdMedium || 0.75
        };
        const settings = colorSettings || defaultSettings;

        const listEl = this.whispererResultsEl.createEl("ul", { cls: "semantix-result-list" });
        listEl.style.paddingLeft = "20px";
        listEl.style.marginTop = "0px";

        for (const item of results) {
            const li = listEl.createEl("li");
            li.style.marginBottom = "8px";
            li.style.display = "flex";
            li.style.justifyContent = "space-between";
            li.style.alignItems = "flex-start";
            
            // 左侧：链接 + 摘要
            const leftDiv = li.createEl("div");
            leftDiv.style.flex = "1";
            
            const link = leftDiv.createEl("a", { text: this.getBasename(item.path) });
            link.href = "#";
            link.style.fontWeight = "bold";
            link.addEventListener("click", (e) => {
                e.preventDefault();
                this.plugin.app.workspace.openLinkText(item.path, "", false);
            });
            
            const snippetEl = leftDiv.createEl("div", { text: item.snippet });
            snippetEl.style.fontSize = "0.85em";
            snippetEl.style.color = "var(--text-muted)";
            snippetEl.style.marginTop = "4px";
            snippetEl.style.lineHeight = "1.4";
            
            // 右侧：相似度分数标签
            const scoreEl = li.createEl("span", { 
                text: `${Math.round(item.score * 100)}%`,
                cls: "semantix-score-badge"
            });
            scoreEl.style.fontSize = "0.75em";
            scoreEl.style.fontWeight = "bold";
            scoreEl.style.padding = "2px 6px";
            scoreEl.style.borderRadius = "4px";
            scoreEl.style.marginLeft = "8px";
            scoreEl.style.color = this.getScoreColor(item.score, settings.colorThresholdHigh, settings.colorThresholdMedium);
        }
    }

    private getScoreColor(score: number, thresholdHigh: number, thresholdMedium: number): string {
        if (score >= thresholdHigh) {
            return "var(--color-green)";
        }
        if (score >= thresholdMedium) {
            return "var(--color-blue)";
        }
        return "var(--color-yellow)";
    }

    private getBasename(path: string): string {
        const parts = path.split('/');
        const name = parts.length > 0 ? parts[parts.length - 1] : '';
        return (name || '').replace(/\.md$/, '');
    }

    /**
     * 更新状态指示灯
     */
    public updateStatus(status: 'connected' | 'disconnected' | 'syncing') {
        if (!this.indicatorEl || !this.statusTextEl) return;

        if (status === 'connected') {
            this.indicatorEl.style.backgroundColor = "var(--color-green)";
            this.statusTextEl.innerText = "Connected";
        } else if (status === 'disconnected') {
            this.indicatorEl.style.backgroundColor = "var(--color-red)";
            this.statusTextEl.innerText = "Disconnected";
        } else if (status === 'syncing') {
            this.indicatorEl.style.backgroundColor = "var(--color-yellow)";
            this.statusTextEl.innerText = "Syncing...";
        }
    }

    public updateIndexStatus(totalNotes: number, lastUpdated?: string) {
        if (!this.indexStatusEl) return;
        this.indexStatusEl.innerText = `Indexed: ${totalNotes}`;
        if (this.indexTimestampEl) {
            if (lastUpdated) {
                this.indexTimestampEl.innerText = `Last update: ${lastUpdated}`;
                this.indexTimestampEl.style.display = "block";
            } else {
                this.indexTimestampEl.innerText = "";
                this.indexTimestampEl.style.display = "none";
            }
        }
    }

    public showLoading() {
        if (!this.whispererContainer) return;
        this.whispererContainer.style.opacity = "0.6";
        if (this.loadingEl) return;

        const loading = this.whispererContainer.createEl("div", { cls: "semantix-loading" });
        loading.style.marginTop = "8px";

        for (let i = 0; i < 2; i += 1) {
            const card = loading.createEl("div");
            card.style.background = "var(--background-modifier-border)";
            card.style.borderRadius = "6px";
            card.style.padding = "10px";
            card.style.marginBottom = "8px";

            const title = card.createEl("div");
            title.style.height = "12px";
            title.style.width = "60%";
            title.style.background = "var(--background-modifier-border-hover)";
            title.style.borderRadius = "4px";
            title.style.marginBottom = "6px";

            const text = card.createEl("div");
            text.style.height = "10px";
            text.style.width = "100%";
            text.style.background = "var(--background-modifier-border-hover)";
            text.style.borderRadius = "4px";
        }

        this.loadingEl = loading;
    }

    public clearLoading() {
        if (!this.whispererContainer) return;
        if (this.loadingEl) {
            this.loadingEl.remove();
            this.loadingEl = null;
        }
        this.whispererContainer.style.opacity = "1";
    }

    public updateIndexingProgress(state: { active: boolean; current: number; total: number }) {
        if (!this.indexProgressTextEl || !this.indexProgressBarEl || !this.indexProgressRowEl) return;

        const total = Math.max(state.total, 0);
        const current = Math.max(state.current, 0);

        if (state.active && total > 0) {
            this.indexProgressRowEl.style.display = "flex";
            const percent = Math.min(100, Math.round((current / total) * 100));
            this.indexProgressTextEl.innerText = `Indexing: ${current} / ${total}`;
            this.indexProgressBarEl.style.width = `${percent}%`;
            this.indexProgressBarEl.style.background = "var(--interactive-accent)";
        } else {
            this.indexProgressRowEl.style.display = "none";
            this.indexProgressTextEl.innerText = "Indexing: 0 / 0";
            this.indexProgressBarEl.style.width = "0%";
            this.indexProgressBarEl.style.background = "var(--text-faint)";
        }
    }
}
