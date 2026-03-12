import { ItemView, WorkspaceLeaf } from 'obsidian';
import SemantixPlugin from '../main';
import { SearchResultItem } from '../api/types';

export const RADAR_VIEW_TYPE = "semantix-radar-view";

/**
 * 孤岛笔记雷达视图 —— 独立侧边栏面板
 * 发现无链接笔记并推荐潜在连接
 */
export class RadarView extends ItemView {
    plugin: SemantixPlugin;
    private indicatorEl: HTMLElement;
    private indexStatusEl: HTMLElement;
    private orphanContainer: HTMLElement;

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
        statusArea.style.display = "flex";
        statusArea.style.alignItems = "center";
        statusArea.style.padding = "10px";
        statusArea.style.borderBottom = "1px solid var(--background-modifier-border)";

        this.indicatorEl = statusArea.createEl("div");
        this.indicatorEl.style.width = "10px";
        this.indicatorEl.style.height = "10px";
        this.indicatorEl.style.borderRadius = "50%";
        this.indicatorEl.style.marginRight = "10px";
        this.indicatorEl.style.backgroundColor = "var(--color-yellow)";
        
        const statusText = statusArea.createEl("span", { text: "Connecting..." });
        statusText.style.fontSize = "0.9em";
        statusText.style.color = "var(--text-muted)";

        this.indexStatusEl = statusArea.createEl("span", { text: "Indexed: -" });
        this.indexStatusEl.style.fontSize = "0.8em";
        this.indexStatusEl.style.marginLeft = "10px";
        this.indexStatusEl.style.color = "var(--text-muted)";

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
        this.orphanContainer.createEl("p", { text: "Click scan to find orphans.", cls: "semantix-empty-text" });
    }

    async onClose() {
        // 清理
    }

    /**
     * 渲染孤岛笔记列表
     */
    public renderOrphans(orphans: { file: { path: string; basename: string }; linkCount: number }[]) {
        if (!this.orphanContainer) return;
        this.orphanContainer.empty();

        if (orphans.length === 0) {
            this.orphanContainer.createEl("p", { text: "没有发现孤岛笔记 🎉", cls: "semantix-empty-text" });
            return;
        }

        const listEl = this.orphanContainer.createEl("ul", { cls: "semantix-orphan-list" });
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
                    const results = await this.plugin.orphanRadar.getRecommendationsForOrphan(orphan.file as any);
                    recsContainer.empty();
                    
                    if (results.length === 0) {
                        recsContainer.createEl("span", { text: "No recommendations." });
                    } else {
                        for (const res of results) {
                            const recLi = recsContainer.createEl("div");
                            recLi.style.marginBottom = "4px";
                            recLi.style.fontSize = "0.85em";
                            
                            const recLink = recLi.createEl("a", { text: this.getBasename(res.path) });
                            recLink.href = "#";
                            recLink.addEventListener("click", (e) => {
                                e.preventDefault();
                                this.plugin.app.workspace.openLinkText(res.path, "", false);
                            });
                            recLi.createEl("span", { text: ` (${res.score.toFixed(2)})` });
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

    /**
     * 更新状态指示灯
     */
    public updateStatus(status: 'connected' | 'disconnected' | 'syncing') {
        if (!this.indicatorEl) return;
        
        const statusTextEl = this.indicatorEl.nextSibling as HTMLElement;

        if (status === 'connected') {
            this.indicatorEl.style.backgroundColor = "var(--color-green)";
            statusTextEl.innerText = "Connected";
        } else if (status === 'disconnected') {
            this.indicatorEl.style.backgroundColor = "var(--color-red)";
            statusTextEl.innerText = "Disconnected";
        } else if (status === 'syncing') {
            this.indicatorEl.style.backgroundColor = "var(--color-yellow)";
            statusTextEl.innerText = "Syncing...";
        }
    }

    public updateIndexStatus(totalNotes: number, lastUpdated?: string) {
        if (!this.indexStatusEl) return;
        const suffix = lastUpdated ? ` · ${lastUpdated}` : '';
        this.indexStatusEl.innerText = `Indexed: ${totalNotes}${suffix}`;
    }
}
