import { Plugin, Notice, WorkspaceLeaf, TAbstractFile, TFile, MarkdownView, Platform, Modal, App } from 'obsidian';
import { SemantixSettings, DEFAULT_SETTINGS, SemantixSettingTab } from "./settings";
import { ApiClient, HealthStatus } from './api/client';
import { IndexDocument } from './api/types';
import { RadarView, RADAR_VIEW_TYPE } from './ui/radar-view';
import { SyncManager } from './core/sync';
import { RadarEngine } from './core/radar';
import { ServiceManager } from './core/service-manager';
import { readIndexDocument, indexBatchWouldOverflow } from './core/index-batch';
import { ExclusionMatcher } from './core/exclusion';
import { t } from './i18n/helpers';

export interface FileSignature {
    mtime: number;
    size: number;
}

export type IndexingState = {
    active: boolean;
    current: number;
    total: number;
    label?: string;
};

type AdaptiveStopwordsResult = NonNullable<Awaited<ReturnType<ApiClient['computeStopwords']>>>;

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
    serviceManager: ServiceManager;
    vaultId: string;
    isMobileHibernating: boolean = false;
    private healthTimer: number | null = null;
    private radarActivation: Promise<void> | null = null;
    private unloaded = false;
    private consolidatingRadar = false;
    private indexingState: IndexingState = { active: false, current: 0, total: 0 };
    private lastConnectionStatus: 'connected' | 'disconnected' | 'syncing' | 'disabled' = 'disabled';
    private isFullIndexing: boolean = false;
    private fullIndexCancelRequested: boolean = false;
    private startupNotice: Notice | null = null;
    private isStartupNoticeCompleted: boolean = false;
    private settingTab: SemantixSettingTab | null = null;
    private statusBarItem: HTMLElement | null = null;
    public vaultStopwords: string[] = [];
    private adaptivePreparation: 'idle' | 'pending' | 'ready' | 'failed' = 'idle';
    private adaptivePreparationTask: Promise<AdaptiveStopwordsResult | null | undefined> | null = null;
    private adaptivePreparationKey = '';
    private adaptivePreparationGeneration = 0;
    private connectionCheckId = 0;
    private adaptiveRefreshPending = false;
    public fileSignatures: Record<string, FileSignature> = {};
    private reconciliationPending = true;
    private indexedPaths = new Set<string>();
    public reconciliationStatus: 'unknown' | 'checking' | 'checked' | 'unavailable' | 'failed' = 'unknown';
    private indexGeneration = 0;
    private signatureKey = '';
    private signatureSnapshots: Record<string, Record<string, FileSignature>> = {};
    private dataSave: Promise<void> = Promise.resolve();
    private searchSettingsTimer: number | null = null;
    public writeCoordinationState: 'idle' | 'full_rebuild' | 'reconciliation' | 'clear' = 'idle';

    async onload() {
        // 1. 加载配置
        this.vaultId = this.computeVaultId();
        await this.loadSettings();
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
            const isClosingMsg = msg.includes("✅") || msg.includes("🚀") || msg.includes("❌") || msg.includes("🛑") || msg.includes("就绪");
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
            display: t('PLUGIN_NAME'),
            defaultMod: true
        });

        // 5. Ribbon Icon —— 打开 Semantix Radar 视图
        this.addRibbonIcon('radar', t('PLUGIN_NAME'), () => {
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
            if (this.unloaded) return;
            if (!this.isMobileHibernating) {
                this.registerEvent(this.app.workspace.on('layout-change', () => {
                    this.consolidateRadarLeaves();
                }));
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
        if (this.unloaded) return;
        // Layout restoration, commands and ribbon clicks may arrive while setViewState awaits.
        const activation = this.radarActivation ?? this.activateViewByType(RADAR_VIEW_TYPE);
        this.radarActivation = activation;
        try {
            await activation;
        } finally {
            if (this.radarActivation === activation) this.radarActivation = null;
        }
    }

    /**
     * 通用视图激活逻辑：如已存在则聚焦，否则在右侧边栏创建
     */
    private async activateViewByType(viewType: string) {
        const { workspace } = this.app;
        
        let leaf: WorkspaceLeaf | null | undefined = null;
        const leaves = this.getRadarLeaves();

        if (leaves.length > 0) {
            leaf = this.consolidateRadarLeaves();
            if (leaf) await leaf.loadIfDeferred();
            if (this.unloaded) return;
        } else {
            leaf = workspace.getRightLeaf(false);
            if (leaf) {
               await leaf.setViewState({ type: viewType, active: true });
               if (this.unloaded) {
                   leaf.detach();
                   return;
               }
            }
        }

        if (leaf) {
            if ('revealLeaf' in workspace && typeof workspace.revealLeaf === 'function') {
                await workspace.revealLeaf(leaf);
            } else {
                workspace.setActiveLeaf(leaf, { focus: true });
            }
        }
    }

    // Deferred views expose their saved type through getViewState, not their current View.
    private getRadarLeaves(): WorkspaceLeaf[] {
        const leaves: WorkspaceLeaf[] = [];
        this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.getViewState().type === RADAR_VIEW_TYPE) leaves.push(leaf);
        });
        return leaves;
    }

    private consolidateRadarLeaves(): WorkspaceLeaf | undefined {
        if (this.unloaded || this.consolidatingRadar) return;
        this.consolidatingRadar = true;
        try {
            const leaves = this.getRadarLeaves();
            // Preserve a functioning panel in its current location before a deferred placeholder.
            const retained = leaves.find(leaf => !leaf.isDeferred) ?? leaves[0];
            for (const leaf of leaves) {
                if (leaf !== retained) leaf.detach();
            }
            return retained;
        } finally {
            this.consolidatingRadar = false;
        }
    }

    async checkConnection(options: { silent?: boolean; manual?: boolean } = {}) {
        if (this.unloaded) return;
        const checkId = ++this.connectionCheckId;
        const { silent = false, manual = false } = options;

        // 1. 判断是否处于“未启用”或“休眠”状态
        if (this.isMobileHibernating) {
            this.resetAdaptiveFilteringPreparation();
            this.syncManager.setConnectionReady(false);
            this.updateAllViewStatus('disabled');
            this.flushAdaptiveRefresh();
            return;
        }

        if (Platform.isDesktop && this.settings.backendMode === 'local') {
            if (this.serviceManager.isActivating()) {
                // 如果正在启动中，保持 syncing 状态
                this.updateAllViewStatus('syncing');
            } else if (this.serviceManager.isUserStopped()) {
                // 用户主动点击停止，保持禁用状态
                this.resetAdaptiveFilteringPreparation();
                this.syncManager.setConnectionReady(false);
                this.updateAllViewStatus('disabled');
                this.flushAdaptiveRefresh();
                return;
            }
        }

        // 2. 探活心跳检测（解耦进程归属与连接可用性，支持外部手动启动的本地引擎）
        const health = await this.apiClient.checkFullHealth();
        if (this.unloaded || checkId !== this.connectionCheckId) return;
        if (Platform.isDesktop && this.settings.backendMode === 'local' && this.serviceManager.isUserStopped()) {
            this.resetAdaptiveFilteringPreparation();
            this.syncManager.setConnectionReady(false);
            this.updateAllViewStatus('disabled');
            this.flushAdaptiveRefresh();
            return;
        }
        if (health !== HealthStatus.READY) {
            this.indexGeneration++;
            this.reconciliationPending = true;
            this.reconciliationStatus = 'unknown';
        }
        this.syncManager.setConnectionReady(health === HealthStatus.READY);
        if (health === HealthStatus.LOADING) {
            this.resetAdaptiveFilteringPreparation();
            this.updateAllViewStatus('syncing');
            this.flushAdaptiveRefresh();
            return;
        }
        if (health === HealthStatus.ERROR) {
            this.resetAdaptiveFilteringPreparation();
            if (manual || (!silent && this.lastConnectionStatus !== 'disconnected')) {
                new Notice(this.apiClient.lastHealthResponse?.message || t('STARTUP_FAILED'));
            }
            this.updateAllViewStatus('disconnected');
            this.flushAdaptiveRefresh();
            return;
        }
        const isConnected = health === HealthStatus.READY;
        if (isConnected) {
            this.serviceManager.onHealthyStable(); // 重置连续失败熔断计数
        }
        const nextStatus = isConnected ? 'connected' : 'disconnected';
        
        // 3. 处理通知逻辑
        if (isConnected) {
            // 情况 A: 连接恢复 (从断连状态转为连接成功)
            if (this.lastConnectionStatus === 'disconnected') {
                new Notice(t('NOTICE_RECOVERED'));
                this.reconciliationPending = true;
            }
            // 情况 B: 手动测试成功 (排除本身已经在连接状态的情形，除非是手动点击)
            else if (manual) {
                this.reconciliationPending = true;
                new Notice(t('NOTICE_HEALTHY'));
            }
            
            // 联动：如果此时启动浮窗还在，说明日志解析可能滞后，强制清理它
            if (this.startupNotice) {
                this.isStartupNoticeCompleted = true;
                const noticeToClose = this.startupNotice;
                this.startupNotice = null;
                noticeToClose.hide();
            }

            const statusGeneration = this.adaptivePreparationGeneration;
            const statusKey = this.currentAdaptivePreparationKey();
            const wordsBeforeStatus = this.vaultStopwords;
            const status = await this.apiClient.getIndexStatus();
            if (this.unloaded || checkId !== this.connectionCheckId) return;
            if (status) {
                this.updateAllViewIndexStatus(status.total_notes, status.last_updated);
                this.settingTab?.updateIndexSnapshot(status.total_notes, status.last_updated);
                if (statusGeneration === this.adaptivePreparationGeneration
                    && statusKey === this.currentAdaptivePreparationKey()
                    && wordsBeforeStatus === this.vaultStopwords) {
                    this.setVaultStopwords(status.vault_stopwords || []);
                }
            }
            await this.prepareAdaptiveFiltering();
            if (this.unloaded || checkId !== this.connectionCheckId) return;
        } else {
            this.resetAdaptiveFilteringPreparation();
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
        if (isConnected && this.reconciliationPending) void this.reconcileVaultIndex();
        this.flushAdaptiveRefresh();
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
        if (this.writeCoordinationState !== 'idle' || this.isMobileHibernating) {
            new Notice('Semantix: 索引操作忙碌或当前平台已休眠，请稍后再试。');
            return;
        }
        if (!options?.skipConfirm) {
            const count = this.app.vault.getMarkdownFiles().filter(file => !this.syncManager.isExcludedPath(file.path)).length;
            new FullIndexConfirmModal(this.app, count, () => { void this.startFullIndexing({ skipConfirm: true }); }).open();
            return;
        }
        this.writeCoordinationState = 'full_rebuild';
        this.isFullIndexing = true;
        this.fullIndexCancelRequested = false;
        this.reconciliationStatus = 'checking';
        const identity = this.getIndexIdentity();
        const current = () => identity === this.getIndexIdentity() && !this.unloaded;
        const failedPaths: string[] = [];
        let completed = false;
        let canceled = false;
        let total = 0;
        try {
            await this.syncManager.pause();
            if (!current() || !await this.apiClient.checkHealth()) throw new Error('后端未连接或连接已变更');
            const indexedPaths = await this.apiClient.getIndexedPaths();
            if (!current()) throw new Error('索引连接已变更');
            if (indexedPaths === null) throw new Error('无法获取完整索引路径清单，请更新或检查 Engine 后重试');
            this.indexedPaths = new Set(indexedPaths);
            const files = this.app.vault.getMarkdownFiles().filter(file => !this.syncManager.isExcludedPath(file.path));
            total = files.length;
            let processed = 0;
            let batch: IndexDocument[] = [];
            const flush = async () => {
                if (!current()) throw new Error('索引连接已变更');
                const eligible = batch.filter(doc => !this.syncManager.isExcludedPath(doc.path));
                batch = [];
                if (!eligible.length) return;
                const response = await this.apiClient.indexBatch({ documents: eligible });
                if (!current()) throw new Error('索引连接已变更');
                if (!response || response.status !== 'success') throw new Error('批次提交失败');
                const failed = new Set(response.failed_paths || []);
                failedPaths.push(...failed);
                this.onPathsIndexed(eligible.filter(doc => !failed.has(doc.path)));
            };
            for (const file of files) {
                if (!current()) throw new Error('索引连接已变更');
                if (this.fullIndexCancelRequested) { canceled = true; break; }
                if (!this.syncManager.isExcludedPath(file.path)) {
                    let doc: IndexDocument | null = null;
                    try { doc = await readIndexDocument(this, file); }
                    catch (error) {
                        failedPaths.push(file.path);
                        console.warn('Semantix: Full-index document read failed.', error);
                    }
                    if (doc) {
                        if (indexBatchWouldOverflow(batch, doc)) await flush();
                        batch.push(doc);
                    }
                }
                this.updateIndexingProgress(++processed, total, true, 'full');
                if (processed % 5 === 0) await new Promise<void>(resolve => {
                    const win = window as Window & { requestIdleCallback?: (cb: () => void) => void };
                    if (win.requestIdleCallback) win.requestIdleCallback(resolve);
                    else window.setTimeout(resolve, 0);
                });
            }
            if (this.fullIndexCancelRequested) canceled = true;
            if (!canceled) {
                await flush();
                // Enumerate again after updates: newer create/rename events must not be deleted by an old snapshot.
                const eligiblePaths = new Set(this.app.vault.getMarkdownFiles()
                    .filter(file => !this.syncManager.isExcludedPath(file.path)).map(file => file.path));
                const obsolete = indexedPaths.filter(path => !eligiblePaths.has(path));
                for (let offset = 0; offset < obsolete.length; offset += 25) {
                    if (!current()) throw new Error('索引连接已变更');
                    if (this.fullIndexCancelRequested) { canceled = true; break; }
                    const paths = obsolete.slice(offset, offset + 25).filter(path => {
                        const file = this.app.vault.getAbstractFileByPath(path);
                        return !(file instanceof TFile) || this.syncManager.isExcludedPath(path);
                    });
                    if (!paths.length) continue;
                    const deleted = await this.apiClient.indexDelete({ vault_id: this.vaultId, paths });
                    if (!current()) throw new Error('索引连接已变更');
                    if (!deleted || deleted.status !== 'success') throw new Error('旧索引路径清理失败');
                    this.onPathsDeleted(paths);
                }
                if (!canceled) {
                    const ftsReady = await this.apiClient.rebuildFtsIndex();
                    if (!current()) throw new Error('索引连接已变更');
                    if (!ftsReady) throw new Error('全文索引构建失败');
                    completed = true;
                    this.reconciliationPending = false;
                    await this.dataSave;
                    this.reconciliationStatus = 'checked';
                }
            }
            if (completed) new Notice(failedPaths.length
                ? `Semantix: 全量索引部分完成：失败 ${failedPaths.length} 篇，旧索引保留并排队重试。`
                : `Semantix: 全量索引完成 ✅ (共 ${total} 篇，旧路径已核对，全文索引已就绪)`);
            else new Notice('Semantix: 索引已取消；已提交索引保留，完整核对尚未完成。');
        } catch (error) {
            this.reconciliationStatus = 'failed';
            console.error('Semantix: Full indexing incomplete.', error);
            new Notice(`Semantix: 全量索引未完成：${error instanceof Error ? error.message : String(error)}。已有效写入的索引保留。`);
        } finally {
            for (const path of failedPaths) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) this.syncManager.queueUpdate(file);
            }
            if (!completed && this.reconciliationStatus === 'checking') this.reconciliationStatus = 'unknown';
            this.isFullIndexing = false;
            this.fullIndexCancelRequested = false;
            this.writeCoordinationState = 'idle';
            this.clearIndexingProgress();
            this.syncManager.resume();
            await this.checkConnection();
            if (completed && this.radar) void this.radar.refreshCurrentScope();
        }
    }

    onunload() {
        this.unloaded = true;
        this.indexGeneration++;
        if (this.searchSettingsTimer !== null) window.clearTimeout(this.searchSettingsTimer);
        this.radar?.cancelDebounceTimers();
        this.syncManager.setConnectionReady(false);
        this.syncManager.clearTimer();
        this.clearHealthTimer();
        this.serviceManager.stop();
    }

    async loadSettings() {
        const raw = (await this.loadData()) as Record<string, unknown> | null;
        const saved = (raw?.settings || raw || {}) as Partial<SemantixSettings>;
        this.settings = { ...DEFAULT_SETTINGS };
        for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof SemantixSettings)[]) {
            if (saved[key] !== undefined) Object.assign(this.settings, { [key]: saved[key] });
        }
        this.settings.dbRetentionDays = Math.max(1, this.settings.dbRetentionDays);
        const snapshots = raw?.indexSignatures;
        if (snapshots && typeof snapshots === 'object' && !Array.isArray(snapshots)) {
            for (const [key, value] of Object.entries(snapshots)) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
                const valid: Record<string, FileSignature> = {};
                for (const [path, signature] of Object.entries(value as Record<string, unknown>)) {
                    const sig = signature as FileSignature | null;
                    if (sig && Number.isFinite(sig.mtime) && Number.isFinite(sig.size)) valid[path] = { ...sig };
                }
                this.signatureSnapshots[key] = valid;
            }
        }
        this.signatureKey = '';
        this.selectSignatureSnapshot();
    }

    private indexEndpointKey(): string {
        return [this.settings.backendMode, this.settings.backendUrl.replace(/\/$/, ''), this.vaultId].join('\0');
    }

    public getIndexIdentity(): string {
        return [this.indexEndpointKey(), this.settings.apiToken, this.indexGeneration].join('\0');
    }

    private selectSignatureSnapshot(): void {
        const key = this.indexEndpointKey();
        if (this.signatureKey === key) return;
        this.signatureKey = key;
        this.fileSignatures = this.signatureSnapshots[key] || {};
        this.signatureSnapshots[key] = this.fileSignatures;
        this.indexedPaths = new Set();
        this.reconciliationPending = true;
        this.reconciliationStatus = 'unknown';
        this.indexGeneration++;
        this.radar?.invalidateForSettingsChange();
        this.syncManager?.setConnectionReady(false);
    }

    public savePluginData(): Promise<void> {
        this.signatureSnapshots[this.signatureKey] = this.fileSignatures;
        const snapshot = JSON.parse(JSON.stringify({ ...this.settings, indexSignatures: this.signatureSnapshots })) as unknown;
        const save = this.dataSave.catch(() => undefined).then(() => this.saveData(snapshot));
        this.dataSave = save;
        return save;
    }

    private persistIndexState(): void {
        void this.savePluginData().catch(error => {
            this.reconciliationStatus = 'failed';
            console.error('Semantix: Could not persist successful index signatures.', error);
            new Notice('Semantix: 索引同步记录保存失败；下次连接将重新核对。');
        });
    }

    async saveSettings() {
        this.selectSignatureSnapshot();
        await this.savePluginData();
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

    public resetAdaptiveFilteringPreparation(): void {
        this.adaptivePreparationGeneration++;
        this.adaptivePreparation = 'idle';
        this.adaptivePreparationTask = null;
        this.adaptivePreparationKey = this.currentAdaptivePreparationKey();
    }

    public queueAdaptiveRefresh(): void {
        this.adaptiveRefreshPending = true;
    }

    private setVaultStopwords(words: string[]): void {
        this.vaultStopwords = words;
        this.settingTab?.refreshAdaptiveStopwordsDisplay();
    }

    private flushAdaptiveRefresh(): void {
        if (!this.adaptiveRefreshPending || this.adaptivePreparation === 'pending') return;
        this.adaptiveRefreshPending = false;
        if (this.radar) void this.radar.refreshCurrentScope();
    }

    public isAdaptiveFilteringEffective(): boolean {
        return this.settings.enableAdaptiveFiltering
            && this.getConnectionStatus() === 'connected'
            && this.apiClient.supportsAdaptiveSoftFiltering()
            && this.adaptivePreparationKey === this.currentAdaptivePreparationKey()
            && this.adaptivePreparation === 'ready';
    }

    public isAdaptiveFilteringPreparing(): boolean {
        return this.settings.enableAdaptiveFiltering && this.adaptivePreparation === 'pending';
    }

    private currentAdaptivePreparationKey(): string {
        return [this.settings.backendMode, this.settings.backendUrl, this.settings.apiToken, this.vaultId].join('\0');
    }

    private async prepareAdaptiveFiltering(): Promise<void> {
        if (this.adaptivePreparationKey !== this.currentAdaptivePreparationKey()) {
            this.resetAdaptiveFilteringPreparation();
        }
        if (!this.settings.enableAdaptiveFiltering || !this.apiClient.supportsAdaptiveSoftFiltering()) return;
        if (this.adaptivePreparationTask) {
            await this.adaptivePreparationTask;
            return;
        }
        if (this.adaptivePreparation !== 'idle') return;
        await this.runAdaptivePreparation(true);
    }


    public getExclusionMatcher(): ExclusionMatcher {
        return new ExclusionMatcher(this.settings.exclusionRules || '');
    }

    public getExcludedPathsForQuery(): string[] {
        const matcher = this.getExclusionMatcher();
        const knownPaths = new Set<string>();
        for (const f of this.app.vault.getMarkdownFiles()) {
            knownPaths.add(f.path);
        }
        for (const p of new Set([...Object.keys(this.fileSignatures), ...this.indexedPaths])) {
            knownPaths.add(p);
        }
        return matcher.expandToPaths(knownPaths);
    }

    public onPathsIndexed(documents: IndexDocument[]): void {
        for (const doc of documents) {
            if (doc.sourceSignature) this.fileSignatures[doc.path] = { ...doc.sourceSignature };
            if (doc.text) this.indexedPaths.add(doc.path);
            else this.indexedPaths.delete(doc.path);
        }
        this.persistIndexState();
    }

    public onPathsDeleted(paths: string[]): void {
        const deleted = new Set(paths);
        for (const path of paths) {
            delete this.fileSignatures[path];
            this.indexedPaths.delete(path);
        }
        for (const leaf of this.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE)) {
            if (leaf.view instanceof RadarView) leaf.view.filterExcludedCards(path => deleted.has(path));
        }
        this.persistIndexState();
    }

    public async clearVaultIndex(): Promise<boolean> {
        if (this.writeCoordinationState !== 'idle') {
            new Notice('Semantix: 索引操作正在进行中，无法清空。');
            return false;
        }
        this.writeCoordinationState = 'clear';
        const identity = this.getIndexIdentity();
        try {
            await this.syncManager.pause();
            if (identity !== this.getIndexIdentity() || this.unloaded) return false;
            const boundary = this.syncManager.getCurrentRevision();
            const success = await this.apiClient.clearIndex(this.vaultId);
            if (!success || identity !== this.getIndexIdentity() || this.unloaded) return false;
            this.syncManager.dropWorkBefore(boundary);
            this.fileSignatures = {};
            this.indexedPaths.clear();
            this.signatureSnapshots[this.signatureKey] = this.fileSignatures;
            // A deliberate clear stays clear until later file events or explicit rebuild.
            this.reconciliationPending = false;
            this.reconciliationStatus = 'checked';
            this.radar.onFileOpen(null);
            try { await this.savePluginData(); }
            catch (error) {
                this.reconciliationStatus = 'failed';
                console.error('Semantix: Index was cleared but sync record persistence failed.', error);
                new Notice('Semantix: 索引已清空，但同步记录保存失败。');
            }
            return true;
        } finally {
            this.writeCoordinationState = 'idle';
            this.syncManager.resume();
        }
    }

    public async reconcileVaultIndex(): Promise<void> {
        if (this.unloaded || this.writeCoordinationState !== 'idle' || this.getConnectionStatus() !== 'connected') return;
        this.writeCoordinationState = 'reconciliation';
        this.reconciliationPending = false;
        this.reconciliationStatus = 'checking';
        const identity = this.getIndexIdentity();
        try {
            await this.syncManager.pause();
            if (identity !== this.getIndexIdentity() || this.unloaded) return;
            if (!this.apiClient.supportsIndexedPaths()) {
                this.reconciliationStatus = 'unavailable';
                return;
            }
            const paths = await this.apiClient.getIndexedPaths();
            if (identity !== this.getIndexIdentity() || this.unloaded) return;
            if (paths === null) {
                this.reconciliationStatus = 'failed';
                return;
            }
            this.indexedPaths = new Set(paths);
            const files = this.app.vault.getMarkdownFiles();
            const validPaths = new Set(files.filter(file => !this.syncManager.isExcludedPath(file.path)).map(file => file.path));
            const deletes = paths.filter(path => !validPaths.has(path));
            const updates = files.filter(file => {
                if (!validPaths.has(file.path)) return false;
                const signature = this.fileSignatures[file.path];
                return !this.indexedPaths.has(file.path) || !signature
                    || signature.mtime !== file.stat.mtime || signature.size !== file.stat.size;
            });
            this.syncManager.dropNewlyExcludedUpdates();
            this.syncManager.queueReconciliation(updates, deletes);
            this.reconciliationStatus = 'checked';
        } catch (error) {
            this.reconciliationStatus = 'failed';
            console.error('Semantix: Vault index reconciliation failed.', error);
        } finally {
            this.writeCoordinationState = 'idle';
            this.syncManager.resume();
            this.settingTab?.refreshStatusDisplay();
        }
    }

    public async onSearchSettingChanged(settingKey?: string): Promise<void> {
        this.radar.invalidateForSettingsChange();
        this.radar.cancelDebounceTimers();
        if (settingKey === 'exclusionRules') {
            const matcher = this.getExclusionMatcher();
            for (const leaf of this.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE)) {
                if (leaf.view instanceof RadarView) leaf.view.filterExcludedCards(path => matcher.isExcluded(path));
            }
            this.syncManager.dropNewlyExcludedUpdates();
            this.indexGeneration++;
            this.reconciliationPending = true;
            this.reconciliationStatus = 'unknown';
        }
        if (this.searchSettingsTimer !== null) window.clearTimeout(this.searchSettingsTimer);
        // Invalidate immediately, then coalesce text/slider input before health preparation and refresh.
        this.searchSettingsTimer = window.setTimeout(() => {
            this.searchSettingsTimer = null;
            this.queueAdaptiveRefresh();
            void this.saveSettings().then(() => this.flushAdaptiveRefresh()).catch(error => {
                console.error('Semantix: Could not apply search settings.', error);
                new Notice('Semantix: 搜索设置保存失败，请重试。');
            });
        }, 250);
    }

    public async recalculateAdaptiveFiltering(): Promise<AdaptiveStopwordsResult | null | undefined> {
        this.resetAdaptiveFilteringPreparation();
        return this.runAdaptivePreparation(false);
    }

    private async runAdaptivePreparation(notifyFailure: boolean): Promise<AdaptiveStopwordsResult | null | undefined> {
        const generation = this.adaptivePreparationGeneration;
        const key = this.adaptivePreparationKey;
        this.adaptivePreparation = 'pending';
        const task = (async () => {
            const result = await this.apiClient.computeStopwords();
            if (generation !== this.adaptivePreparationGeneration
                || key !== this.currentAdaptivePreparationKey()) return undefined;
            if (result?.words) {
                this.setVaultStopwords(result.words);
                this.adaptivePreparation = 'ready';
                return result;
            } else {
                this.adaptivePreparation = 'failed';
                if (notifyFailure) new Notice(t('STOPWORDS_FAILED'));
                return null;
            }
        })();
        this.adaptivePreparationTask = task;
        try {
            return await task;
        } finally {
            if (this.adaptivePreparationTask === task) this.adaptivePreparationTask = null;
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
