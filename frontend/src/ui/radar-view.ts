import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import SemantixPlugin from '../main';
import { t } from '../i18n/helpers';

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
        return t('VIEW_RADAR_TITLE');
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
                text: t('MOBILE_HIBERNATING'),
                cls: "semantix-empty-text"
            });
            return;
        }
        
        const wrapper = container.createEl("div", { cls: "semantix-sidebar-wrapper" });
        
        // --- 状态指示灯 ---
        const statusArea = wrapper.createEl("div", { cls: "semantix-status-area" });

        const statusRow = statusArea.createEl("div", { cls: "semantix-status-row" });

        this.indicatorEl = statusRow.createEl("div", { cls: "semantix-status-indicator" });
        
        this.statusTextEl = statusRow.createEl("span", { 
            text: t('TESTING'), 
            cls: "semantix-status-text" 
        });

        this.indexStatusEl = statusArea.createEl("span", { 
            text: t('INDEXED_COUNT') + "-", 
            cls: "semantix-index-status" 
        });

        this.indexTimestampEl = statusArea.createEl("span", { 
            text: "", 
            cls: "semantix-index-timestamp" 
        });
        this.indexTimestampEl.style.display = "none";

        this.indexProgressRowEl = statusArea.createEl("div", { cls: "semantix-indexing-row" });

        this.indexProgressTextEl = this.indexProgressRowEl.createEl("span", { 
            text: t('INDEXING_PROGRESS') + "0 / 0", 
            cls: "semantix-index-status" 
        });

        const progressBar = this.indexProgressRowEl.createEl("div", { cls: "semantix-progress-bar" });
        this.indexProgressBarEl = progressBar.createEl("div", { cls: "semantix-progress-bar-fill" });

        // --- 孤岛雷达区 ---
        const contentArea = wrapper.createEl("div", { cls: "semantix-content-area" });
        contentArea.style.padding = "10px";

        const radarHeader = contentArea.createEl("div", { cls: "semantix-radar-header" });
        radarHeader.createEl("h4", { text: t('RADAR_HEADER'), cls: "semantix-radar-title" });
        
        const scanBtn = radarHeader.createEl("button", { text: t('SCAN') });
        scanBtn.addEventListener("click", () => {
            if (this.plugin.orphanRadar) {
                this.plugin.orphanRadar.scanAndRender();
            }
        });

        this.orphanContainer = contentArea.createEl("div", { cls: "semantix-orphan-results" });
        this.orphanContainer.style.transition = "opacity 150ms ease";
        this.orphanResultsEl = this.orphanContainer.createEl("div", { cls: "semantix-orphan-results-inner" });
        this.orphanResultsEl.createEl("p", { text: t('WAITING_INPUT'), cls: "semantix-empty-text" });

        this.updateIndexingProgress(this.plugin.getIndexingState());
        // 强制同步插件当前的连接状态，避免显示默认的 "Connecting..."
        this.updateStatus(this.plugin.getConnectionStatus());
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
            this.orphanResultsEl.createEl("p", { text: t('NO_ORPHANS'), cls: "semantix-empty-text" });
            return;
        }

        const listEl = this.orphanResultsEl.createEl("ul", { cls: "semantix-orphan-list" });

        for (const orphan of orphans) {
            const li = listEl.createEl("li", { cls: "semantix-orphan-row" });

            const titleRow = li.createEl("div", { cls: "semantix-orphan-header" });
            
            const link = titleRow.createEl("a", { text: this.getBasename(orphan.file.path) });
            link.style.fontWeight = "bold";
            link.addEventListener("click", (e) => {
                e.preventDefault();
                this.plugin.app.workspace.openLinkText(orphan.file.path, "", false);
            });

            const expandBtn = titleRow.createEl("span", { text: " 💡" });
            expandBtn.title = t('SCAN_FOR_REC');
            
            // 推荐结果展开容器
            const recsContainer = li.createEl("div", { cls: "semantix-recs-container" });
            recsContainer.style.display = "none";

            let loaded = false;
            titleRow.addEventListener("click", async (e) => {
                if (e.target === link) return;
                
                const isHidden = recsContainer.style.display === "none";
                recsContainer.style.display = isHidden ? "block" : "none";
                
                if (isHidden && !loaded) {
                    recsContainer.empty();
                    recsContainer.createEl("span", { text: t('LOADING') });
                    const results = await this.plugin.orphanRadar.getRecommendationsForOrphan(orphan.file as TFile);
                    recsContainer.empty();
                    
                    if (results.length === 0) {
                        recsContainer.createEl("span", { text: t('NO_RECS') });
                    } else {
                        for (const res of results) {
                            const recLi = recsContainer.createEl("div", { cls: "semantix-rec-item" });
                            
                            const recLink = recLi.createEl("a", { 
                                text: this.getBasename(res.path),
                                cls: "semantix-result-link"
                            });
                            recLink.href = "#";
                            recLink.addEventListener("click", (e) => {
                                e.preventDefault();
                                this.plugin.app.workspace.openLinkText(res.path, "", false);
                            });
                            
                            // 分数标签
                            const scoreEl = recLi.createEl("span", { 
                                text: res.score.toFixed(2),
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
            return t('SCORE_HIGH');
        }
        if (score >= thresholdMedium) {
            return t('SCORE_MED');
        }
        return t('SCORE_LOW');
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
    public updateStatus(status: 'connected' | 'disconnected' | 'syncing' | 'disabled') {
        if (!this.indicatorEl || !this.statusTextEl) return;

        this.indicatorEl.classList.remove('is-connected', 'is-disconnected', 'is-syncing', 'is-disabled');

        if (status === 'connected') {
            this.indicatorEl.classList.add('is-connected');
            this.statusTextEl.innerText = t('STATUS_CONNECTED');
        } else if (status === 'disconnected') {
            this.indicatorEl.classList.add('is-disconnected');
            this.statusTextEl.innerText = t('STATUS_DISCONNECTED');
        } else if (status === 'syncing') {
            this.indicatorEl.classList.add('is-syncing');
            this.statusTextEl.innerText = t('TESTING');
        } else if (status === 'disabled') {
            this.indicatorEl.classList.add('is-disabled');
            this.statusTextEl.innerText = t('STATUS_DISABLED');
        }
    }

    public updateIndexStatus(totalNotes: number, lastUpdated?: string) {
        if (!this.indexStatusEl) return;
        this.indexStatusEl.innerText = `${t('INDEXED_COUNT')}${totalNotes}`;
        if (this.indexTimestampEl) {
            if (lastUpdated) {
                this.indexTimestampEl.innerText = `${t('LAST_UPDATE')}${lastUpdated}`;
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
            const card = loading.createEl("div", { cls: "semantix-loading-card" });
            card.createEl("div", { cls: "semantix-skeleton-title" });
            card.createEl("div", { cls: "semantix-skeleton-text" });
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
            this.indexProgressTextEl.innerText = `${t('INDEXING_PROGRESS')}${current} / ${total}`;
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
