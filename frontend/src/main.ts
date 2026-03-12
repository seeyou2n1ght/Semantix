import { Plugin, Notice, WorkspaceLeaf, TAbstractFile, MarkdownView, Platform } from 'obsidian';
import { SemantixSettings, DEFAULT_SETTINGS, SemantixSettingTab } from "./settings";
import { ApiClient } from './api/client';
import { IndexDocument } from './api/types';
import { WhispererView, WHISPERER_VIEW_TYPE } from './ui/whisperer-view';
import { RadarView, RADAR_VIEW_TYPE } from './ui/radar-view';
import { SyncManager } from './core/sync';
import { Whisperer } from './core/whisperer';
import { OrphanRadar } from './core/radar';
import { cleanMarkdown } from './utils/markdown';

export type IndexingState = {
    active: boolean;
    current: number;
    total: number;
    label?: string;
};

export default class SemantixPlugin extends Plugin {
    settings: SemantixSettings;
    apiClient: ApiClient;
    syncManager: SyncManager;
    whisperer: Whisperer;
    orphanRadar: OrphanRadar;
    vaultId: string;
    isMobileHibernating: boolean = false;
    private healthTimer: number | null = null;
    private indexingState: IndexingState = { active: false, current: 0, total: 0 };
    private isFullIndexing: boolean = false;
    private fullIndexCancelRequested: boolean = false;

    async onload() {
        // 1. 加载配置
        await this.loadSettings();
        this.vaultId = this.computeVaultId();
        this.updateMobileMode();

        // 2. 初始化 API Client & Engines
        this.apiClient = new ApiClient(this.settings, this.vaultId);
        this.syncManager = new SyncManager(this);
        this.whisperer = new Whisperer(this);
        this.orphanRadar = new OrphanRadar(this);

        // 3. 注册配置面板
        this.addSettingTab(new SemantixSettingTab(this.app, this));

        // 4. 注册两个独立的 Sidebar View
        this.registerView(
            WHISPERER_VIEW_TYPE,
            (leaf) => new WhispererView(leaf, this)
        );
        this.registerView(
            RADAR_VIEW_TYPE,
            (leaf) => new RadarView(leaf, this)
        );

        // 5. Ribbon Icons —— 分别打开各自的视图
        this.addRibbonIcon('message-circle', 'Semantix: 动态灵感', () => {
            this.activateWhispererView();
        });
        this.addRibbonIcon('radar', 'Semantix: 孤岛雷达', () => {
            this.activateRadarView();
        });

        // 6. 全局命令
        this.addCommand({
            id: 'semantix-open-whisperer',
            name: 'Semantix: 打开动态灵感面板 (Open Whisperer)',
            callback: () => {
                this.activateWhispererView();
            }
        });
        this.addCommand({
            id: 'semantix-scan-orphans',
            name: 'Semantix: 扫描并分析孤岛笔记 (Scan Orphan Notes)',
            callback: () => {
                this.activateRadarView();
                this.orphanRadar.scanAndRender();
            }
        });

        // 7. 工作区就绪后打开视图并探活
        this.app.workspace.onLayoutReady(() => {
            this.activateWhispererView();
            if (!this.isMobileHibernating) {
                this.checkConnection();
                this.startHealthTimer();
            }
        });

        // 8. 注册增量同步与 Whisperer 事件（移动端禁用时不注册）
        if (!this.isMobileHibernating) {
            this.registerEvent(this.app.workspace.on('file-open', (file) => {
                this.whisperer.onFileOpen(file);
            }));
            
            this.registerEvent(this.app.workspace.on('editor-change', (editor, view) => {
                if (view instanceof MarkdownView) {
                    this.whisperer.onEditorChange(editor, view);
                }
            }));
            
            this.registerEvent(this.app.vault.on('modify', (file: TAbstractFile) => {
                this.syncManager.queueUpdate(file);
            }));
            
            this.registerEvent(this.app.vault.on('create', (file: TAbstractFile) => {
                this.syncManager.queueUpdate(file);
            }));
            
            this.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => {
                this.syncManager.queueDelete(file);
            }));
            
            this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
                this.syncManager.queueRename(file, oldPath);
            }));
        }

        console.log("Semantix Plugin loaded.");
    }

    /**
     * 打开或聚焦 Whisperer 视图
     */
    async activateWhispererView() {
        await this.activateViewByType(WHISPERER_VIEW_TYPE);
    }

    /**
     * 打开或聚焦 Radar 视图
     */
    async activateRadarView() {
        await this.activateViewByType(RADAR_VIEW_TYPE);
    }

    /**
     * 通用视图激活逻辑：如已存在则聚焦，否则在右侧边栏创建
     */
    private async activateViewByType(viewType: string) {
        const { workspace } = this.app;
        
        let leaf: WorkspaceLeaf | null | undefined = null;
        const leaves = workspace.getLeavesOfType(viewType);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            if (leaf) {
               await leaf.setViewState({ type: viewType, active: true });
            }
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    async checkConnection() {
        const isConnected = await this.apiClient.checkHealth();
        
        // 更新两个视图的状态指示灯
        this.updateAllViewStatus(isConnected ? 'connected' : 'disconnected');

        if (isConnected) {
            console.log("Semantix: Backend connection successful.");
            const status = await this.apiClient.getIndexStatus();
            if (status) {
                this.updateAllViewIndexStatus(status.total_notes, status.last_updated);
            }
        } else {
            console.log("Semantix: Backend connection failed.");
            new Notice("Semantix: 无法连接到本地 AI 后端，请检查配置或服务是否启动。");
        }
    }

    /**
     * 批量更新所有已打开视图的连接状态
     */
    private updateAllViewStatus(status: 'connected' | 'disconnected' | 'syncing') {
        for (const leaf of this.app.workspace.getLeavesOfType(WHISPERER_VIEW_TYPE)) {
            if (leaf.view instanceof WhispererView) {
                (leaf.view as WhispererView).updateStatus(status);
            }
        }
        for (const leaf of this.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE)) {
            if (leaf.view instanceof RadarView) {
                (leaf.view as RadarView).updateStatus(status);
            }
        }
    }

    /**
     * 批量更新所有已打开视图的索引状态
     */
    private updateAllViewIndexStatus(totalNotes: number, lastUpdated?: string) {
        for (const leaf of this.app.workspace.getLeavesOfType(WHISPERER_VIEW_TYPE)) {
            if (leaf.view instanceof WhispererView) {
                (leaf.view as WhispererView).updateIndexStatus(totalNotes, lastUpdated);
            }
        }
        for (const leaf of this.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE)) {
            if (leaf.view instanceof RadarView) {
                (leaf.view as RadarView).updateIndexStatus(totalNotes, lastUpdated);
            }
        }
    }

    /**
     * 更新并广播索引进度
     */
    public updateIndexingProgress(current: number, total: number, active: boolean = true, label?: string) {
        this.indexingState = { active, current, total, label };
        this.updateAllViewIndexingProgress(this.indexingState);
    }

    public clearIndexingProgress() {
        this.indexingState = { active: false, current: 0, total: 0 };
        this.updateAllViewIndexingProgress(this.indexingState);
    }

    public getIndexingState(): IndexingState {
        return this.indexingState;
    }

    private updateAllViewIndexingProgress(state: IndexingState) {
        for (const leaf of this.app.workspace.getLeavesOfType(WHISPERER_VIEW_TYPE)) {
            if (leaf.view instanceof WhispererView) {
                (leaf.view as WhispererView).updateIndexingProgress(state);
            }
        }
        for (const leaf of this.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE)) {
            if (leaf.view instanceof RadarView) {
                (leaf.view as RadarView).updateIndexingProgress(state);
            }
        }
    }

    public isFullIndexingActive(): boolean {
        return this.isFullIndexing;
    }

    public cancelFullIndexing() {
        if (!this.isFullIndexing) {
            new Notice("Semantix: 当前没有正在进行的全量索引。");
            return;
        }
        this.fullIndexCancelRequested = true;
        new Notice("Semantix: 已请求取消全量索引，当前批次完成后停止。");
    }

    public async startFullIndexing() {
        if (this.isFullIndexing) {
            new Notice("Semantix: 全量索引正在进行中。");
            return;
        }
        if (this.isMobileHibernating) {
            new Notice("Semantix: 移动端休眠中，无法执行全量索引。");
            return;
        }

        const isConnected = await this.apiClient.checkHealth();
        if (!isConnected) {
            new Notice("Semantix: 后端未连接，无法开始索引。");
            return;
        }

        const allFiles = this.app.vault.getMarkdownFiles();
        const files = allFiles.filter(file => !this.syncManager.isExcludedPath(file.path));
        if (files.length === 0) {
            new Notice("Semantix: 没有可索引的笔记。");
            return;
        }

        const confirmMessage = [
            `将索引约 ${files.length} 篇笔记，预计耗时数分钟。`,
            "索引进度不会持久化，关闭窗口或重启将重置进度。",
            "是否继续？"
        ].join("\n");

        if (!confirm(confirmMessage)) {
            return;
        }

        this.isFullIndexing = true;
        this.fullIndexCancelRequested = false;
        this.updateAllViewStatus('syncing');
        this.updateIndexingProgress(0, files.length, true, "full");

        const batchSize = 50;
        let processed = 0;
        let canceled = false;
        let completed = false;

        try {
            for (let i = 0; i < files.length; i += batchSize) {
                if (this.fullIndexCancelRequested) {
                    canceled = true;
                    break;
                }

                const batch = files.slice(i, i + batchSize);
                const documents: IndexDocument[] = [];

                for (const file of batch) {
                    const rawText = await this.app.vault.cachedRead(file);
                    const cleaned = cleanMarkdown(rawText);
                    if (cleaned.length === 0) {
                        processed += 1;
                        continue;
                    }
                    documents.push({ vault_id: this.vaultId, path: file.path, text: cleaned });
                    processed += 1;
                }

                if (documents.length > 0) {
                    const result = await this.apiClient.indexBatch({ documents });
                    if (!result || result.status !== 'success') {
                        new Notice("Semantix: 索引失败，请检查后端日志。");
                        break;
                    }
                }

                this.updateIndexingProgress(processed, files.length, true, "full");
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            completed = !canceled && processed >= files.length;
        } catch (error) {
            console.error("Semantix: Full index failed.", error);
            new Notice("Semantix: 全量索引失败，请检查后端日志。");
        } finally {
            this.isFullIndexing = false;
            this.fullIndexCancelRequested = false;
            this.clearIndexingProgress();
            await this.checkConnection();

            if (completed) {
                new Notice("Semantix: 索引完成 ✅");
            } else if (canceled) {
                new Notice("Semantix: 索引已取消。");
            }
        }
    }

    onunload() {
        this.syncManager.clearTimer();
        this.clearHealthTimer();
        console.log("Semantix Plugin unloaded.");
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.updateMobileMode();
        // 通知 apiClient 更新配置 URL
        this.apiClient.updateSettings(this.settings, this.vaultId);
        // 配置更新后立即重新探活
        if (!this.isMobileHibernating) {
            this.checkConnection();
            this.startHealthTimer();
        } else {
            this.clearHealthTimer();
        }
        // 更新防抖设置
        if (this.whisperer) {
            this.whisperer.setupDebounce();
        }
    }

    private updateMobileMode() {
        this.isMobileHibernating = Platform.isMobile && !this.settings.enableOnMobile;
        if (this.isMobileHibernating) {
            console.log("Semantix: Hibernating on mobile.");
        }
    }

private startHealthTimer() {
        if (this.healthTimer !== null) return;
        this.healthTimer = window.setInterval(() => {
            this.checkConnection();
        }, 30000);
    }

    private clearHealthTimer() {
        if (this.healthTimer !== null) {
            window.clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
    }

    private computeVaultId(): string {
        const vaultName = this.app.vault.getName();
        const adapter = this.app.vault.adapter as { getBasePath?: () => string };
        const basePath = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : '';
        const raw = `${vaultName}:${basePath}`;
        return this.hashString(raw);
    }

    private hashString(input: string): string {
        // FNV-1a 32-bit
        let hash = 2166136261;
        for (let i = 0; i < input.length; i++) {
            hash ^= input.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16);
    }
}
