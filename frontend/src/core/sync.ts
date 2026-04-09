import { TFile, TAbstractFile } from 'obsidian';
import SemantixPlugin from '../main';
import { IndexDocument } from '../api/types';
import { cleanMarkdown } from '../utils/markdown';
import picomatch from 'picomatch';

export class SyncManager {
    plugin: SemantixPlugin;
    
    // 待更新队列 (upsert)
    private pendingUpdates: Set<string> = new Set();
    // 待删除队列
    private pendingDeletes: Set<string> = new Set();
    
    private syncTimer: number | null = null;
    private isFlushing: boolean = false;

    private cachedRulesStr: string | null = null;
    private cachedMatchers: any[] = [];

    constructor(plugin: SemantixPlugin) {
        this.plugin = plugin;
    }

    /**
     * 排队并准备读取修改/创建的文件
     */
    public queueUpdate(file: TAbstractFile) {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        
        // Check exclusion rules
        if (this.isExcluded(file.path)) return;

        this.pendingUpdates.add(file.path);
        // 如果文件同时在删除队列里，移除它 (意味着它被重建/覆盖了)
        this.pendingDeletes.delete(file.path);

        console.debug(`Semantix: Queued update for ${file.path}`);
        this.startTimerIfNeeded();
    }

    /**
     * 排队准备删除的文件
     */
    public queueDelete(file: TAbstractFile) {
        if (!(file instanceof TFile) || file.extension !== 'md') return;

        this.pendingDeletes.add(file.path);
        // 如果正在等待更新，取消更新
        this.pendingUpdates.delete(file.path);

        console.debug(`Semantix: Queued delete for ${file.path}`);
        this.startTimerIfNeeded();
    }

    /**
     * 重命名处理：当作旧文件删除 + 新文件创建
     */
    public queueRename(file: TAbstractFile, oldPath: string) {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        
        this.pendingDeletes.add(oldPath);
        this.pendingUpdates.delete(oldPath);
        
        this.queueUpdate(file); // 内部包含了排重和 Timer
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
            } catch (e) {
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
    private startTimerIfNeeded() {
        if (this.syncTimer !== null || this.isFlushing) return; // 已经在跑了或正在 flush

const intervalMs = this.plugin.settings.syncBatchInterval * 1000;
        
        this.syncTimer = window.setTimeout(async () => {
            this.syncTimer = null;
            await this.flushQueue();
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
     * 执行批量同步
     */
    public async flushQueue() {
        if (this.isFlushing) return;
        if (this.pendingUpdates.size === 0 && this.pendingDeletes.size === 0) {
            return;
        }
        this.isFlushing = true;

        console.log(`Semantix Sync: Flushing queue. Deletes: ${this.pendingDeletes.size}, Updates: ${this.pendingUpdates.size}`);

        try {
            // 浅拷贝当前队列并立即清空原始队列，防止在异步执行过程中新来的变更丢失
            const currentUpdates = Array.from(this.pendingUpdates);
            const currentDeletes = Array.from(this.pendingDeletes);
            
            this.pendingUpdates.clear();
            this.pendingDeletes.clear();

            const totalTasks = currentUpdates.length + currentDeletes.length;
            let processed = 0;
            const canReportProgress = () => {
                const state = this.plugin.getIndexingState();
                return !(state.active && state.label === "full");
            };
            if (canReportProgress()) {
                this.plugin.updateIndexingProgress(processed, totalTasks, true, "sync");
            }

            // 1. 处理删除
            if (currentDeletes.length > 0) {
                await this.plugin.apiClient.indexDelete({ vault_id: this.plugin.vaultId, paths: currentDeletes });
                processed += currentDeletes.length;
                if (canReportProgress()) {
                    this.plugin.updateIndexingProgress(processed, totalTasks, true, "sync");
                }
            }

            // 2. 处理更新/写入
            if (currentUpdates.length > 0) {
                const documents: IndexDocument[] = [];
                
                for (const path of currentUpdates) {
                    const file = this.plugin.app.vault.getAbstractFileByPath(path);
                    if (file instanceof TFile && file.extension === 'md') {
                        // 读取文件内容
                        const rawText = await this.plugin.app.vault.cachedRead(file);
                        const cleaned = cleanMarkdown(rawText);
                        if (cleaned.length === 0) continue;
                        
                        documents.push({ vault_id: this.plugin.vaultId, path: path, text: cleaned });
                    }
                    processed += 1;
                    if (canReportProgress()) {
                        this.plugin.updateIndexingProgress(processed, totalTasks, true, "sync");
                    }
                }

                if (documents.length > 0) {
                    await this.plugin.apiClient.indexBatch({ documents });
                }
            }
        } finally {
            this.isFlushing = false;

            // 同步完成后刷新侧边栏索引计数
            this.plugin.checkConnection();
            const state = this.plugin.getIndexingState();
            if (!(state.active && state.label === "full")) {
                this.plugin.clearIndexingProgress();
            }

            if (this.pendingUpdates.size > 0 || this.pendingDeletes.size > 0) {
                this.startTimerIfNeeded();
            }
        }
    }
}
