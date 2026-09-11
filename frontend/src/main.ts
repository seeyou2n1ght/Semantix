import { Plugin, Notice, WorkspaceLeaf, TAbstractFile, TFile, MarkdownView, Platform } from 'obsidian';
import { SemantixSettings, DEFAULT_SETTINGS, SemantixSettingTab } from "./settings";
import { ApiClient } from './api/client';
import { IndexDocument } from './api/types';
import { WhispererView, WHISPERER_VIEW_TYPE } from './ui/whisperer-view';
import { SyncManager } from './core/sync';
import { Whisperer } from './core/whisperer';
import { ServiceManager } from './core/service-manager';
import { cleanMarkdown } from './utils/markdown';
import { t } from './i18n/helpers';

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
        this.whisperer = new Whisperer(this);
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
                this.checkConnection({ silent: true });
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
                setTimeout(() => {
                    noticeToClose?.hide();
                }, 4000);
            }
        });

        // 2.1 注册 CodeMirror 扩展（光标活动监听）
        if (!this.isMobileHibernating) {
            this.registerEditorExtension(this.whisperer.getCursorActivityExtension());
        }

        // 3. 注册配置面板与底部状态栏
        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.addClass('semantix-status-bar-item');

        this.settingTab = new SemantixSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);

        // 4. 注册单一 Semantix Radar 侧栏视图
        this.registerView(
            WHISPERER_VIEW_TYPE,
            (leaf) => new WhispererView(leaf, this)
        );

        // 5. Ribbon Icon —— 打开 Semantix Radar 视图
        this.addRibbonIcon('radar', `${t('PLUGIN_NAME')}: Radar`, () => {
            this.activateWhispererView();
        });

        // 6. 全局命令
        this.addCommand({
            id: 'open-sidebar',
            name: `${t('PLUGIN_NAME')}: Open sidebar`,
            callback: () => {
                this.activateWhispererView();
            }
        });
        this.addCommand({
            id: 'scan-note',
            name: `${t('PLUGIN_NAME')}: Scan whole note`,
            callback: () => {
                this.activateWhispererView();
                this.whisperer.triggerNoteScan();
            }
        });

        // 7. 工作区就绪后打开视图、探活并注册文件增量监听
        this.app.workspace.onLayoutReady(async () => {
            if (!this.isMobileHibernating) {
                this.activateWhispererView();

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
                    this.serviceManager.start();
                }
                // 初次自检设为静默，避免启动瞬间的竞态导致误报
                this.checkConnection({ silent: true });
                this.startHealthTimer();
            }
        });

        // 8. 注册 Whisperer 事件（移动端禁用时不注册）
        if (!this.isMobileHibernating) {
            this.registerEvent(this.app.workspace.on('file-open', (file) => {
                this.whisperer.onFileOpen(file);
            }));
            
            this.registerEvent(this.app.workspace.on('editor-change', (editor, view) => {
                if (view instanceof MarkdownView) {
                    this.whisperer.onEditorChange(editor, view);
                }
            }));
        }

        // eslint-disable-next-line no-console
        console.log("Semantix Plugin loaded.");
    }

    /**
     * 打开或聚焦 Whisperer 视图
     */
    async activateWhispererView() {
        await this.activateViewByType(WHISPERER_VIEW_TYPE);
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
            } else {
                // 未运行且非主动停止：如果开启了自启，尝试触发自愈机制
                if (this.settings.autoStartServer) {
                    this.serviceManager.triggerSelfHealing("检测到服务未运行");
                }
                this.updateAllViewStatus('disabled');
                return;
            }
        }

        // 2. 只有非 Disabled 状态才进行心跳检测
        const isConnected = await this.apiClient.checkHealth();
        if (isConnected) {
            this.apiClient.ping(); // 同时发送后端存活心跳（异步执行，不阻塞 UI）
            this.serviceManager.onHealthyStable(); // 重置连续失败熔断计数
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
            
            // eslint-disable-next-line no-console
            console.log("Semantix: Backend connection successful.");
            
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
            
            // eslint-disable-next-line no-console
            console.log("Semantix: Backend connection failed.");
        }

        // 4. 更新 UI 状态
        this.updateAllViewStatus(nextStatus);
    }

    /**
     * 批量更新所有已打开视图的连接状态
     */
    public updateAllViewStatus(status: 'connected' | 'disconnected' | 'syncing' | 'disabled') {
        this.lastConnectionStatus = status; // 同步内部状态标签
        for (const leaf of this.app.workspace.getLeavesOfType(WHISPERER_VIEW_TYPE)) {
            if (leaf.view instanceof WhispererView) {
                (leaf.view as WhispererView).updateStatus(status);
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
        for (const leaf of this.app.workspace.getLeavesOfType(WHISPERER_VIEW_TYPE)) {
            if (leaf.view instanceof WhispererView) {
                (leaf.view as WhispererView).updateIndexStatus(totalNotes, lastUpdated);
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
        for (const leaf of this.app.workspace.getLeavesOfType(WHISPERER_VIEW_TYPE)) {
            if (leaf.view instanceof WhispererView) {
                (leaf.view as WhispererView).updateIndexingProgress(state);
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
            const confirmMessage = [
                `将索引约 ${files.length} 篇笔记，预计耗时数分钟。`,
                "索引进度不会持久化，关闭窗口或重启将重置进度。",
                "是否继续？"
            ].join("\n");

            // eslint-disable-next-line no-alert
            if (!confirm(confirmMessage)) {
                return;
            }
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

        // 微任务与帧间空闲让渡函数，确保 UI 60fps 平滑不卡顿
        const yieldToMain = (): Promise<void> => {
            return new Promise((resolve) => {
                if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
                    window.requestIdleCallback(() => resolve(), { timeout: 30 });
                } else {
                    setTimeout(resolve, 16);
                }
            });
        };

        try {
            let currentBatchDocs: IndexDocument[] = [];
            let currentBatchChars = 0;

            const flushBatch = async (): Promise<boolean> => {
                if (currentBatchDocs.length === 0) return true;
                const result = await this.apiClient.indexBatch({ documents: currentBatchDocs });
                if (!result || result.status !== 'success') {
                    new Notice("Semantix: 索引失败，请检查后端日志。");
                    return false;
                }
                currentBatchDocs = [];
                currentBatchChars = 0;
                await yieldToMain();
                return true;
            };

            for (const file of files) {
                if (this.fullIndexCancelRequested) {
                    canceled = true;
                    break;
                }

                const rawText = await this.app.vault.cachedRead(file);
                const cleaned = cleanMarkdown(rawText);
                processed += 1;

                if (cleaned.length > 0) {
                    const context = this.getFileContext(file);
                    currentBatchDocs.push({ 
                        vault_id: this.vaultId, 
                        path: file.path, 
                        text: cleaned,
                        tags: context.tags,
                        links: context.links
                    });
                    currentBatchChars += cleaned.length;

                    // 若达到单批篇数或字符上限，立即发射并让渡事件循环
                    if (currentBatchDocs.length >= maxBatchDocs || currentBatchChars >= maxBatchChars) {
                        const success = await flushBatch();
                        if (!success) {
                            canceled = true;
                            break;
                        }
                    }
                }

                this.updateIndexingProgress(processed, files.length, true, "full");
                if (indexingNotice && (processed % 5 === 0 || processed === files.length)) {
                    const pct = Math.min(100, Math.round((processed / files.length) * 100));
                    indexingNotice.setMessage(`Semantix: 正在构建索引... ${pct}% (${processed}/${files.length})`);
                }
            }

            // 发射最后一批残留文档
            if (!canceled && currentBatchDocs.length > 0) {
                const success = await flushBatch();
                if (!success) canceled = true;
            }

            completed = !canceled && processed >= files.length;
        } catch (error) {
            // eslint-disable-next-line no-console
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
            await this.checkConnection();

            if (completed) {
                // 显式触发 FTS 倒排索引构建，实现即时全文检索支持
                await this.apiClient.rebuildFtsIndex();
                new Notice(`Semantix: 全量索引完成 ✅ (共 ${files.length} 篇笔记，全文索引已就绪)`);
                if (this.whisperer) {
                    this.whisperer.triggerNoteScan();
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
        // eslint-disable-next-line no-console
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
            // eslint-disable-next-line no-console
            console.log("Semantix: Hibernating on mobile.");
        }
    }

    private startHealthTimer() {
        if (this.healthTimer !== null) return;
        this.healthTimer = window.setInterval(() => {
            this.checkConnection({ silent: true });
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
                    const fTags = cache.frontmatter.tags;
                    if (Array.isArray(fTags)) {
                        fTags.forEach(t => tags.push(String(t).replace(/^#/, '')));
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
