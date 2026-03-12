import { ItemView, WorkspaceLeaf } from 'obsidian';
import SemantixPlugin from '../main';
import { SearchResultItem } from '../api/types';

export const SEMANTIX_SIDEBAR_VIEW = "semantix-sidebar-view";

export class SemantixSidebarView extends ItemView {
    plugin: SemantixPlugin;
    private indicatorEl: HTMLElement;
    private indexStatusEl: HTMLElement;
    private whispererContainer: HTMLElement;
    private orphanContainer: HTMLElement;

    constructor(leaf: WorkspaceLeaf, plugin: SemantixPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() {
        return SEMANTIX_SIDEBAR_VIEW;
    }

    getDisplayText() {
        return "Semantix 语义雷达";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        if (!container) return;

        container.empty();

        if (this.plugin.isMobileHibernating) {
            container.createEl("div", { cls: "semantix-hibernating" }).createEl("p", {
                text: "Semantix is hibernating on mobile. Enable it in settings if you want to run it here.",
                cls: "semantix-empty-text"
            });
            return;
        }
        
        // --- 整体容器 ---
        const wrapper = container.createEl("div", { cls: "semantix-sidebar-wrapper" });
        
        // --- 1. 状态指示灯区域 ---
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
        this.indicatorEl.style.backgroundColor = "var(--color-yellow)"; // Default syncing/connecting
        
        const statusText = statusArea.createEl("span", { text: "Connecting..." });
        statusText.style.fontSize = "0.9em";
        statusText.style.color = "var(--text-muted)";

        this.indexStatusEl = statusArea.createEl("span", { text: "Indexed: -" });
        this.indexStatusEl.style.fontSize = "0.8em";
        this.indexStatusEl.style.marginLeft = "10px";
        this.indexStatusEl.style.color = "var(--text-muted)";

        // --- 2. 动态面板区 ---
        const contentArea = wrapper.createEl("div", { cls: "semantix-content-area" });
        contentArea.style.padding = "10px";
        
        contentArea.createEl("h4", { text: "Whisperer 动态灵感" });
        
        this.whispererContainer = contentArea.createEl("div", { cls: "semantix-whisperer-results" });
        this.whispererContainer.createEl("p", { 
            text: "Waiting for input...", 
            cls: "semantix-empty-text" 
        });
        
        // 预留孤岛笔记容器
        const radarHeader = contentArea.createEl("div", { cls: "semantix-radar-header" });
        radarHeader.style.display = "flex";
        radarHeader.style.justifyContent = "space-between";
        radarHeader.style.alignItems = "center";
        radarHeader.createEl("h4", { text: "Orphan Notes 雷达", cls: "semantix-radar-title" });
        
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
        // Cleanup if necessary
    }

    /**
     * 渲染孤岛笔记列表
     */
    public renderOrphans(orphans: any[]) { // Using any to avoid importing OrphanNode if lazy, but let's be clean
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

            // Title
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
            
            // Container for recs
            const recsContainer = li.createEl("div");
            recsContainer.style.display = "none";
            recsContainer.style.marginTop = "5px";
            recsContainer.style.paddingLeft = "10px";
            recsContainer.style.borderLeft = "2px solid var(--background-modifier-border)";

            // Expand toggle logic
            let loaded = false;
            titleRow.addEventListener("click", async (e) => {
                if (e.target === link) return; // let link do its thing
                
                const isHidden = recsContainer.style.display === "none";
                recsContainer.style.display = isHidden ? "block" : "none";
                
                if (isHidden && !loaded) {
                    recsContainer.empty();
                    recsContainer.createEl("span", { text: "Loading..." });
                    // Fetch
                    const results = await this.plugin.orphanRadar.getRecommendationsForOrphan(orphan.file);
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

    /**
     * 渲染 Whisperer 的检索结果
     */
    public renderWhispererResults(results: SearchResultItem[]) {
        if (!this.whispererContainer) return;
        this.whispererContainer.empty();

        if (results.length === 0) {
            this.whispererContainer.createEl("p", { 
                text: "没有找到相关度高的笔记。", 
                cls: "semantix-empty-text" 
            });
            return;
        }

        const listEl = this.whispererContainer.createEl("ul", { cls: "semantix-result-list" });
        listEl.style.paddingLeft = "20px";
        listEl.style.marginTop = "0px";

        for (const item of results) {
            const li = listEl.createEl("li");
            li.style.marginBottom = "8px";
            
            const link = li.createEl("a", { text: this.getBasename(item.path) });
            link.href = "#";
            link.style.fontWeight = "bold";
            // 绑定点击事件，调用 obsidian api 打开链接
            link.addEventListener("click", (e) => {
                e.preventDefault();
                this.plugin.app.workspace.openLinkText(item.path, "", false);
            });
            
            li.createEl("div", { text: `Similarity: ${item.score.toFixed(4)}` }).style.fontSize = "0.8em";
            li.createEl("div", { text: item.snippet }).style.fontSize = "0.85em";
            li.createEl("div", { text: "---" }).style.color = "transparent"; // separator visual spacing
        }
    }

    private getBasename(path: string): string {
        const parts = path.split('/');
        const name = parts.length > 0 ? parts[parts.length - 1] : '';
        return (name || '').replace(/\.md$/, '');
    }

    /**
     * 更新侧边栏状态指示灯
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
