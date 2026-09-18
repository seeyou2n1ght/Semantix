import { TFile, TFolder, TAbstractFile } from 'obsidian';
import SemantixPlugin from '../main';
import { IndexDocument } from '../api/types';
import { cleanMarkdown } from '../utils/markdown';
import picomatch from 'picomatch';

export class SyncManager {
    plugin: SemantixPlugin;
    
    // 待更新队列 (path -> revision counter)
    private pendingUpdates: Map<string, number> = new Map();
    // 待删除队列
    private pendingDeletes: Set<string> = new Set();
    
    private syncTimer: number | null = null;
    private isFlushing: boolean = false;
    private isPaused: boolean = false;
    private flushPromise: Promise<void> | null = null;
    private retryAttempts: number = 0;

    private cachedRulesStr: string | null = null;
    private cachedMatchers: ((path: string) => boolean)[] = [];

    constructor(plugin: SemantixPlugin) {
        this.plugin = plugin;
    }

    /**
     * 暂停增量同步（如全量索引期间），仅积累队列，不向后端发送请求。
     * 若当前正在执行 flushQueue，等待当前执行完毕。
     */
    public async pause(): Promise<void> {
        this.isPaused = true;
        this.clearTimer();
        if (this.flushPromise) {
            try {
                await this.flushPromise;
            } catch {
                // ignore
            }
        }
    }

    /**
     * 恢复增量同步并触发积压队列处理
     */
    public resume() {
        this.isPaused = false;
        if (this.pendingUpdates.size > 0 || this.pendingDeletes.size > 0) {
            this.startTimerIfNeeded();
        }
    }

    /**
     * 清空所有积压队列（用于初始化与重置，防止启动时伪事件积压）
     */
    public clearQueue() {
        this.clearTimer();
        this.pendingUpdates.clear();
        this.pendingDeletes.clear();
    }

    /**
     * 排队并准备读取修改/创建的文件
     */
    public queueUpdate(file: TAbstractFile) {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        
        // Check exclusion rules
        if (this.isExcluded(file.path)) return;

        const nextRev = (this.pendingUpdates.get(file.path) ?? 0) + 1;
        this.pendingUpdates.set(file.path, nextRev);
        // 如果文件同时在删除队列里，移除它 (意味着它被重建/覆盖了)
        this.pendingDeletes.delete(file.path);

        this.startTimerIfNeeded();
    }

    /**
     * 排队准备删除的文件
     */
    public queueDelete(file: TAbstractFile) {
        if (file instanceof TFile) {
            if (file.extension !== 'md') return;

            this.pendingDeletes.add(file.path);
            // 如果正在等待更新，取消更新
            this.pendingUpdates.delete(file.path);

            this.startTimerIfNeeded();
        } else if (file instanceof TFolder) {
            // 文件夹删除时，将该文件夹下的所有待更新项清理并标记删除
            const prefix = file.path.endsWith('/') ? file.path : `${file.path}/`;
            for (const p of Array.from(this.pendingUpdates.keys())) {
                if (p.startsWith(prefix)) {
                    this.pendingUpdates.delete(p);
                    this.pendingDeletes.add(p);
                }
            }
            this.startTimerIfNeeded();
        }
    }

    /**
     * 重命名处理：当作旧文件删除 + 新文件创建
     */
    public queueRename(file: TAbstractFile, oldPath: string) {
        if (file instanceof TFile) {
            if (oldPath.endsWith('.md')) {
                this.pendingDeletes.add(oldPath);
                this.pendingUpdates.delete(oldPath);
            }
            if (file.extension === 'md') {
                this.queueUpdate(file);
            } else {
                this.startTimerIfNeeded();
            }
        } else if (file instanceof TFolder) {
            // 递归处理文件夹重命名中的所有 markdown 文件
            const queueFolderFiles = (folder: TFolder, currentOldPrefix: string) => {
                for (const child of folder.children) {
                    if (child instanceof TFile && child.extension === 'md') {
                        const childOldPath = `${currentOldPrefix}/${child.name}`;
                        this.queueRename(child, childOldPath);
                    } else if (child instanceof TFolder) {
                        queueFolderFiles(child, `${currentOldPrefix}/${child.name}`);
                    }
                }
            };
            queueFolderFiles(file, oldPath);
            this.startTimerIfNeeded();
        }
    }

    /**
     * 校验文件是否包含在 Exclusion Rules 排除列表中
     */
    private isExcluded(path: string): boolean {
        const rulesStr = this.plugin.settings.exclusionRules || "";
        
        if (this.cachedRulesStr !== rulesStr) {
            this.cachedRulesStr = rulesStr;
            this.cachedMatchers = [];
            const rules = rulesStr.split('\n').map(r => r.trim()).filter(r => r.length > 0);
            
            for (const r of rules) {
                let globRule = r;
                // Downward compatibility: If rule doesn't contain glob characters, make it a prefix match
                if (!r.includes('*') && !r.includes('?') && !r.includes('[') && !r.includes(']')) {
                    if (r.endsWith('/')) {
                        globRule = `${r}**`;
                    } else if (r.includes('.')) {
                        // Keep as is for file matches (picomatch natively handles it or we could use **/${r})
                    } else {
                        globRule = `${r}/**`;
                    }
                }

                try {
                    this.cachedMatchers.push(picomatch(globRule));
                } catch (e) {
                    console.error(`Semantix: Invalid glob matching rule "${globRule}":`, e);
                }
            }
        }
        
        for (const isMatch of this.cachedMatchers) {
            try {
                if (isMatch(path)) return true;
            } catch {
                // Ignore matching errors for invalid paths against a rule
            }
        }
        return false;
    }

    public isExcludedPath(path: string): boolean {
        return this.isExcluded(path);
    }

    /**
     * 启动定时器（如果尚未启动）
     */
    private startTimerIfNeeded(delayMs?: number) {
        if (this.syncTimer !== null || this.isFlushing || this.isPaused) return;

        const defaultIntervalMs = this.plugin.settings.syncBatchInterval * 1000;
        const intervalMs = delayMs !== undefined ? delayMs : defaultIntervalMs;
        
        this.syncTimer = window.setTimeout(() => {
            this.syncTimer = null;
            void this.flushQueue();
        }, intervalMs);
    }

    /**
     * 清空定时器（用于 onunload 时调用）
     */
    public clearTimer() {
        if (this.syncTimer !== null) {
            window.clearTimeout(this.syncTimer);
            this.syncTimer = null;
        }
    }

    /**
     * 执行批量同步（两阶段确认机制 + 空文档删除）
     */
    public async flushQueue(): Promise<void> {
        if (this.isFlushing || this.isPaused) return;
        if (this.pendingUpdates.size === 0 && this.pendingDeletes.size === 0) {
            return;
        }
        this.isFlushing = true;
        const promise = this.doFlush();
        this.flushPromise = promise;
        try {
            await promise;
        } finally {
            this.isFlushing = false;
            this.flushPromise = null;
        }
    }

    private async doFlush(): Promise<void> {
        try {
            // 提取当前待处理项快照及当前版本号，待服务端确认成功后再比对移除
            const inFlightUpdates = new Map(this.pendingUpdates);
            const inFlightDeletes = new Set(this.pendingDeletes);
            const currentUpdates = Array.from(inFlightUpdates.keys());
            const currentDeletes = Array.from(inFlightDeletes);

            const emptyFilesToPurge: string[] = [];
            const documents: IndexDocument[] = [];

            for (const path of currentUpdates) {
                const file = this.plugin.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile && file.extension === 'md') {
                    const rawText = await this.plugin.app.vault.cachedRead(file);
                    const cleaned = cleanMarkdown(rawText);
                    if (cleaned.length === 0) {
                        // 空文档语义：从索引中删除历史旧数据
                        emptyFilesToPurge.push(path);
                    } else {
                        const context = this.plugin.getFileContext(file);
                        documents.push({ 
                            vault_id: this.plugin.vaultId, 
                            path: path, 
                            text: cleaned,
                            tags: context.tags,
                            links: context.links
                        });
                    }
                }
            }

            const allDeletes = Array.from(new Set([...currentDeletes, ...emptyFilesToPurge]));
            const totalTasks = documents.length + allDeletes.length;
            let processed = 0;

            const canReportProgress = () => {
                const state = this.plugin.getIndexingState();
                return !(state.active && state.label === "full");
            };
            if (canReportProgress()) {
                this.plugin.updateIndexingProgress(processed, totalTasks, true, "sync");
            }

            let anyFailure = false;

            // 1. 处理删除任务（包含明确删除的文件与变为空白的文件）
            if (allDeletes.length > 0) {
                const delRes = await this.plugin.apiClient.indexDelete({ vault_id: this.plugin.vaultId, paths: allDeletes });
                if (delRes && delRes.status === 'success') {
                    for (const p of currentDeletes) {
                        this.pendingDeletes.delete(p);
                    }
                    for (const p of emptyFilesToPurge) {
                        if (this.pendingUpdates.get(p) === inFlightUpdates.get(p)) {
                            this.pendingUpdates.delete(p);
                        }
                    }
                } else {
                    anyFailure = true;
                    console.warn("Semantix Sync: Delete batch failed, will retry.");
                }
                processed += allDeletes.length;
                if (canReportProgress()) {
                    this.plugin.updateIndexingProgress(processed, totalTasks, true, "sync");
                }
            }

            // 2. 处理更新任务
            if (documents.length > 0) {
                const batchRes = await this.plugin.apiClient.indexBatch({ documents });
                if (batchRes && batchRes.status === 'success') {
                    const failedSet = new Set(batchRes.failed_paths || []);
                    for (const doc of documents) {
                        if (!failedSet.has(doc.path)) {
                            // 仅当文件在网络请求期间没有发生新修改时才从队列移除
                            if (this.pendingUpdates.get(doc.path) === inFlightUpdates.get(doc.path)) {
                                this.pendingUpdates.delete(doc.path);
                            }
                        }
                    }
                    if (failedSet.size > 0) {
                        anyFailure = true;
                    }
                } else {
                    anyFailure = true;
                    console.warn("Semantix Sync: Batch upsert failed, will retry.");
                }
                processed += documents.length;
                if (canReportProgress()) {
                    this.plugin.updateIndexingProgress(processed, totalTasks, true, "sync");
                }
            }

            if (!anyFailure) {
                this.retryAttempts = 0;
            } else {
                this.retryAttempts += 1;
            }
        } finally {
            this.isFlushing = false;

            // 同步完成后刷新侧边栏索引计数
            void this.plugin.checkConnection();
            const state = this.plugin.getIndexingState();
            if (!(state.active && state.label === "full")) {
                this.plugin.clearIndexingProgress();
            }

            // 若仍有未完成的积压项，且未被 pause，使用指数退避触发下一次重试
            if (!this.isPaused && (this.pendingUpdates.size > 0 || this.pendingDeletes.size > 0)) {
                const backoffDelay = Math.min(30000, Math.max(1000, Math.pow(2, this.retryAttempts) * 1000));
                this.startTimerIfNeeded(backoffDelay);
            }
        }
    }
}
