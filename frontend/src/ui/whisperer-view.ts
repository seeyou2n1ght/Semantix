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
    private indexStatusEl: HTMLElement;
    private whispererContainer: HTMLElement;

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

        // --- 动态灵感结果区 ---
        const contentArea = wrapper.createEl("div", { cls: "semantix-content-area" });
        contentArea.style.padding = "10px";
        
        contentArea.createEl("h4", { text: "动态灵感" });
        
        this.whispererContainer = contentArea.createEl("div", { cls: "semantix-whisperer-results" });
        this.whispererContainer.createEl("p", { 
            text: "Waiting for input...", 
            cls: "semantix-empty-text" 
        });
    }

    async onClose() {
        // 清理
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
            // 点击调用 Obsidian API 打开目标笔记
            link.addEventListener("click", (e) => {
                e.preventDefault();
                this.plugin.app.workspace.openLinkText(item.path, "", false);
            });
            
            li.createEl("div", { text: `Similarity: ${item.score.toFixed(4)}` }).style.fontSize = "0.8em";
            li.createEl("div", { text: item.snippet }).style.fontSize = "0.85em";
            li.createEl("div", { text: "---" }).style.color = "transparent";
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
