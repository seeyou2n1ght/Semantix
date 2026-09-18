import { App, PluginSettingTab, Setting, Notice, Platform, ButtonComponent } from "obsidian";
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
    customStopwords: string;
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
    enableAdaptiveFiltering: false,
    customStopwords: ''
};

export class SemantixSettingTab extends PluginSettingTab {
    plugin: SemantixPlugin;
    private pythonStatus: string = "";
    private backendStatus: string = "";
    private showPythonInput: boolean = false;
    private debounceTimer: number | null = null;
    private isEditingExclusions: boolean = false;
    private isStopwordsOpen: boolean = false;

    private statusBannerSlotEl: HTMLElement | null = null;
    private vaultIndexSlotEl: HTMLElement | null = null;
    private engineManageSlotEl: HTMLElement | null = null;
    private backendStatusTextEl: HTMLElement | null = null;
    private debounceSettingEl: HTMLElement | null = null;

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
        this.updateBackendStatusEl();
    }

    private updateBackendStatusEl(): void {
        if (!this.backendStatusTextEl) return;
        const msg = this.pythonStatus || this.backendStatus;
        if (!msg) {
            this.backendStatusTextEl.setText('');
            this.backendStatusTextEl.setCssStyles({ display: 'none' });
            return;
        }
        const isError = msg.includes('❌') || msg.includes('⚠️');
        const isSuccess = msg.includes('✅');
        let color = 'var(--text-muted)';
        if (isError) color = 'var(--text-accent)';
        if (isSuccess) color = 'var(--color-green)';

        this.backendStatusTextEl.setCssStyles({
            display: 'block',
            color,
            marginTop: '-8px',
            marginBottom: '12px',
            fontSize: '0.85em',
            fontWeight: isSuccess ? 'bold' : 'normal'
        });
        this.backendStatusTextEl.setText(msg);
    }

    public refreshStatusDisplay(): void {
        if (this.statusBannerSlotEl) {
            this.statusBannerSlotEl.empty();
            this.renderStatusHeader(this.statusBannerSlotEl);
        }
        if (this.vaultIndexSlotEl) {
            this.vaultIndexSlotEl.empty();
            this.renderVaultIndexStatus(this.vaultIndexSlotEl);
        }
        if (this.engineManageSlotEl) {
            this.engineManageSlotEl.empty();
            this.renderEngineBranch(this.engineManageSlotEl);
        }
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
        this.updateBackendStatusEl();

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
            void this.plugin.saveSettings();
            this.updateStatus('python', t('UV_DETECTED'));
            return;
        }

        if (fsMod.existsSync(venvPython)) {
            this.plugin.settings.pythonPath = venvPython;
            void this.plugin.saveSettings();
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

    private armConfirm(btn: ButtonComponent, actionLabel: string, onConfirm: () => Promise<void> | void): void {
        const btnEl = btn.buttonEl;
        if (btnEl.dataset.armed === 'true') {
            btnEl.dataset.armed = 'false';
            btn.setButtonText(actionLabel);
            btn.buttonEl.removeClass('mod-cta');
            btn.buttonEl.addClass('mod-warning');
            void onConfirm();
            return;
        }

        btnEl.dataset.armed = 'true';
        btn.buttonEl.removeClass('mod-warning');
        btn.buttonEl.addClass('mod-cta');

        let countdown = 3;
        btn.setButtonText(t('ARM_CONFIRM_BTN', { action: actionLabel, seconds: countdown }));

        const timer = window.setInterval(() => {
            countdown--;
            if (countdown <= 0) {
                window.clearInterval(timer);
                if (btnEl.dataset.armed === 'true') {
                    btnEl.dataset.armed = 'false';
                    btn.setButtonText(actionLabel);
                    btn.buttonEl.removeClass('mod-cta');
                    btn.buttonEl.addClass('mod-warning');
                }
            } else if (btnEl.dataset.armed === 'true') {
                btn.setButtonText(t('ARM_CONFIRM_BTN', { action: actionLabel, seconds: countdown }));
            }
        }, 1000);
    }

    display(): void {
        const { containerEl } = this;
        const savedScrollTop = containerEl.scrollTop;
        containerEl.empty();
        this.statusBannerSlotEl = null;
        this.vaultIndexSlotEl = null;
        this.engineManageSlotEl = null;
        this.backendStatusTextEl = null;
        this.debounceSettingEl = null;

        // 1. 顶部状态看板 Dashboard
        this.statusBannerSlotEl = containerEl.createDiv({ cls: 'semantix-status-slot' });
        this.renderStatusHeader(this.statusBannerSlotEl);

        // 2. 模块 1: 推荐体验与交互策略
        this.renderRecommendationCard(containerEl);

        // 3. 模块 2: 知识库索引与内容范围
        this.renderVaultIndexCard(containerEl);

        // 4. 模块 3: 服务引擎与连接模式
        this.renderEngineCard(containerEl);

        // 5. 模块 4: 存储维护与系统诊断
        this.renderMaintenanceCard(containerEl);

        containerEl.scrollTop = savedScrollTop;
    }

    /**
     * 1. 顶部紧凑状态概览 (System Status Banner)
     */
    private renderStatusHeader(containerEl: HTMLElement): void {
        const bannerEl = containerEl.createDiv({ cls: 'semantix-status-banner' });
        const infoEl = bannerEl.createDiv({ cls: 'semantix-status-info' });

        const status = this.plugin.getConnectionStatus();
        const indexingState = this.plugin.getIndexingState();
        const health = this.plugin.apiClient.lastHealthResponse;
        const isLocal = this.plugin.settings.backendMode === 'local';

        const titleRow = infoEl.createDiv({ cls: 'semantix-status-title-row' });
        const dotEl = titleRow.createSpan({ cls: 'semantix-status-dot' });
        const titleTextEl = titleRow.createSpan({ cls: 'semantix-status-badge' });

        titleRow.createSpan({
            cls: 'semantix-mode-pill',
            text: isLocal ? t('MODE_LOCAL_BADGE') : t('MODE_REMOTE_BADGE')
        });

        const descEl = infoEl.createDiv({ cls: 'semantix-status-desc' });

        if (indexingState && indexingState.active) {
            dotEl.addClass('dot-indexing');
            const pct = indexingState.total > 0
                ? Math.min(100, Math.round((indexingState.current / indexingState.total) * 100))
                : 0;
            titleTextEl.setText(`${t('STATUS_BANNER_INDEXING')} ${pct}% (${indexingState.current}/${indexingState.total})`);
            descEl.setText(t('STATUS_BANNER_INDEXING'));
        } else if (status === 'connected') {
            dotEl.addClass('dot-ready');
            titleTextEl.setText(`Semantix · ${t('STATUS_BANNER_READY')}`);
            const notesCount = this.dbMetrics?.total_indexed_docs ?? 0;
            const sizeStr = this.formatBytes(this.dbMetrics?.db_size_bytes);
            const modelName = health?.embedding_model ? health.embedding_model.split('/').pop() : 'bge-small-zh-v1.5';
            descEl.setText(`Engine v${health?.engine_version || '0.9.1'} · ${modelName} · ${notesCount} 篇笔记已索引 · 占用 ${sizeStr}`);
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
            this.refreshStatusDisplay();
        };
    }

    /**
     * 2. 模块 1: 推荐体验与交互策略 (Recommendation)
     */
    private renderRecommendationCard(containerEl: HTMLElement): void {
        const card = containerEl.createDiv({ cls: 'semantix-settings-card' });
        const header = card.createDiv({ cls: 'semantix-settings-card-header' });
        header.createDiv({ cls: 'semantix-settings-card-title', text: t('SEC_RECOMMENDATION_GROUP') });

        // 2.1 推荐质量策略
        new Setting(card)
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

        // 2.2 呈现数量上限
        new Setting(card)
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

        // 2.3 发现流跨界探索度
        new Setting(card)
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

        // 2.4 写作实时自动联想
        new Setting(card)
            .setName(t('UPDATE_WHILE_WRITING_NAME'))
            .setDesc(t('UPDATE_WHILE_WRITING_DESC'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoTrigger ?? true)
                .onChange(async (val) => {
                    this.plugin.settings.autoTrigger = val;
                    await this.plugin.saveSettings();
                    if (this.debounceSettingEl) {
                        if (val) {
                            this.debounceSettingEl.removeClass('is-disabled');
                        } else {
                            this.debounceSettingEl.addClass('is-disabled');
                        }
                    }
                }));

        // 2.5 从属项：输入响应防抖延迟
        const debounceSetting = new Setting(card)
            .setName(t('DEBOUNCE_DEPENDENT_NAME'))
            .setDesc(t('DEBOUNCE_DEPENDENT_DESC'))
            .addSlider(slider => slider
                .setLimits(200, 2000, 50)
                .setValue(this.plugin.settings.debounceDelay || 400)
                .setDynamicTooltip()
                .onChange(async (val) => {
                    this.plugin.settings.debounceDelay = val;
                    await this.plugin.saveSettings();
                }));

        this.debounceSettingEl = debounceSetting.settingEl;
        this.debounceSettingEl.addClass('semantix-setting-dependent');
        if (!this.plugin.settings.autoTrigger) {
            this.debounceSettingEl.addClass('is-disabled');
        }
    }

    /**
     * 3. 模块 2: 知识库索引与内容范围 (Vault Index)
     */
    private renderVaultIndexCard(containerEl: HTMLElement): void {
        const card = containerEl.createDiv({ cls: 'semantix-settings-card' });
        const header = card.createDiv({ cls: 'semantix-settings-card-header' });
        header.createDiv({ cls: 'semantix-settings-card-title', text: t('SEC_INDEX_GROUP') });

        // 3.1 索引健康度与全量重建 (Slot 局部刷新)
        this.vaultIndexSlotEl = card.createDiv({ cls: 'semantix-vault-index-slot' });
        this.renderVaultIndexStatus(this.vaultIndexSlotEl);

        // 3.2 笔记保存增量同步缓冲
        new Setting(card)
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

        // 3.3 路径黑名单规则
        this.renderExclusionRules(card);

        // 3.4 高频停用词过滤 (整合抽屉)
        this.renderStopwordsFilter(card);
    }

    private renderVaultIndexStatus(slotEl: HTMLElement): void {
        const isIndexing = this.plugin.isFullIndexingActive();
        const indexingState = this.plugin.getIndexingState();
        const docsCount = this.dbMetrics?.total_indexed_docs ?? 0;
        const relativeTime = this.formatRelativeTime(this.dbMetrics?.last_index_at);
        const isConnected = this.plugin.getConnectionStatus() === 'connected';

        const indexSetting = new Setting(slotEl).setName(t('INDEX_STATUS_NAME'));

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
                    this.refreshStatusDisplay();
                }));
        } else if (!isConnected) {
            indexSetting.setDesc(t('STATUS_BANNER_DISCONNECTED'));
            indexSetting.addButton(btn => btn
                .setButtonText(t('ARM_ACTION_REBUILD'))
                .setDisabled(true));
        } else {
            const timeDesc = relativeTime ? ` · 上次更新: ${relativeTime}` : "";
            indexSetting.setDesc(docsCount === 0 
                ? t('INDEX_NOT_BUILT')
                : `${t('INDEX_UP_TO_DATE')} (${docsCount} 篇笔记已索引${timeDesc})`
            );
            indexSetting.addButton(btn => {
                btn.setButtonText(`🔄 ${t('ARM_ACTION_REBUILD')}`).setWarning();
                btn.onClick(() => {
                    this.armConfirm(btn, `🔄 ${t('ARM_ACTION_REBUILD')}`, () => {
                        btn.setButtonText(t('REBUILDING'));
                        btn.setDisabled(true);
                        new Notice(t('CLEAR_SUCCESS_REBUILDING'));
                        void this.plugin.checkConnection({ silent: true });
                        try {
                            (this.app as unknown as { setting?: { close: () => void } }).setting?.close();
                        } catch {
                            // ignore
                        }
                        void this.plugin.startFullIndexing({ skipConfirm: true });
                    });
                });
            });
        }
    }

    private renderExclusionRules(containerEl: HTMLElement): void {
        const rules = (this.plugin.settings.exclusionRules || '')
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean);
        const rulesCountText = t('RULES_COUNT', { count: rules.length });

        const exclusionSlotEl = containerEl.createDiv({ cls: 'semantix-exclusion-slot' });

        const renderDrawer = () => {
            exclusionSlotEl.empty();
            new Setting(exclusionSlotEl)
                .setName(t('EXCLUDED_PATHS_NAME'))
                .setDesc(t('EXCLUDED_PATHS_DESC'))
                .addButton(btn => btn
                    .setButtonText(this.isEditingExclusions ? t('BTN_COLLAPSE_RULES') : `${rulesCountText} · ${t('BTN_EDIT_RULES')}`)
                    .onClick(() => {
                        this.isEditingExclusions = !this.isEditingExclusions;
                        renderDrawer();
                    }));

            if (this.isEditingExclusions) {
                const drawerEl = exclusionSlotEl.createDiv({ cls: 'semantix-exclusion-drawer' });
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
        };

        renderDrawer();
    }

    private renderStopwordsFilter(containerEl: HTMLElement): void {
        const slotEl = containerEl.createDiv({ cls: 'semantix-stopwords-slot' });

        const renderDrawer = () => {
            slotEl.empty();
            const count = this.plugin.vaultStopwords?.length || 0;
            new Setting(slotEl)
                .setName(t('STOPWORDS_PANEL_TITLE'))
                .setDesc(t('STOPWORDS_PANEL_DESC'))
                .addButton(btn => btn
                    .setButtonText(this.isStopwordsOpen 
                        ? t('STOPWORDS_BUTTON_COLLAPSE') 
                        : t('STOPWORDS_BUTTON_EXPAND', { count }))
                    .onClick(() => {
                        this.isStopwordsOpen = !this.isStopwordsOpen;
                        renderDrawer();
                    }));

            if (this.isStopwordsOpen) {
                const drawerEl = slotEl.createDiv({ cls: 'semantix-exclusion-drawer' });

                new Setting(drawerEl)
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
                                    renderStopwordsChips();
                                }
                                void this.plugin.checkConnection({ silent: true });
                                if (this.plugin.radar) {
                                    void this.plugin.radar.triggerNoteScan();
                                }
                            }
                        }))
                    .addButton(btn => btn
                        .setButtonText(t('BTN_CALCULATE_STOPWORDS'))
                        .onClick(async () => {
                            btn.setDisabled(true);
                            btn.setButtonText(t('STOPWORDS_CALCULATING'));
                            try {
                                const res = await this.plugin.apiClient.computeStopwords();
                                if (res) {
                                    if (res.words) {
                                        this.plugin.vaultStopwords = res.words;
                                    }
                                    const wordsPreview = res.words && res.words.length > 0 ? ` (${res.words.join(', ')})` : "";
                                    new Notice(t('ADAPTIVE_SUCCESS', { count: res.count }) + wordsPreview);
                                    renderStopwordsChips();
                                    await this.plugin.checkConnection({ silent: true });
                                    if (this.plugin.radar) {
                                        void this.plugin.radar.triggerNoteScan();
                                    }
                                } else {
                                    new Notice(t('STOPWORDS_FAILED'));
                                }
                            } finally {
                                btn.setButtonText(t('BTN_CALCULATE_STOPWORDS'));
                                btn.setDisabled(false);
                            }
                        }));

                const chipsContainer = drawerEl.createDiv({ cls: 'semantix-stopwords-container' });
                const renderStopwordsChips = () => {
                    chipsContainer.empty();
                    const header = chipsContainer.createDiv({ cls: 'semantix-stopwords-header' });
                    header.createSpan({ 
                        cls: 'semantix-stopwords-title', 
                        text: `${t('ADAPTIVE_STOPWORDS_TITLE')} (${this.plugin.vaultStopwords?.length || 0}):` 
                    });
                    const listEl = chipsContainer.createDiv({ cls: 'semantix-stopwords-chips' });
                    if (this.plugin.vaultStopwords && this.plugin.vaultStopwords.length > 0) {
                        for (const word of this.plugin.vaultStopwords) {
                            listEl.createSpan({ cls: 'semantix-stopword-chip', text: word });
                        }
                    } else {
                        listEl.createSpan({ 
                            cls: 'semantix-stopwords-empty', 
                            text: t('ADAPTIVE_STOPWORDS_EMPTY') 
                        });
                    }
                };
                renderStopwordsChips();

                new Setting(drawerEl)
                    .setName(t('CUSTOM_STOPWORDS_NAME'))
                    .setDesc(t('CUSTOM_STOPWORDS_DESC'))
                    .addTextArea(text => text
                        .setPlaceholder(t('CUSTOM_STOPWORDS_PLACEHOLDER'))
                        .setValue(this.plugin.settings.customStopwords || "")
                        .onChange(async (val) => {
                            this.plugin.settings.customStopwords = val;
                            await this.plugin.saveSettings();
                        }));
            }
        };

        renderDrawer();
    }

    /**
     * 4. 模块 3: 服务引擎与连接模式 (Engine)
     */
    private renderEngineCard(containerEl: HTMLElement): void {
        const card = containerEl.createDiv({ cls: 'semantix-settings-card' });
        const header = card.createDiv({ cls: 'semantix-settings-card-header' });
        header.createDiv({ cls: 'semantix-settings-card-title', text: t('SEC_ENGINE_GROUP') });

        const branchSlotEl = card.createDiv({ cls: 'semantix-engine-branch-slot' });
        this.engineManageSlotEl = branchSlotEl;

        new Setting(card)
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
                    this.refreshStatusDisplay();
                    this.renderEngineBranch(branchSlotEl);
                }));

        this.renderEngineBranch(branchSlotEl);
    }

    private renderEngineBranch(slotEl: HTMLElement): void {
        slotEl.empty();
        const isLocal = this.plugin.settings.backendMode === 'local';
        const isConnected = this.plugin.getConnectionStatus() === 'connected';

        new Setting(slotEl)
            .setName(t('ENGINE_STATUS_NAME'))
            .setDesc(isLocal
                ? (isConnected ? t('ENGINE_LOCAL_CONNECTED') : t('STATUS_BANNER_DISCONNECTED'))
                : (isConnected ? t('ENGINE_REMOTE_CONNECTED') : t('STATUS_BANNER_DISCONNECTED'))
            );

        if (isLocal) {
            if (Platform.isDesktop) {
                new Setting(slotEl)
                    .setName(t('AUTO_START_ENGINE_NAME'))
                    .setDesc(t('AUTO_START_ENGINE_DESC'))
                    .addToggle(toggle => toggle
                        .setValue(this.plugin.settings.autoStartServer)
                        .onChange(async (val) => {
                            this.plugin.settings.autoStartServer = val;
                            await this.plugin.saveSettings();
                        }));

                const isRunning = this.plugin.serviceManager.isRunning();
                const manageSetting = new Setting(slotEl)
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
                            this.refreshStatusDisplay();
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
                            this.refreshStatusDisplay();
                        }));
                }

                manageSetting.addButton(btn => btn
                    .setButtonText(t('BTN_RESTART_PORT_CLEAN'))
                    .onClick(async () => {
                        btn.setDisabled(true);
                        this.plugin.serviceManager.resetHealing();
                        await this.plugin.serviceManager.forceKillAndStart();
                        this.refreshStatusDisplay();
                    }));

                new Setting(slotEl)
                    .setName(t('BACKEND_PATH_NAME'))
                    .setDesc(t('BACKEND_PATH_DESC'))
                    .addText(text => text
                        .setPlaceholder('Enter local engine path')
                        .setValue(this.plugin.settings.backendPath)
                        .onChange(async (val) => {
                            this.plugin.settings.backendPath = val;
                            await this.plugin.saveSettings();
                            if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
                            this.debounceTimer = window.setTimeout(() => this.validateBackend(val), 800);
                        }));

                this.backendStatusTextEl = slotEl.createDiv({ cls: 'semantix-path-indicator' });
                this.updateBackendStatusEl();
            }
        } else {
            new Setting(slotEl)
                .setName(t('BACKEND_URL_NAME'))
                .setDesc(t('BACKEND_URL_DESC'))
                .addText(text => text
                    .setPlaceholder('Enter engine URL')
                    .setValue(this.plugin.settings.backendUrl)
                    .onChange(async (val) => {
                        this.plugin.settings.backendUrl = val;
                        await this.plugin.saveSettings();
                    }));

            new Setting(slotEl)
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

            new Setting(slotEl)
                .setName(t('ENABLE_MOBILE_NAME'))
                .setDesc(t('ENABLE_MOBILE_DESC'))
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.enableOnMobile)
                    .onChange(async (val) => {
                        this.plugin.settings.enableOnMobile = val;
                        await this.plugin.saveSettings();
                        new Notice(t('MOBILE_RESTART_NOTICE'));
                    }));
        }
    }

    /**
     * 5. 模块 4: 存储维护与系统诊断 (Maintenance & Diagnostics)
     */
    private renderMaintenanceCard(containerEl: HTMLElement): void {
        const card = containerEl.createDiv({ cls: 'semantix-settings-card' });
        const header = card.createDiv({ cls: 'semantix-settings-card-header' });
        header.createDiv({ cls: 'semantix-settings-card-title', text: t('SEC_MAINTENANCE_GROUP') });

        const sizeStr = this.formatBytes(this.dbMetrics?.db_size_bytes);
        const lastOpt = this.formatRelativeTime(this.dbMetrics?.last_maintenance_at);
        const optDesc = lastOpt ? ` · 上次优化: ${lastOpt}` : "";

        new Setting(card)
            .setName(t('STORAGE_SIZE_NAME'))
            .setDesc(`占用存储: ${sizeStr}${optDesc}`)
            .addButton(btn => btn
                .setButtonText(t('BTN_OPTIMIZE_STORAGE'))
                .setCta()
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

        new Setting(card)
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

        new Setting(card)
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
            new Setting(card)
                .setName(t('ENGINE_DIAGNOSTICS_NAME'))
                .setDesc(`Engine: v${health.engine_version || '0.9.1'} · API: v${health.api_version || '1'} · Model: ${health.embedding_model || 'bge-small-zh-v1.5'}`);
        }

        // 危险操作区
        const dangerZone = card.createDiv({ cls: 'semantix-danger-zone' });
        const clearSetting = new Setting(dangerZone)
            .setName(t('DANGER_ZONE_CLEAR_TITLE'))
            .setDesc(t('DANGER_ZONE_CLEAR_DESC'));
        clearSetting.nameEl.addClass('semantix-danger-title');
        clearSetting.addButton(btn => {
            btn.setButtonText(t('ARM_ACTION_CLEAR')).setWarning();
            btn.onClick(() => {
                this.armConfirm(btn, t('ARM_ACTION_CLEAR'), async () => {
                    btn.setDisabled(true);
                    btn.setButtonText(t('REBUILDING'));
                    const success = await this.plugin.apiClient.clearIndex(this.plugin.vaultId);
                    if (success) {
                        new Notice(t('CLEAR_SUCCESS'));
                        await this.plugin.checkConnection({ silent: true });
                        this.dbMetrics = await this.plugin.apiClient.getMetrics();
                        this.refreshStatusDisplay();
                    } else {
                        new Notice(t('CLEAR_FAILED'));
                        btn.setDisabled(false);
                        btn.setButtonText(t('ARM_ACTION_CLEAR'));
                    }
                });
            });
        });
    }
}
