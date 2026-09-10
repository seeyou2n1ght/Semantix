import { App, PluginSettingTab, Setting, Notice, Platform } from "obsidian";
import SemantixPlugin from "./main";
import { t } from "./i18n/helpers";
import { getElectronNodeModule } from "./utils/node-adapter";

interface FsModule {
    existsSync: (path: string) => boolean;
    statSync: (path: string) => { isDirectory: () => boolean };
}

interface PathModule {
    join: (...paths: string[]) => string;
}

interface ChildProcessModule {
    exec: (command: string, callback?: (error: Error | null, stdout: string, stderr: string) => void) => unknown;
}

function getFs(): FsModule | null {
    return getElectronNodeModule<FsModule>('fs');
}

function getPath(): PathModule | null {
    return getElectronNodeModule<PathModule>('path');
}

function getChildProcess(): ChildProcessModule | null {
    return getElectronNodeModule<ChildProcessModule>('child_process');
}

export interface SemantixSettings {
    // 1. 引擎连接 (Engine Connection)
    backendMode: 'local' | 'remote';
    backendUrl: string;
    apiToken: string;
    autoStartServer: boolean;
    pythonPath: string;
    backendPath: string;

    // 2. 写作与灵感推荐 (Writing & Discovery)
    rankingMode: 'fast' | 'balanced' | 'high_quality';
    topNResults: number;
    debounceDelay: number;
    autoTrigger: boolean;
    mmrLambda: number;
    exclusionRules: string;

    // 3. 知识库索引 (Vault Indexing)
    syncBatchInterval: number;

    // 4. 移动端 (Mobile)
    enableOnMobile: boolean;

    // 5. 存储维护 (Storage Maintenance)
    dbRetentionDays: number;
    enableAdaptiveFiltering: boolean;
}

export const DEFAULT_SETTINGS: SemantixSettings = {
    backendMode: 'local',
    backendUrl: 'http://localhost:8000',
    apiToken: '',
    autoStartServer: false,
    pythonPath: 'uv',
    backendPath: '',

    rankingMode: 'balanced',
    topNResults: 4,
    debounceDelay: 400,
    autoTrigger: true,
    mmrLambda: 0.65,
    exclusionRules: '',

    syncBatchInterval: 60,

    enableOnMobile: false,

    dbRetentionDays: 7,
    enableAdaptiveFiltering: false
};

export class SemantixSettingTab extends PluginSettingTab {
    plugin: SemantixPlugin;
    private pythonStatus: string = "";
    private backendStatus: string = "";
    private showPythonInput: boolean = false;
    private debounceTimer: number | null = null;
    private isEditingExclusions: boolean = false;
    private isAdvancedOpen: boolean = false;

    // DB Metrics 缓存
    private dbMetrics: {
        db_size_bytes?: number;
        last_maintenance_at?: string;
        total_indexed_docs?: number;
        last_index_at?: string;
        [key: string]: unknown;
    } | null = null;

    constructor(app: App, plugin: SemantixPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    private updateStatus(type: 'python' | 'backend', status: string): void {
        if (type === 'python') this.pythonStatus = status;
        else this.backendStatus = status;
        this.display();
    }

    public refreshStatusDisplay(): void {
        this.display();
    }

    private formatBytes(bytes?: number): string {
        if (!bytes || bytes <= 0) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
    }

    private formatRelativeTime(isoString?: string): string {
        if (!isoString) return "";
        try {
            const date = new Date(isoString);
            const now = new Date();
            const diffMs = now.getTime() - date.getTime();
            if (diffMs < 60000) return "刚刚";
            const diffMins = Math.floor(diffMs / 60000);
            if (diffMins < 60) return `${diffMins} 分钟前`;
            const diffHours = Math.floor(diffMins / 60);
            if (diffHours < 24) return `${diffHours} 小时前`;
            const diffDays = Math.floor(diffHours / 24);
            return `${diffDays} 天前`;
        } catch {
            return isoString;
        }
    }

    private async validatePython(pythonPath: string): Promise<void> {
        if (!Platform.isDesktop || !pythonPath) {
            this.updateStatus('python', "");
            return;
        }
        const cp = getChildProcess();
        if (!cp) return;

        this.pythonStatus = t('VALIDATING_PYTHON');
        this.display();

        cp.exec(`"${pythonPath}" --version`, (error, stdout, stderr) => {
            if (error) {
                this.updateStatus('python', t('PYTHON_INVALID') + ` (${error.message.split('\n')[0]})`);
            } else {
                const version = (stdout?.trim() || stderr?.trim() || "");
                this.updateStatus('python', t('PYTHON_IDENTIFIED') + version);
            }
        });
    }

    private validateBackend(backendPath: string): void {
        if (!Platform.isDesktop || !backendPath) {
            this.updateStatus('backend', "");
            return;
        }

        const fsMod = getFs();
        const pathMod = getPath();
        if (!fsMod || !pathMod) return;

        try {
            if (!fsMod.existsSync(backendPath)) {
                this.updateStatus('backend', t('PATH_NOT_EXIST'));
                return;
            }

            const stats = fsMod.statSync(backendPath);
            if (!stats.isDirectory()) {
                this.updateStatus('backend', t('PATH_NOT_DIR'));
                return;
            }

            const mainPy = pathMod.join(backendPath, 'main.py');
            if (!fsMod.existsSync(mainPy)) {
                this.updateStatus('backend', t('MAIN_NOT_FOUND'));
                return;
            }

            this.updateStatus('backend', t('PATH_VALID'));
            this.autoDetectPythonEnvironment(backendPath);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            this.updateStatus('backend', `❌ ${errorMsg}`);
        }
    }

    private autoDetectPythonEnvironment(backendPath: string): void {
        if (!Platform.isDesktop) return;
        const fsMod = getFs();
        const pathMod = getPath();
        if (!fsMod || !pathMod) return;

        const isWindows = Platform.isWin;
        const venvPython = isWindows 
            ? pathMod.join(backendPath, '.venv', 'Scripts', 'python.exe')
            : pathMod.join(backendPath, '.venv', 'bin', 'python');

        const uvLock = pathMod.join(backendPath, 'uv.lock');
        if (fsMod.existsSync(uvLock)) {
            this.plugin.settings.pythonPath = 'uv';
            this.plugin.saveSettings();
            this.updateStatus('python', t('UV_DETECTED'));
            return;
        }

        if (fsMod.existsSync(venvPython)) {
            this.plugin.settings.pythonPath = venvPython;
            this.plugin.saveSettings();
            this.updateStatus('python', t('VENV_DETECTED') + venvPython);
        } else {
            this.updateStatus('python', t('VENV_NOT_FOUND'));
        }
    }

    async onOpen(): Promise<void> {
        if (this.plugin.apiClient) {
            this.dbMetrics = await this.plugin.apiClient.getMetrics();
        }
    }

    display(): void {
        const { containerEl } = this;
        const savedScrollTop = containerEl.scrollTop;
        containerEl.empty();

        // 1. 顶部紧凑状态概览
        this.renderStatusHeader(containerEl);

        // 2. 核心区块 1: 推荐体验 (Recommendation)
        this.renderRecommendationSection(containerEl);

        // 3. 核心区块 2: 仓库索引 (Vault Index)
        this.renderVaultIndexSection(containerEl);

        // 4. 核心区块 3: 引擎服务 (Engine)
        this.renderEngineSection(containerEl);

        // 5. 渐进式折叠高级区 (Advanced Settings)
        this.renderAdvancedAccordion(containerEl);

        containerEl.scrollTop = savedScrollTop;
    }

    /**
     * 1. 顶部紧凑状态概览 (System Status Banner)
     */
    private renderStatusHeader(containerEl: HTMLElement): void {
        const bannerEl = containerEl.createEl('div', { cls: 'semantix-status-banner' });
        const infoEl = bannerEl.createEl('div', { cls: 'semantix-status-info' });

        const status = this.plugin.getConnectionStatus();
        const indexingState = this.plugin.getIndexingState();
        const health = this.plugin.apiClient.lastHealthResponse;

        const titleRow = infoEl.createEl('div', { cls: 'semantix-status-title-row' });
        const dotEl = titleRow.createEl('span', { cls: 'semantix-status-dot' });
        const titleTextEl = titleRow.createEl('span', { cls: 'semantix-status-badge' });
        const descEl = infoEl.createEl('div', { cls: 'semantix-status-desc' });

        if (indexingState && indexingState.active) {
            dotEl.addClass('dot-indexing');
            const pct = indexingState.total > 0 
                ? Math.min(100, Math.round((indexingState.current / indexingState.total) * 100))
                : 0;
            titleTextEl.setText(`${t('STATUS_BANNER_INDEXING')} ${pct}% (${indexingState.current}/${indexingState.total})`);
            descEl.setText(`正在分批扫描并构建向量嵌入索引...`);
        } else if (status === 'connected') {
            dotEl.addClass('dot-ready');
            titleTextEl.setText(`Semantix · ${t('STATUS_BANNER_READY')}`);
            const notesCount = this.dbMetrics?.total_indexed_docs ?? 0;
            const modelName = health?.embedding_model ? health.embedding_model.split('/').pop() : 'bge-small-zh-v1.5';
            descEl.setText(`Engine v${health?.engine_version || '0.8.0'} · ${modelName} · ${notesCount} 篇笔记已索引`);
        } else {
            dotEl.addClass('dot-disconnected');
            titleTextEl.setText(`Semantix · ${t('STATUS_BANNER_DISCONNECTED')}`);
            descEl.setText(t('STATUS_BANNER_DISCONNECTED_DESC'));
        }

        const checkBtn = bannerEl.createEl('button', {
            cls: 'mod-cta',
            text: t('BTN_CHECK_CONNECTION')
        });
        checkBtn.onclick = async () => {
            checkBtn.setText(t('TESTING'));
            checkBtn.disabled = true;
            await this.plugin.checkConnection({ manual: true });
            this.dbMetrics = await this.plugin.apiClient.getMetrics();
            this.display();
        };
    }

    /**
     * 2. 推荐体验 (Recommendation)
     */
    private renderRecommendationSection(containerEl: HTMLElement): void {
        new Setting(containerEl).setName(t('SEC_RECOMMENDATION')).setHeading();

        // 2.1 推荐质量策略
        new Setting(containerEl)
            .setName(t('RANKING_QUALITY_NAME'))
            .setDesc(t('RANKING_QUALITY_DESC'))
            .addDropdown(drop => drop
                .addOption('fast', t('RANKING_FAST'))
                .addOption('balanced', t('RANKING_BALANCED'))
                .addOption('high_quality', t('RANKING_ACCURATE'))
                .setValue(this.plugin.settings.rankingMode || 'balanced')
                .onChange(async (val) => {
                    this.plugin.settings.rankingMode = val as 'fast' | 'balanced' | 'high_quality';
                    await this.plugin.saveSettings();
                }));

        // 2.2 单流呈现数量 (2 ~ 8)
        new Setting(containerEl)
            .setName(t('RESULTS_PER_SECTION_NAME'))
            .setDesc(t('RESULTS_PER_SECTION_DESC'))
            .addSlider(slider => slider
                .setLimits(2, 8, 1)
                .setValue(this.plugin.settings.topNResults || 4)
                .setDynamicTooltip()
                .onChange(async (val) => {
                    this.plugin.settings.topNResults = val;
                    await this.plugin.saveSettings();
                }));

        // 2.3 写作实时联想 (打字触发开关)
        new Setting(containerEl)
            .setName(t('UPDATE_WHILE_WRITING_NAME'))
            .setDesc(t('UPDATE_WHILE_WRITING_DESC'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoTrigger ?? true)
                .onChange(async (val) => {
                    this.plugin.settings.autoTrigger = val;
                    await this.plugin.saveSettings();
                }));

        // 2.4 发现流探索度 (MMR 多样性权重)
        new Setting(containerEl)
            .setName(t('MMR_LAMBDA_NAME'))
            .setDesc(t('MMR_LAMBDA_DESC'))
            .addSlider(slider => slider
                .setLimits(0.2, 0.9, 0.05)
                .setValue(this.plugin.settings.mmrLambda ?? 0.65)
                .setDynamicTooltip()
                .onChange(async (val) => {
                    this.plugin.settings.mmrLambda = val;
                    await this.plugin.saveSettings();
                }));
    }

    /**
     * 3. 仓库索引 (Vault Index)
     */
    private renderVaultIndexSection(containerEl: HTMLElement): void {
        new Setting(containerEl).setName(t('SEC_INDEX')).setHeading();

        const isIndexing = this.plugin.isFullIndexingActive();
        const indexingState = this.plugin.getIndexingState();
        const docsCount = this.dbMetrics?.total_indexed_docs ?? 0;
        const relativeTime = this.formatRelativeTime(this.dbMetrics?.last_index_at as string | undefined);

        // 3.1 索引健康度与重建操作
        const indexSetting = new Setting(containerEl)
            .setName(t('INDEX_STATUS_NAME'));

        if (isIndexing) {
            const pct = indexingState.total > 0
                ? Math.min(100, Math.round((indexingState.current / indexingState.total) * 100))
                : 0;
            indexSetting.setDesc(`${t('STATUS_BANNER_INDEXING')} ${pct}% (${indexingState.current}/${indexingState.total})`);
            indexSetting.addButton(btn => btn
                .setButtonText(t('CANCEL_INDEXING_BTN'))
                .setWarning()
                .onClick(() => {
                    this.plugin.cancelFullIndexing();
                    this.display();
                }));
        } else {
            const timeDesc = relativeTime ? ` · 上次更新: ${relativeTime}` : "";
            indexSetting.setDesc(`${t('INDEX_UP_TO_DATE')} (${docsCount} 篇笔记已索引${timeDesc})`);
            indexSetting.addButton(btn => btn
                .setButtonText(t('REBUILD_BTN'))
                .setWarning()
                .onClick(async () => {
                    // eslint-disable-next-line no-alert
                    if (!confirm(t('CONFIRM_CLEAR_1'))) return;
                    // eslint-disable-next-line no-alert
                    if (!confirm(t('CONFIRM_CLEAR_2'))) return;

                    btn.setButtonText(t('REBUILDING'));
                    btn.setDisabled(true);

                    const success = await this.plugin.apiClient.clearIndex();
                    if (success) {
                        new Notice(t('CLEAR_SUCCESS_REBUILDING'));
                        this.plugin.checkConnection({ silent: true });
                        try {
                            (this.app as unknown as { setting?: { close: () => void } }).setting?.close();
                        } catch {
                            // ignore
                        }
                        this.plugin.startFullIndexing({ skipConfirm: true });
                    } else {
                        new Notice(t('CLEAR_FAILED'));
                        btn.setButtonText(t('REBUILD_BTN'));
                        btn.setDisabled(false);
                    }
                }));
        }

        // 3.2 路径排除规则 (紧凑折叠抽屉)
        const rules = (this.plugin.settings.exclusionRules || '')
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean);
        const rulesCountText = t('RULES_COUNT', { count: rules.length });

        new Setting(containerEl)
            .setName(t('EXCLUDED_PATHS_NAME'))
            .setDesc(t('EXCLUDED_PATHS_DESC'))
            .addButton(btn => btn
                .setButtonText(this.isEditingExclusions ? t('BTN_COLLAPSE_RULES') : `${rulesCountText} · ${t('BTN_EDIT_RULES')}`)
                .onClick(() => {
                    this.isEditingExclusions = !this.isEditingExclusions;
                    this.display();
                }));

        if (this.isEditingExclusions) {
            const drawerEl = containerEl.createEl('div', { cls: 'semantix-exclusion-drawer' });
            const textarea = drawerEl.createEl('textarea', {
                cls: 'semantix-exclusion-textarea',
                attr: { placeholder: t('EXCLUSION_PLACEHOLDER') }
            });
            textarea.value = this.plugin.settings.exclusionRules || '';
            textarea.onchange = async () => {
                this.plugin.settings.exclusionRules = textarea.value;
                await this.plugin.saveSettings();
            };
        }
    }

    /**
     * 4. 本地引擎 (Engine)
     */
    private renderEngineSection(containerEl: HTMLElement): void {
        new Setting(containerEl).setName(t('SEC_ENGINE')).setHeading();

        const isLocal = this.plugin.settings.backendMode === 'local';
        const isConnected = this.plugin.getConnectionStatus() === 'connected';

        // 4.1 运行状态
        new Setting(containerEl)
            .setName(t('ENGINE_STATUS_NAME'))
            .setDesc(isLocal
                ? (isConnected ? t('ENGINE_LOCAL_CONNECTED') : t('STATUS_BANNER_DISCONNECTED'))
                : (isConnected ? t('ENGINE_REMOTE_CONNECTED') : t('STATUS_BANNER_DISCONNECTED'))
            );

        // 4.2 随 Obsidian 启动自动拉起后台服务
        if (Platform.isDesktop && isLocal) {
            new Setting(containerEl)
                .setName(t('AUTO_START_ENGINE_NAME'))
                .setDesc(t('AUTO_START_ENGINE_DESC'))
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.autoStartServer)
                    .onChange(async (val) => {
                        this.plugin.settings.autoStartServer = val;
                        await this.plugin.saveSettings();
                    }));

            // 4.3 进程运维控制与自愈重置
            const isRunning = this.plugin.serviceManager.isRunning();
            const manageSetting = new Setting(containerEl)
                .setName(t('ENGINE_MANAGE_NAME'))
                .setDesc(isRunning ? t('ENGINE_MANAGE_DESC_RUNNING') : t('ENGINE_MANAGE_DESC_STOPPED'));

            if (isRunning) {
                manageSetting.addButton(btn => btn
                    .setButtonText(t('BTN_STOP_ENGINE'))
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.serviceManager.setUserIntentStopped(true);
                        this.plugin.serviceManager.stop();
                        new Notice(t('NOTICE_ENGINE_STOPPED'));
                        await this.plugin.checkConnection();
                        this.display();
                    }));
            } else {
                manageSetting.addButton(btn => btn
                    .setButtonText(t('BTN_START_ENGINE'))
                    .setCta()
                    .onClick(async () => {
                        btn.setDisabled(true);
                        new Notice(t('NOTICE_ENGINE_STARTED'));
                        this.plugin.serviceManager.setUserIntentStopped(false);
                        this.plugin.serviceManager.resetHealing();
                        await this.plugin.serviceManager.start({ force: true });
                        this.display();
                    }));
            }

            manageSetting.addButton(btn => btn
                .setButtonText(t('BTN_RESTART_PORT_CLEAN'))
                .onClick(async () => {
                    btn.setDisabled(true);
                    this.plugin.serviceManager.resetHealing();
                    await this.plugin.serviceManager.forceKillAndStart();
                    this.display();
                }));
        }
    }

    /**
     * 5. 高级设置 (Advanced Settings - 原生 details 渐进式折叠)
     */
    private renderAdvancedAccordion(containerEl: HTMLElement): void {
        const detailsEl = containerEl.createEl('details', { cls: 'semantix-settings-advanced' });
        if (this.isAdvancedOpen) {
            detailsEl.setAttribute('open', '');
        }
        detailsEl.addEventListener('toggle', () => {
            this.isAdvancedOpen = detailsEl.open;
        });

        detailsEl.createEl('summary', {
            cls: 'semantix-advanced-summary',
            text: t('SEC_ADVANCED')
        });

        const content = detailsEl.createEl('div', { cls: 'semantix-advanced-content' });

        // --- 5.1 ⏱️ 交互与同步微调 ---
        content.createEl('div', { cls: 'semantix-sub-heading', text: t('ADVANCED_TUNING_HEADER') });

        new Setting(content)
            .setName(t('DEBOUNCE_MS_NAME'))
            .setDesc(t('DEBOUNCE_MS_DESC'))
            .addText(text => text
                .setValue(this.plugin.settings.debounceDelay.toString())
                .onChange(async (val) => {
                    const parsed = parseInt(val, 10);
                    if (!isNaN(parsed) && parsed >= 200 && parsed <= 5000) {
                        this.plugin.settings.debounceDelay = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(content)
            .setName(t('SYNC_INTERVAL_SEC_NAME'))
            .setDesc(t('SYNC_INTERVAL_SEC_DESC'))
            .addText(text => text
                .setValue(this.plugin.settings.syncBatchInterval.toString())
                .onChange(async (val) => {
                    const parsed = parseInt(val, 10);
                    if (!isNaN(parsed) && parsed >= 5 && parsed <= 600) {
                        this.plugin.settings.syncBatchInterval = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        // --- 5.2 🧠 算法与过滤调优 ---
        content.createEl('div', { cls: 'semantix-sub-heading', text: t('ADVANCED_ALGO_HEADER') });

        new Setting(content)
            .setName(t('ADAPTIVE_FILTERING_NAME'))
            .setDesc(t('ADAPTIVE_FILTERING_DESC'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableAdaptiveFiltering)
                .onChange(async (val) => {
                    this.plugin.settings.enableAdaptiveFiltering = val;
                    await this.plugin.saveSettings();
                    if (val && this.plugin.apiClient) {
                        const res = await this.plugin.apiClient.computeStopwords();
                        if (res?.words) {
                            this.plugin.vaultStopwords = res.words;
                        }
                        this.plugin.checkConnection({ silent: true });
                        if (this.plugin.whisperer) {
                            this.plugin.whisperer.triggerNoteScan();
                        }
                    }
                }))
            .addButton(btn => btn
                .setButtonText(t('BTN_CALCULATE_STOPWORDS'))
                .onClick(async () => {
                    btn.setDisabled(true);
                    const res = await this.plugin.apiClient.computeStopwords();
                    if (res) {
                        if (res.words) {
                            this.plugin.vaultStopwords = res.words;
                        }
                        new Notice(t('ADAPTIVE_SUCCESS', { count: res.count }));
                        await this.plugin.checkConnection({ silent: true });
                        if (this.plugin.whisperer) {
                            this.plugin.whisperer.triggerNoteScan();
                        }
                    }
                    btn.setDisabled(false);
                }));

        // --- 5.3 💾 存储维护与生命周期 ---
        content.createEl('div', { cls: 'semantix-sub-heading', text: t('ADVANCED_STORAGE_HEADER') });

        const sizeStr = this.formatBytes(this.dbMetrics?.db_size_bytes);
        const lastOpt = this.formatRelativeTime(this.dbMetrics?.last_maintenance_at as string | undefined);
        const optDesc = lastOpt ? ` · 上次优化: ${lastOpt}` : "";

        new Setting(content)
            .setName(t('STORAGE_SIZE_NAME'))
            .setDesc(`占用存储: ${sizeStr}${optDesc}`)
            .addButton(btn => btn
                .setButtonText(t('BTN_OPTIMIZE_STORAGE'))
                .onClick(async () => {
                    btn.setDisabled(true);
                    btn.setButtonText(t('MAINTENANCE_RUNNING'));
                    const success = await this.plugin.apiClient.runMaintenance(this.plugin.settings.dbRetentionDays);
                    if (success) {
                        new Notice(t('MAINTENANCE_SUCCESS'));
                        this.dbMetrics = await this.plugin.apiClient.getMetrics();
                        this.display();
                    } else {
                        new Notice("❌ 维护失败");
                    }
                    btn.setDisabled(false);
                    btn.setButtonText(t('BTN_OPTIMIZE_STORAGE'));
                }));

        new Setting(content)
            .setName(t('STORAGE_RETENTION_NAME'))
            .setDesc(t('STORAGE_RETENTION_DESC'))
            .addSlider(slider => slider
                .setLimits(0, 30, 1)
                .setValue(this.plugin.settings.dbRetentionDays)
                .setDynamicTooltip()
                .onChange(async (val) => {
                    this.plugin.settings.dbRetentionDays = val;
                    await this.plugin.saveSettings();
                }));

        // --- 5.4 📱 移动端与远程访问 ---
        content.createEl('div', { cls: 'semantix-sub-heading', text: t('ADVANCED_REMOTE_HEADER') });

        new Setting(content)
            .setName(t('ENABLE_MOBILE_NAME'))
            .setDesc(t('ENABLE_MOBILE_DESC'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableOnMobile)
                .onChange(async (val) => {
                    this.plugin.settings.enableOnMobile = val;
                    await this.plugin.saveSettings();
                    new Notice(t('MOBILE_RESTART_NOTICE'));
                }));

        new Setting(content)
            .setName(t('BACKEND_MODE_NAME'))
            .setDesc(t('BACKEND_MODE_DESC'))
            .addDropdown(drop => drop
                .addOption('local', t('BACKEND_MODE_LOCAL'))
                .addOption('remote', t('BACKEND_MODE_REMOTE'))
                .setValue(this.plugin.settings.backendMode)
                .onChange(async (val) => {
                    this.plugin.settings.backendMode = val as 'local' | 'remote';
                    if (val === 'local') {
                        this.plugin.settings.backendUrl = 'http://localhost:8000';
                    }
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(content)
            .setName(t('BACKEND_URL_NAME'))
            .setDesc(t('BACKEND_URL_DESC'))
            .addText(text => text
                // eslint-disable-next-line obsidianmd/ui/sentence-case
                .setPlaceholder('http://localhost:8000')
                .setValue(this.plugin.settings.backendUrl)
                .onChange(async (val) => {
                    this.plugin.settings.backendUrl = val;
                    await this.plugin.saveSettings();
                }));

        new Setting(content)
            .setName(t('API_TOKEN_NAME'))
            .setDesc(t('API_TOKEN_DESC'))
            .addText(text => {
                text.setPlaceholder('Optional');
                text.setValue(this.plugin.settings.apiToken);
                text.inputEl.type = 'password';
                text.onChange(async (val) => {
                    this.plugin.settings.apiToken = val;
                    await this.plugin.saveSettings();
                });
            });

        if (Platform.isDesktop && this.plugin.settings.backendMode === 'local') {
            new Setting(content)
                .setName(t('BACKEND_PATH_NAME'))
                .setDesc(t('BACKEND_PATH_DESC'))
                .addText(text => text
                    // eslint-disable-next-line obsidianmd/ui/sentence-case
                    .setPlaceholder('D:\\Semantix\\backend')
                    .setValue(this.plugin.settings.backendPath)
                    .onChange(async (val) => {
                        this.plugin.settings.backendPath = val;
                        await this.plugin.saveSettings();
                        if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
                        this.debounceTimer = window.setTimeout(() => this.validateBackend(val), 800);
                    }));

            if (this.pythonStatus || this.backendStatus) {
                const isError = this.pythonStatus.includes('❌') || this.pythonStatus.includes('⚠️');
                const isSuccess = this.pythonStatus.includes('✅');
                let color = 'var(--text-muted)';
                if (isError) color = 'var(--text-accent)';
                if (isSuccess) color = 'var(--color-green)';

                const statusEl = content.createEl('div', { cls: 'setting-item-description' });
                statusEl.setCssStyles({
                    color,
                    marginTop: '-8px',
                    marginBottom: '12px',
                    fontSize: '0.85em',
                    fontWeight: isSuccess ? 'bold' : 'normal'
                });
                statusEl.setText(this.pythonStatus || this.backendStatus);
            }
        }

        // --- 5.5 🔍 诊断信息 ---
        content.createEl('div', { cls: 'semantix-sub-heading', text: t('ADVANCED_DIAGNOSTICS_HEADER') });

        new Setting(content)
            .setName(t('VAULT_ID_NAME'))
            .setDesc(this.plugin.vaultId || 'N/A')
            .addButton(btn => btn
                .setButtonText(t('BTN_COPY'))
                .onClick(async () => {
                    if (this.plugin.vaultId) {
                        await navigator.clipboard.writeText(this.plugin.vaultId);
                        new Notice(t('COPIED_TO_CLIPBOARD'));
                    }
                }));

        const health = this.plugin.apiClient.lastHealthResponse;
        if (health) {
            new Setting(content)
                .setName(t('ENGINE_DIAGNOSTICS_NAME'))
                .setDesc(`Engine: v${health.engine_version || '0.8.0'} · API: v${health.api_version || '1'} · Model: ${health.embedding_model || 'bge-small-zh-v1.5'}`);
        }

        // --- 5.6 ⚠️ 危险操作 ---
        content.createEl('div', { cls: 'semantix-sub-heading', text: t('ADVANCED_DANGER_HEADER') });

        new Setting(content)
            .setName(t('CLEAR_DATABASE_ONLY_NAME'))
            .setDesc(t('CLEAR_DATABASE_ONLY_DESC'))
            .addButton(btn => btn
                .setButtonText(t('BTN_CLEAR_ONLY'))
                .setWarning()
                .onClick(async () => {
                    // eslint-disable-next-line no-alert
                    if (!confirm(t('CONFIRM_CLEAR_ONLY_1'))) return;
                    // eslint-disable-next-line no-alert
                    if (!confirm(t('CONFIRM_CLEAR_ONLY_2'))) return;

                    btn.setDisabled(true);
                    btn.setButtonText(t('REBUILDING'));

                    const success = await this.plugin.apiClient.clearIndex();
                    if (success) {
                        new Notice(t('CLEAR_SUCCESS'));
                        this.plugin.checkConnection({ silent: true });
                        this.dbMetrics = await this.plugin.apiClient.getMetrics();
                        this.display();
                    } else {
                        new Notice(t('CLEAR_FAILED'));
                        btn.setDisabled(false);
                        btn.setButtonText(t('BTN_CLEAR_ONLY'));
                    }
                }));
    }
}
