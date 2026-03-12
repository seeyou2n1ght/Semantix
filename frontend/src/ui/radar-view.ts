import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import SemantixPlugin from '../main';

export const RADAR_VIEW_TYPE = "semantix-radar-view";

/**
 * 孤岛笔记雷达视图 —— 独立侧边栏面板
 * 发现无链接笔记并推荐潜在连接
 */
export class RadarView extends ItemView {
    plugin: SemantixPlugin;
    private indicatorEl: HTMLElement;
    private statusTextEl: HTMLElement;
    private indexStatusEl: HTMLElement;
    private indexTimestampEl: HTMLElement;
    private indexProgressTextEl: HTMLElement;
    private indexProgressBarEl: HTMLElement;
    private indexProgressRowEl: HTMLElement;
    private orphanContainer: HTMLElement;
    private orphanResultsEl: HTMLElement;
    private loadingEl: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: SemantixPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() {
        return RADAR_VIEW_TYPE;
    }

    getDisplayText() {
        return "Orphan Radar 孤岛雷达";
    }

    getIcon() {
        return "radar";
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

        // --- 孤岛雷达区 ---
        const contentArea = wrapper.createEl("div", { cls: "semantix-content-area" });
        contentArea.style.padding = "10px";

        const radarHeader = contentArea.createEl("div", { cls: "semantix-radar-header" });
        radarHeader.style.display = "flex";
        radarHeader.style.justifyContent = "space-between";
        radarHeader.style.alignItems = "center";
        radarHeader.createEl("h4", { text: "孤岛雷达", cls: "semantix-radar-title" });
        
        const scanBtn = radarHeader.createEl("button", { text: "扫描" });
        scanBtn.addEventListener("click", () => {
            if (this.plugin.orphanRadar) {
                this.plugin.orphanRadar.scanAndRender();
            }
        });

        this.orphanContainer = contentArea.createEl("div", { cls: "semantix-orphan-results" });
        this.orphanContainer.style.transition = "opacity 150ms ease";
        this.orphanResultsEl = this.orphanContainer.createEl("div", { cls: "semantix-orphan-results-inner" });
        this.orphanResultsEl.createEl("p", { text: "Click scan to find orphans.", cls: "semantix-empty-text" });

        this.updateIndexingProgress(this.plugin.getIndexingState());
    }

    async onClose() {
        // 清理
    }

    /**
     * 渲染孤岛笔记列表
     */
    public renderOrphans(orphans: { file: { path: string; basename: string }; linkCount: number }[]) {
        if (!this.orphanContainer || !this.orphanResultsEl) return;
        this.clearLoading();
        this.orphanResultsEl.empty();

        if (orphans.length === 0) {
            this.orphanResultsEl.createEl("p", { text: "没有发现孤岛笔记 🎉", cls: "semantix-empty-text" });
            return;
        }

        const listEl = this.orphanResultsEl.createEl("ul", { cls: "semantix-orphan-list" });
        listEl.style.paddingLeft = "20px";

        for (const orphan of orphans) {
            const li = listEl.createEl("li");
            li.style.marginBottom = "5px";

            const titleRow = li.createEl("div");
            titleRow.style.display = "flex";
            titleRow.style.justifyContent = "space-between";
            titleRow.style.cursor = "pointer";
            
            const link = titleRow.createEl("a", { text: this.getBasename(orphan.file.path) });
            link.style.fontWeight = "bold";
            link.addEventListener("click", (e) => {
                e.preventDefault();
                this.plugin.app.workspace.openLinkText(orphan.file.path, "", false);
            });

            const expandBtn = titleRow.createEl("span", { text: " 💡" });
            expandBtn.title = "Find recommendations";
            
            // 推荐结果展开容器
            const recsContainer = li.createEl("div");
            recsContainer.style.display = "none";
            recsContainer.style.marginTop = "5px";
            recsContainer.style.paddingLeft = "10px";
            recsContainer.style.borderLeft = "2px solid var(--background-modifier-border)";

            let loaded = false;
            titleRow.addEventListener("click", async (e) => {
                if (e.target === link) return;
                
                const isHidden = recsContainer.style.display === "none";
                recsContainer.style.display = isHidden ? "block" : "none";
                
                if (isHidden && !loaded) {
                    recsContainer.empty();
                    recsContainer.createEl("span", { text: "Loading..." });
                    const results = await this.plugin.orphanRadar.getRecommendationsForOrphan(orphan.file as TFile);
                    recsContainer.empty();
                    
                    if (results.length === 0) {
                        recsContainer.createEl("span", { text: "No recommendations." });
                    } else {
                        for (const res of results) {
                            const recLi = recsContainer.createEl("div");
                            recLi.style.marginBottom = "4px";
                            recLi.style.fontSize = "0.85em";
                            recLi.style.display = "flex";
                            recLi.style.justifyContent = "space-between";
                            
                            const recLink = recLi.createEl("a", { text: this.getBasename(res.path) });
                            recLink.href = "#";
                            recLink.addEventListener("click", (e) => {
                                e.preventDefault();
                                this.plugin.app.workspace.openLinkText(res.path, "", false);
                            });
                            
                            // 分数标签
                            const scoreEl = recLi.createEl("span", { 
                                text: `${Math.round(res.score * 100)}%`,
                                cls: "semantix-score-badge"
                            });
                            scoreEl.style.fontWeight = "bold";
                            scoreEl.style.color = this.getScoreColor(res.score);
                            scoreEl.title = this.getScoreTooltip(res.score);
                        }
                    }
                    loaded = true;
                }
            });
        }
    }

    private getBasename(path: string): string {
        const parts = path.split('/');
        const name = parts.length > 0 ? parts[parts.length - 1] : '';
        return (name || '').replace(/\.md$/, '');
    }

    private getScoreTooltip(score: number): string {
        const thresholdHigh = this.plugin.settings.colorThresholdHigh || 0.85;
        const thresholdMedium = this.plugin.settings.colorThresholdMedium || 0.75;
        
        if (score >= thresholdHigh) {
            return "高度相关：内容主题高度一致";
        }
        if (score >= thresholdMedium) {
            return "相关：内容有较多共同点";
        }
        return "可能相关：内容有一定关联";
    }

    private getScoreColor(score: number): string {
        const thresholdHigh = this.plugin.settings.colorThresholdHigh || 0.85;
        const thresholdMedium = this.plugin.settings.colorThresholdMedium || 0.75;
        
        if (score >= thresholdHigh) {
            return "var(--color-green)";
        }
        if (score >= thresholdMedium) {
            return "var(--color-blue)";
        }
        return "var(--color-yellow)";
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
        if (!this.orphanContainer) return;
        this.orphanContainer.style.opacity = "0.6";
        if (this.loadingEl) return;

        const loading = this.orphanContainer.createEl("div", { cls: "semantix-loading" });
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
        if (!this.orphanContainer) return;
        if (this.loadingEl) {
            this.loadingEl.remove();
            this.loadingEl = null;
        }
        this.orphanContainer.style.opacity = "1";
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
