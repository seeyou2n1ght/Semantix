import { Plugin, Notice, WorkspaceLeaf, TAbstractFile, TFile, MarkdownView, Platform, Modal, App } from 'obsidian';
import { SemantixSettings, DEFAULT_SETTINGS, SemantixSettingTab } from "./settings";
import { ApiClient } from './api/client';
import { IndexDocument } from './api/types';
import { RadarView, RADAR_VIEW_TYPE } from './ui/radar-view';
import { SyncManager } from './core/sync';
import { RadarEngine } from './core/radar';
import { ServiceManager } from './core/service-manager';
import { cleanMarkdown } from './utils/markdown';
import { t } from './i18n/helpers';

export type IndexingState = {
    active: boolean;
    current: number;
    total: number;
    label?: string;
};

class FullIndexConfirmModal extends Modal {
    private onConfirm: () => void;
    private fileCount: number;

    constructor(app: App, fileCount: number, onConfirm: () => void) {
        super(app);
        this.fileCount = fileCount;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: 'Semantix' });
        contentEl.createEl('p', {
            text: `将索引约 ${this.fileCount} 篇笔记，预计耗时数分钟。`
        });
        contentEl.createEl('p', {
            text: '索引进度不会持久化，关闭窗口或重启将重置进度。是否继续？'
        });

        const btnContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        const cancelBtn = btnContainer.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = btnContainer.createEl('button', { cls: 'mod-cta', text: '开始索引' });
        confirmBtn.addEventListener('click', () => {
            this.close();
            this.onConfirm();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

export default class SemantixPlugin extends Plugin {
    settings: SemantixSettings;
    apiClient: ApiClient;
    syncManager: SyncManager;
    radar: RadarEngine;
    get whisperer(): RadarEngine { return this.radar; }
    serviceManager: ServiceManager;
    vaultId: string;
    isMobileHibernating: boolean = false;
    private healthTimer: number | null = null;
    private indexingState: IndexingState = { active: false, current: 0, total: 0 };
    private lastConnectionStatus: 'connected' | 'disconnected' | 'syncing' | 'disabled' = 'disabled';
    private isFullIndexing: boolean = false;
    private fullIndexCancelRequested: boolean = false;
    private startupNotice: Notice | null = null;
    private isStartupNoticeCompleted: boolean = false;
    private settingTab: SemantixSettingTab | null = null;
    private statusBarItem: HTMLElement | null = null;
    public vaultStopwords: string[] = [];

    async onload() {
        // 1. 加载配置
        await this.loadSettings();
        this.vaultId = this.computeVaultId();
        this.updateMobileMode();

        // 2. 初始化 API Client & Engines
        this.apiClient = new ApiClient(this.settings, this.vaultId);
        this.syncManager = new SyncManager(this);
        this.radar = new RadarEngine(this);
        this.serviceManager = new ServiceManager(this);

        // 2.1 注册状态播报消费者（实现右上角动态 Notice）
        this.serviceManager.setStatusConsumer((msg) => {
            // 如果本轮启动已结束，则不再处理后续杂散日志
            if (this.isStartupNoticeCompleted) return;

            // 状态消息映射转换
            let translatedMsg = msg;
            if (msg.includes("正在唤醒后端服务")) translatedMsg = t('STARTUP_WAKING');
            else if (msg.includes("正在同步后端依赖")) translatedMsg = t('STARTUP_ENV_CHECK');
            else if (msg.includes("正在加载语义引擎")) translatedMsg = t('STARTUP_STILL_WAKING');
            else if (msg.includes("服务已就绪")) translatedMsg = t('STARTUP_READY');
            else if (msg.includes("启动失败")) translatedMsg = t('STARTUP_FAILED');
            else if (msg.includes("模型下载中")) translatedMsg = msg; // 保持原始进度显示

            // 联动：当检测到后端已成功拉起，立即触发一次非阻塞探活，消除 3s 盲等
            if (msg.includes("Uvicorn running on") || msg.includes("服务已就绪")) {
                void this.checkConnection({ silent: true });
            }

            if (!this.startupNotice) {
                // 创建一个持久化的 Notice (timeout 为 0 表示手动关闭或后续代码关闭)
                this.startupNotice = new Notice(translatedMsg, 0);
            } else {
                this.startupNotice.setMessage(translatedMsg);
            }

            // 如果是结束态，则设置一个较短的延迟后关闭
            const isClosingMsg = msg.includes("✅") || msg.includes("🚀") || msg.includes("❌") || msg.includes("就绪");
            if (isClosingMsg) {
                this.isStartupNoticeCompleted = true; // 锁定状态，禁止后续日志复现浮窗
                const noticeToClose = this.startupNotice;
                this.startupNotice = null; 
                window.setTimeout(() => {
                    noticeToClose?.hide();
                }, 4000);
            }
        });

        // 2.1 注册 CodeMirror 扩展（光标活动监听）
        if (!this.isMobileHibernating) {
            this.registerEditorExtension(this.radar.getCursorActivityExtension());
        }

        // 3. 注册配置面板与底部状态栏
        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.addClass('semantix-status-bar-item');

        this.settingTab = new SemantixSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);

        // 4. 注册单一 Semantix Radar 侧栏视图
        this.registerView(
            RADAR_VIEW_TYPE,
            (leaf) => new RadarView(leaf, this)
        );

        // 注册原生悬浮预览源，支持与 Obsidian Page Preview 插件联动
        this.registerHoverLinkSource('semantix', {
            display: 'Semantix Radar',
            defaultMod: true
        });

        // 5. Ribbon Icon —— 打开 Semantix Radar 视图
        this.addRibbonIcon('radar', `${t('PLUGIN_NAME')}: Radar`, () => {
            void this.activateRadarView();
        });

        // 6. 全局命令
        this.addCommand({
            id: 'open-sidebar',
            name: `${t('PLUGIN_NAME')}: Open sidebar`,
            callback: () => {
                void this.activateRadarView();
            }
        });
        this.addCommand({
            id: 'scan-note',
            name: `${t('PLUGIN_NAME')}: Scan whole note`,
            callback: () => {
                void this.activateRadarView();
                void this.radar.triggerNoteScan();
            }
        });
        this.addCommand({
            id: 'scan-focus',
            name: `${t('PLUGIN_NAME')}: ${t('CMD_SCAN_FOCUS')}`,
            callback: () => {
                void this.activateRadarView();
                void this.radar.triggerFocusScan();
            }
        });

        // 7. 工作区就绪后打开视图、探活并注册文件增量监听
        this.app.workspace.onLayoutReady(() => {
            if (!this.isMobileHibernating) {
                void this.activateRadarView();

                // 清空初始队列，防止应用启动扫描期间累积幽灵事件
                this.syncManager.clearQueue();

                // 仓库初始就绪后再注册文件增量变更，彻底规避启动扫描期广播的伪 create 洪泛
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

                // 如果开启了本地自建边车模式，则尝试启动（仅桌面端支持）
                if (Platform.isDesktop && this.settings.backendMode === 'local' && this.settings.autoStartServer) {
                    void this.serviceManager.start();
                }
                // 初次自检设为静默，避免启动瞬间的竞态导致误报
                void this.checkConnection({ silent: true });
                this.startHealthTimer();
            }
        });

        // 8. 注册 Radar 事件（移动端禁用时不注册）
        if (!this.isMobileHibernating) {
            this.registerEvent(this.app.workspace.on('file-open', (file) => {
                this.radar.onFileOpen(file);
            }));
            
            this.registerEvent(this.app.workspace.on('editor-change', (editor, view) => {
                if (view instanceof MarkdownView) {
                    this.radar.onEditorChange(editor, view);
                }
            }));
        }
    }

    /**
     * 打开或聚焦 Radar 视图
     */
    async activateRadarView() {
        await this.activateViewByType(RADAR_VIEW_TYPE);
    }

    /**
     * 向后兼容别名
     */
    async activateWhispererView() {
        await this.activateRadarView();
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
            if ('revealLeaf' in workspace && typeof workspace.revealLeaf === 'function') {
                void workspace.revealLeaf(leaf);
            } else {
                workspace.setActiveLeaf(leaf, { focus: true });
            }
        }
    }

    async checkConnection(options: { silent?: boolean; manual?: boolean } = {}) {
        const { silent = false, manual = false } = options;

        // 1. 判断是否处于“未启用”或“休眠”状态
        if (this.isMobileHibernating) {
            this.updateAllViewStatus('disabled');
            return;
        }

        if (Platform.isDesktop && this.settings.backendMode === 'local') {
            if (this.serviceManager.isActivating()) {
                // 如果正在启动中，保持 syncing 状态
                this.updateAllViewStatus('syncing');
            } else if (this.serviceManager.isUserStopped()) {
                // 用户主动点击停止，保持禁用状态
                this.updateAllViewStatus('disabled');
                return;
            }
        }

        // 2. 探活心跳检测（解耦进程归属与连接可用性，支持外部手动启动的本地引擎）
        const isConnected = await this.apiClient.checkHealth();
        if (isConnected) {
            void this.apiClient.ping(); // 同时发送后端存活心跳（异步执行，不阻塞 UI）
            this.serviceManager.onHealthyStable(); // 重置连续失败熔断计数
        } else if (Platform.isDesktop && this.settings.backendMode === 'local') {
            // 本地未连通且开启自启，触发自愈
            if (this.settings.autoStartServer && !this.serviceManager.isUserStopped()) {
                this.serviceManager.triggerSelfHealing("检测到服务未运行");
            }
        }
        const nextStatus = isConnected ? 'connected' : 'disconnected';
        
        // 3. 处理通知逻辑
        if (isConnected) {
            // 情况 A: 连接恢复 (从断连状态转为连接成功)
            if (this.lastConnectionStatus === 'disconnected') {
                new Notice(t('NOTICE_RECOVERED'));
            }
            // 情况 B: 手动测试成功 (排除本身已经在连接状态的情形，除非是手动点击)
            else if (manual) {
                new Notice(t('NOTICE_HEALTHY'));
            }
            
            // 联动：如果此时启动浮窗还在，说明日志解析可能滞后，强制清理它
            if (this.startupNotice) {
                this.isStartupNoticeCompleted = true;
                const noticeToClose = this.startupNotice;
                this.startupNotice = null;
                noticeToClose.hide();
            }

            const status = await this.apiClient.getIndexStatus();
            if (status) {
                this.updateAllViewIndexStatus(status.total_notes, status.last_updated);
                this.vaultStopwords = status.vault_stopwords || [];
            }
        } else {
            // 连接中断时若符合自愈条件，触发自愈机制
            if (Platform.isDesktop && this.settings.backendMode === 'local' && this.settings.autoStartServer && !this.serviceManager.isUserStopped()) {
                this.serviceManager.triggerSelfHealing("心跳无响应");
            }

            // 情况 C: 首次发生断连 (从正常转为异常)
            if (this.lastConnectionStatus === 'connected' && !silent) {
                new Notice(t('NOTICE_DISCONNECTED'));
            }
            // 情况 D: 手动测试失败 (且不是因为 Disabled)
            else if (manual) {
                new Notice(t('NOTICE_DISCONNECTED'));
            }
            // 情况 E: 心跳周期内的持续断连 -> 保持静默
        }

        // 4. 更新 UI 状态
        this.updateAllViewStatus(nextStatus);
    }

    /**
     * 批量更新所有已打开视图的连接状态
     */
    public updateAllViewStatus(status: 'connected' | 'disconnected' | 'syncing' | 'disabled') {
        this.lastConnectionStatus = status; // 同步内部状态标签
        for (const leaf of this.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE)) {
            if (leaf.view instanceof RadarView) {
                (leaf.view).updateStatus(status);
            }
        }

        // 同步通知设置面板刷新（如果已打开）
        if (this.settingTab) {
            this.settingTab.refreshStatusDisplay();
        }
    }

    /**
     * 批量更新所有已打开视图的索引状态
     */
    private updateAllViewIndexStatus(totalNotes: number, lastUpdated?: string) {
        for (const leaf of this.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE)) {
            if (leaf.view instanceof RadarView) {
                (leaf.view).updateIndexStatus(totalNotes, lastUpdated);
            }
        }
    }

    /**
     * 更新并广播索引进度
     */
    public updateIndexingProgress(current: number, total: number, active: boolean = true, label?: string) {
        this.indexingState = { active, current, total, label };
        this.updateAllViewIndexingProgress(this.indexingState);
        if (this.statusBarItem) {
            if (active && total > 0) {
                const pct = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
                const prefix = label === 'sync' ? t('PROGRESS_LABEL_SYNC') : t('PROGRESS_LABEL_INDEX');
                this.statusBarItem.setText(`Semantix: ${prefix} ${pct}% (${current}/${total})`);
            } else {
                this.statusBarItem.setText("");
            }
        }
    }

    public clearIndexingProgress() {
        this.indexingState = { active: false, current: 0, total: 0 };
        this.updateAllViewIndexingProgress(this.indexingState);
        if (this.statusBarItem) {
            this.statusBarItem.setText("");
        }
    }

    public getIndexingState(): IndexingState {
        return this.indexingState;
    }

    /**
     * 获取当前的连接状态
     */
    public getConnectionStatus() {
        return this.lastConnectionStatus;
    }

    private updateAllViewIndexingProgress(state: IndexingState) {
        for (const leaf of this.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE)) {
            if (leaf.view instanceof RadarView) {
                (leaf.view).updateIndexingProgress(state);
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

    public async startFullIndexing(options?: { skipConfirm?: boolean }) {
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

        if (!options?.skipConfirm) {
            new FullIndexConfirmModal(this.app, files.length, () => {
                void this.startFullIndexing({ skipConfirm: true });
            }).open();
            return;
        }

        this.isFullIndexing = true;
        this.fullIndexCancelRequested = false;
        this.updateAllViewStatus('syncing');
        this.updateIndexingProgress(0, files.length, true, "full");

        let indexingNotice: Notice | null = new Notice(`Semantix: 开始全量索引 (共 ${files.length} 篇)...`, 0);

        const maxBatchDocs = 25; // 限制单批最多 25 篇笔记
        const maxBatchChars = 150_000; // 限制单批总字符数，防止超大请求包阻塞主线程
        let processed = 0;
        let canceled = false;
        let completed = false;
        const failedPaths: string[] = [];

        // 微任务与帧间空闲让渡函数，确保 UI 60fps 平滑不卡顿
        const yieldToMain = (): Promise<void> => {
            return new Promise((resolve) => {
                const win = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void };
                if (typeof win.requestIdleCallback === 'function') {
                    win.requestIdleCallback(() => resolve(), { timeout: 30 });
                } else {
                    window.setTimeout(resolve, 16);
                }
            });
        };

        await this.syncManager.pause();
        try {
            let currentBatchDocs: IndexDocument[] = [];
            let currentBatchChars = 0;

            const flushBatch = async (): Promise<boolean> => {
                if (currentBatchDocs.length === 0) return true;
                const result = await this.apiClient.indexBatch({ documents: currentBatchDocs });
                if (!result || result.status !== 'success') {
                    new Notice("Semantix: 索引批次提交失败，请检查后端日志。");
                    return false;
                }
                if (result.failed_paths && result.failed_paths.length > 0) {
                    failedPaths.push(...result.failed_paths);
                }
                return true;
            };

            for (const file of files) {
                if (this.fullIndexCancelRequested) {
                    canceled = true;
                    break;
                }

                try {
                    const rawText = await this.app.vault.cachedRead(file);
                    const cleaned = cleanMarkdown(rawText);
                    if (cleaned.length > 0) {
                        const context = this.getFileContext(file);
                        const docChars = cleaned.length;

                        // 超过单批上限时，先刷写上一批
                        if (currentBatchDocs.length > 0 && (currentBatchDocs.length >= maxBatchDocs || currentBatchChars + docChars > maxBatchChars)) {
                            const success = await flushBatch();
                            if (!success) {
                                canceled = true;
                                break;
                            }
                            currentBatchDocs = [];
                            currentBatchChars = 0;
                        }

                        currentBatchDocs.push({
                            vault_id: this.vaultId,
                            path: file.path,
                            text: cleaned,
                            tags: context.tags,
                            links: context.links
                        });
                        currentBatchChars += docChars;
                    }
                } catch {
                    failedPaths.push(file.path);
                }

                processed++;
                this.updateIndexingProgress(processed, files.length, true, "full");

                // 每处理 5 个文件让渡一次主线程，避免界面顿挫
                if (processed % 5 === 0) {
                    await yieldToMain();
                }
            }

            // 刷写剩余未提交文档
            if (!canceled && currentBatchDocs.length > 0) {
                const success = await flushBatch();
                if (!success) canceled = true;
            }

            completed = !canceled && processed >= files.length;
        } catch (error) {
            console.error("Semantix: Full index failed.", error);
            new Notice("Semantix: 全量索引失败，请检查后端日志。");
        } finally {
            if (indexingNotice) {
                indexingNotice.hide();
                indexingNotice = null;
            }
            this.isFullIndexing = false;
            this.fullIndexCancelRequested = false;
            this.clearIndexingProgress();
            this.syncManager.resume();
            await this.checkConnection();

            if (completed) {
                // 显式触发 FTS 倒排索引构建，实现即时全文检索支持
                const ftsSuccess = await this.apiClient.rebuildFtsIndex();
                if (failedPaths.length > 0) {
                    const failCount = failedPaths.length;
                    const successCount = files.length - failCount;
                    new Notice(`Semantix: 全量索引部分完成 ⚠️ (成功 ${successCount} 篇，失败 ${failCount} 篇${ftsSuccess ? "，全文索引已就绪" : "，全文索引构建失败"})`);
                } else if (!ftsSuccess) {
                    new Notice(`Semantix: 全量索引已写入 (共 ${files.length} 篇)，但全文索引构建失败 ⚠️`);
                } else {
                    new Notice(`Semantix: 全量索引完成 ✅ (共 ${files.length} 篇笔记，全文索引已就绪)`);
                }
                if (this.whisperer) {
                    void this.whisperer.triggerNoteScan();
                }
            } else if (canceled) {
                new Notice("Semantix: 索引已取消。");
            }
        }
    }

    onunload() {
        this.syncManager.clearTimer();
        this.clearHealthTimer();
        this.serviceManager.stop();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<SemantixSettings>);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.updateMobileMode();
        // 通知 apiClient 更新配置 URL
        this.apiClient.updateSettings(this.settings, this.vaultId);
        // 配置更新后立即重新探活
        if (!this.isMobileHibernating) {
            void this.checkConnection();
            this.startHealthTimer();
        } else {
            this.clearHealthTimer();
        }
        // 更新防抖设置
        if (this.radar) {
            this.radar.setupDebounce();
        }
    }

    private updateMobileMode() {
        this.isMobileHibernating = Platform.isMobile && !this.settings.enableOnMobile;
    }

    private startHealthTimer() {
        if (this.healthTimer !== null) return;
        this.healthTimer = window.setInterval(() => {
            void this.checkConnection({ silent: true });
        }, 30000);
    }

    private clearHealthTimer() {
        if (this.healthTimer !== null) {
            window.clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
    }

    /**
     * 重置启动通知状态，允许在手动重启时重新显示启动浮窗
     */
    public resetStartupNotice() {
        this.isStartupNoticeCompleted = false;
        if (this.startupNotice) {
            this.startupNotice.hide();
            this.startupNotice = null;
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

    /**
     * 核心：提取笔记的元数据上下文 (Tags & Links)
     */
    public getFileContext(file: TAbstractFile): { tags: string[], links: string[] } {
        const tags: string[] = [];
        const links: string[] = [];
        
        if (file instanceof TFile) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache) {
                // 1. 提取标签 (Frontmatter + Inline)
                if (cache.tags) {
                    cache.tags.forEach(t => tags.push(t.tag.replace(/^#/, '')));
                }
                if (cache.frontmatter?.tags) {
                    const fTags: unknown = cache.frontmatter.tags;
                    if (Array.isArray(fTags)) {
                        (fTags as unknown[]).forEach(t => tags.push(String(t).replace(/^#/, '')));
                    } else if (typeof fTags === 'string') {
                        fTags.split(',').forEach(t => tags.push(t.trim().replace(/^#/, '')));
                    }
                }
                
                // 2. 提取出链 (Outlinks)
                // 优先从 resolvedLinks 获取 Obsidian 核心解析后的规范 vault 路径
                const resolved = this.app.metadataCache.resolvedLinks?.[file.path];
                if (resolved) {
                    Object.keys(resolved).forEach(targetPath => {
                        if (targetPath) links.push(targetPath);
                    });
                }
                // 若 resolvedLinks 暂无数据或有遗漏，回退至 cache.links 并尝试解析路径
                if (cache.links) {
                    cache.links.forEach(l => {
                        const linkPath = l.link.split('#')[0];
                        if (linkPath) {
                            const dest = this.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
                            if (dest) {
                                links.push(dest.path);
                            } else {
                                links.push(linkPath);
                            }
                        }
                    });
                }
            }
        }
        
        return { 
            tags: [...new Set(tags)], // 去重
            links: [...new Set(links)] 
        };
    }
}
