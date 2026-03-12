import { App, Plugin, Notice, WorkspaceLeaf, TAbstractFile, MarkdownView } from 'obsidian';
import { SemantixSettings, DEFAULT_SETTINGS, SemantixSettingTab } from "./settings";
import { ApiClient } from './api/client';
import { SemantixSidebarView, SEMANTIX_SIDEBAR_VIEW } from './ui/sidebar';
import { SyncManager } from './core/sync';
import { Whisperer } from './core/whisperer';
import { OrphanRadar } from './core/radar';

export default class SemantixPlugin extends Plugin {
    settings: SemantixSettings;
    apiClient: ApiClient;
    syncManager: SyncManager;
    whisperer: Whisperer;
    orphanRadar: OrphanRadar;

    async onload() {
        // 1. 加载配置
        await this.loadSettings();

        // 2. 初始化 API Client & Engines
        this.apiClient = new ApiClient(this.settings);
        this.syncManager = new SyncManager(this);
        this.whisperer = new Whisperer(this);
        this.orphanRadar = new OrphanRadar(this);

        // 3. 注册配置面板
        this.addSettingTab(new SemantixSettingTab(this.app, this));

        // 4. 注册 Sidebar View
        this.registerView(
            SEMANTIX_SIDEBAR_VIEW,
            (leaf) => new SemantixSidebarView(leaf, this)
        );

        // 5. 将 IconButton 添加到左侧，点击时打开侧边栏
        this.addRibbonIcon('radar', 'Semantix 语义雷达', () => {
            this.activateView();
        });

        // 全局命令：扫描孤岛笔记
        this.addCommand({
            id: 'semantix-scan-orphans',
            name: 'Semantix: 扫描并分析孤岛笔记 (Scan Orphan Notes)',
            callback: () => {
                this.activateView();
                this.orphanRadar.scanAndRender();
            }
        });

        // 6. 等待工作区排布完成后打开视图并探活
        this.app.workspace.onLayoutReady(() => {
            this.activateView();
            this.checkConnection();
        });

        // 7. 注册增量同步与 Whisperer 事件
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

        console.log("Semantix Plugin loaded.");
    }

    async activateView() {
        const { workspace } = this.app;
        
        let leaf: WorkspaceLeaf | null | undefined = null;
        const leaves = workspace.getLeavesOfType(SEMANTIX_SIDEBAR_VIEW);

        if (leaves.length > 0) {
            // A leaf with our view already exists, use that
            leaf = leaves[0];
        } else {
            // Our view could not be found in the workspace, create a new leaf
            // in the right sidebar for it
            leaf = workspace.getRightLeaf(false);
            if (leaf) {
               await leaf.setViewState({ type: SEMANTIX_SIDEBAR_VIEW, active: true });
            }
        }

        // "Reveal" the leaf in case it is in a collapsed sidebar
        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    async checkConnection() {
        const isConnected = await this.apiClient.checkHealth();
        
        // Find the view instance to update its status
        const leaves = this.app.workspace.getLeavesOfType(SEMANTIX_SIDEBAR_VIEW);
        let view: SemantixSidebarView | null = null;
        if (leaves.length > 0) {
            const leaf = leaves[0];
            if (leaf && leaf.view instanceof SemantixSidebarView) {
                view = leaf.view as SemantixSidebarView;
            }
        }

        if (isConnected) {
            console.log("Semantix: Backend connection successful.");
            if (view) view.updateStatus('connected');
        } else {
            console.log("Semantix: Backend connection failed.");
            new Notice("Semantix: 无法连接到本地 AI 后端，请检查配置或服务是否启动。");
            if (view) view.updateStatus('disconnected');
        }
    }

    onunload() {
        this.syncManager.clearTimer();
        console.log("Semantix Plugin unloaded.");
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        // 通知 apiClient 更新配置 URL
        this.apiClient.updateSettings(this.settings);
        // 配置更新后立即重新探活
        this.checkConnection();
    }
}
