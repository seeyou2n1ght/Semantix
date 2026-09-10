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
    
    // DB Metrics
    private dbMetrics: { db_size_bytes?: number; last_maintenance_at?: string; [key: string]: unknown } | null = null;

    constructor(app: App, plugin: SemantixPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    private updateStatus(type: 'python' | 'backend', status: string) {
        if (type === 'python') this.pythonStatus = status;
        else this.backendStatus = status;
        this.display(); // 触发全量刷新以显示状态
    }

    public refreshStatusDisplay() {
        // 触发设置面板重绘以反映最新连接状态
        this.display();
    }

    private async validatePython(pythonPath: string) {
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

    private validateBackend(backendPath: string) {
        if (!Platform.isDesktop || !backendPath) {
            this.updateStatus('backend', "");
            return;
        }

        const fsMod = getFs();
        const pathMod = getPath();
        if (!fsMod || !pathMod) return;

        try {
            if (!fsMod.existsSync(backendPath)) {
                this.updateStatus('backend', "❌ 路径不存在");
                return;
            }
            
            const stats = fsMod.statSync(backendPath);
            if (!stats.isDirectory()) {
                this.updateStatus('backend', "❌ 提供的路径不是一个目录");
                return;
            }

            const mainPy = pathMod.join(backendPath, 'main.py');
            if (!fsMod.existsSync(mainPy)) {
                this.updateStatus('backend', "❌ 未找到 main.py (确认是否是后端根目录)");
                return;
            }

            this.updateStatus('backend', "✅ 合法的后端项目路径");
            
            // 联动：自动探测虚拟环境
            this.autoDetectPythonEnvironment(backendPath);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            this.updateStatus('backend', `❌ 校验出错: ${errorMsg}`);
        }
    }

    private autoDetectPythonEnvironment(backendPath: string) {
        if (!Platform.isDesktop) return;
        const fsMod = getFs();
        const pathMod = getPath();
        if (!fsMod || !pathMod) return;

        const isWindows = Platform.isWin;
        const venvPython = isWindows 
            ? pathMod.join(backendPath, '.venv', 'Scripts', 'python.exe')
            : pathMod.join(backendPath, '.venv', 'bin', 'python');

        // 特殊逻辑：如果是 uv 项目（包含 uv.lock），我们强制使用 'uv' 命令，因为 uv run 比直连 .venv 更稳健
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

    async onOpen() {
        // 当设置页面打开时，尝试获取一次指标数据
        if (this.plugin.apiClient) {
            this.dbMetrics = await this.plugin.apiClient.getMetrics();
        }
    }

    display(): void {
        const { containerEl } = this;
        const savedScrollTop = containerEl.scrollTop; // 关键：记录当前滚动位置
        containerEl.empty();

        // 状态页眉
        const status = this.plugin.getConnectionStatus();
        let statusText = t('STATUS_UNKNOWN');
        let statusColor = "var(--text-muted)";
        
        switch (status) {
            case 'connected': statusText = t('STATUS_CONNECTED'); statusColor = "var(--color-green)"; break;
            case 'disconnected': statusText = t('STATUS_DISCONNECTED'); statusColor = "var(--text-accent)"; break;
            case 'syncing': statusText = t('STATUS_SYNCING'); statusColor = "var(--color-blue)"; break;
            case 'disabled': statusText = t('STATUS_DISABLED'); statusColor = "var(--text-muted)"; break;
        }

        // Header Setting using official setHeading API
        const headerSetting = new Setting(containerEl)
            .setName(t('SETTINGS_TITLE'))
            .setDesc("Semantix Local Knowledge Engine")
            .setHeading();

        const badge = headerSetting.controlEl.createEl('div', { 
            attr: { style: `display: flex; align-items: center; gap: 8px; padding: 4px 12px; border-radius: 12px; border: 1px solid ${statusColor}; font-size: 0.85em;` } 
        });
        badge.createEl('span', { attr: { style: `width: 8px; height: 8px; border-radius: 50%; background-color: ${statusColor};` } });
        badge.createEl('span', { text: statusText, attr: { style: `color: ${statusColor}; font-weight: bold;` } });

        // 如果是移动端，展示专用模式横幅
        if (Platform.isMobile) {
            const mobileBanner = containerEl.createEl('div', {
                attr: {
                    style: 'margin-bottom: 20px; padding: 12px; border-radius: 8px; border-left: 4px solid var(--text-accent); background-color: var(--background-secondary-alt); font-size: 0.9em; line-height: 1.5;'
                }
            });
            mobileBanner.createSpan({ text: t('MOBILE_REMOTE_BANNER') });
        }

        const isMobile = Platform.isMobile;
        const isRemote = isMobile || this.plugin.settings.backendMode === 'remote';

        // =========================================================================
        // Section 1: 引擎连接与服务管理 (Engine Connection)
        // =========================================================================
        new Setting(containerEl).setName(t('SETTINGS_SECTION_CONNECTION')).setHeading();

        if (!isMobile) {
            new Setting(containerEl)
                .setName(t('BACKEND_MODE_NAME'))
                .setDesc(t('BACKEND_MODE_DESC'))
                .addDropdown(dropdown => dropdown
                    .addOption('local', t('BACKEND_MODE_LOCAL'))
                    .addOption('remote', t('BACKEND_MODE_REMOTE'))
                    .setValue(this.plugin.settings.backendMode)
                    .onChange(async (value) => {
                        this.plugin.settings.backendMode = value as 'local' | 'remote';
                        if (value === 'local') {
                            this.plugin.settings.backendUrl = 'http://localhost:8000';
                        }
                        await this.plugin.saveSettings();
                        this.display(); // 立即刷新 UI
                    }));
        }

        if (isRemote) {
            new Setting(containerEl)
                .setName(t('BACKEND_URL_NAME'))
                .setDesc(t('BACKEND_URL_DESC'))
                .addText(text => text
                    .setPlaceholder('http://your-server:8000')
                    .setValue(this.plugin.settings.backendUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.backendUrl = value;
                        await this.plugin.saveSettings();
                    }))
                .addButton(btn => btn
                    .setButtonText(t('TEST_CONNECTION'))
                    .onClick(async () => {
                        btn.setButtonText(t('TESTING'));
                        await this.plugin.checkConnection({ manual: true });
                        btn.setButtonText(t('TEST_CONNECTION'));
                    }));

            new Setting(containerEl)
                .setName(t('API_TOKEN_NAME'))
                .setDesc(t('API_TOKEN_DESC'))
                .addText(text => {
                    text.setPlaceholder('optional');
                    text.setValue(this.plugin.settings.apiToken);
                    text.inputEl.type = 'password';
                    text.onChange(async (value) => {
                        this.plugin.settings.apiToken = value;
                        await this.plugin.saveSettings();
                    });
                });
        } else {
            // 本地边车模式
            // 1. 本地引擎目录
            new Setting(containerEl)
                .setName(t('BACKEND_PATH_NAME'))
                .setDesc(t('BACKEND_PATH_DESC'))
                .addText(text => text
                    .setPlaceholder('C:\\Projects\\Semantix\\backend')
                    .setValue(this.plugin.settings.backendPath)
                    .onChange(async (value) => {
                        this.plugin.settings.backendPath = value;
                        await this.plugin.saveSettings();

                        if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
                        this.debounceTimer = window.setTimeout(() => this.validateBackend(value), 800);
                    }));

            // 2. 状态反馈
            if (this.pythonStatus || this.backendStatus) {
                const isError = this.pythonStatus.includes('❌') || this.pythonStatus.includes('⚠️');
                const isSuccess = this.pythonStatus.includes('✅');
                let color = 'var(--text-muted)';
                if (isError) color = 'var(--text-accent)';
                if (isSuccess) color = 'var(--color-green)';

                const statusDiv = containerEl.createEl('div', { 
                    cls: 'setting-item-description', 
                    attr: { style: `color: ${color}; margin-top: -15px; margin-bottom: 20px; font-size: 0.85em; font-weight: ${isSuccess ? 'bold' : 'normal'}; display: flex; align-items: center; justify-content: space-between;` } 
                });
                
                statusDiv.createEl('span', { text: this.pythonStatus || this.backendStatus });

                const rightContainer = statusDiv.createEl('div', { attr: { style: 'display: flex; align-items: center; gap: 10px;' } });

                if (isSuccess && !this.showPythonInput) {
                    const changeBtn = rightContainer.createEl('a', { 
                        text: t('BACKEND_MODE_NAME'),
                        attr: { style: 'color: var(--text-accent); cursor: pointer; text-decoration: underline;' } 
                    });
                    changeBtn.onclick = () => {
                        this.showPythonInput = true;
                        this.display();
                    };
                }
            }

            // 展示当前连接的 Engine 协议与版本详情
            if (this.plugin.apiClient.lastHealthResponse) {
                const health = this.plugin.apiClient.lastHealthResponse;
                const infoDiv = containerEl.createEl('div', { 
                    cls: 'setting-item-description', 
                    attr: { style: 'color: var(--color-green); margin-top: -10px; margin-bottom: 20px; font-size: 0.85em;' } 
                });
                infoDiv.setText(`● Semantix Engine 已就绪 (引擎版本: v${health.engine_version || '0.8.0'}, 协议版本: v${health.api_version || '1'}, 模型: ${health.embedding_model || 'bge-small-zh-v1.5'})`);
            }

            // 3. Python 路径输入 (按需展开)
            const isAutoDetected = this.pythonStatus.includes('✅');
            const shouldShowInput = this.showPythonInput || (!isAutoDetected && this.plugin.settings.pythonPath !== 'uv');

            if (shouldShowInput) {
                new Setting(containerEl)
                    .setName(t('PYTHON_PATH_NAME'))
                    .setDesc(t('PYTHON_PATH_DESC'))
                    .addText(text => text
                        .setPlaceholder('uv')
                        .setValue(this.plugin.settings.pythonPath)
                        .onChange(async (value) => {
                            this.plugin.settings.pythonPath = value;
                            await this.plugin.saveSettings();
                            if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
                            this.debounceTimer = window.setTimeout(() => this.validatePython(value), 800);
                        }));
            }

            // 4. 自动启动
            new Setting(containerEl)
                .setName(t('AUTO_START_NAME'))
                .setDesc(t('AUTO_START_DESC'))
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.autoStartServer)
                    .onChange(async (value) => {
                        this.plugin.settings.autoStartServer = value;
                        await this.plugin.saveSettings();
                    }));

            // 5. 运行控制
            new Setting(containerEl)
                .setName(t('RUN_CONTROL_NAME'))
                .setDesc(t('RUN_CONTROL_DESC'))
                .addButton(btn => btn
                    .setButtonText(t('PROBE_CONNECTION'))
                    .onClick(async () => {
                        btn.setButtonText(t('TESTING'));
                        await this.plugin.checkConnection({ manual: true });
                        btn.setButtonText(t('PROBE_CONNECTION'));
                    }))
                .addButton(btn => btn
                    .setButtonText(t('WAKE_UP_BACKEND'))
                    .setCta()
                    .onClick(async () => {
                        btn.setDisabled(true);
                        btn.setButtonText(t('WAKING_UP'));
                        const status = await this.plugin.apiClient.checkFullHealth();
                        if (status === "READY") {
                            new Notice(t('BACKEND_RUNNING'));
                        } else if (status === "CONFLICT") {
                            // eslint-disable-next-line no-alert
                            if (confirm(t('PORT_CONFLICT'))) {
                                await this.plugin.serviceManager.forceKillAndStart();
                            }
                        } else {
                            await this.plugin.serviceManager.start({ force: true });
                        }
                        btn.setDisabled(false);
                        btn.setButtonText(t('WAKE_UP_BACKEND'));
                    }));

            // 看门狗说明
            const tipEl = containerEl.createEl('div', { 
                attr: { style: 'margin-top: 15px; margin-bottom: 15px; padding: 12px; border-radius: 8px; border-left: 4px solid var(--text-accent); background-color: var(--background-secondary-alt); font-size: 0.85em; line-height: 1.4;' } 
            });
            tipEl.createEl('strong', { text: t('WATCHDOG_TITLE'), attr: { style: 'display: block; margin-bottom: 4px; color: var(--text-accent);' } });
            tipEl.createSpan({ text: t('WATCHDOG_DESC') });
        }

        // =========================================================================
        // Section 2: 写作与灵感推荐 (Writing & Discovery)
        // =========================================================================
        new Setting(containerEl).setName(t('SETTINGS_SECTION_RECOMMENDATION')).setHeading();

        // 1. 语义精排策略
        new Setting(containerEl)
            .setName(t('RANKING_MODE_NAME'))
            .setDesc(t('RANKING_MODE_DESC'))
            .addDropdown(dropdown => dropdown
                .addOption('fast', t('RANKING_MODE_FAST'))
                .addOption('balanced', t('RANKING_MODE_BALANCED'))
                .addOption('high_quality', t('RANKING_MODE_HIGH'))
                .setValue(this.plugin.settings.rankingMode || 'balanced')
                .onChange(async (value) => {
                    this.plugin.settings.rankingMode = value as 'fast' | 'balanced' | 'high_quality';
                    await this.plugin.saveSettings();
                }));

        // 2. 各栏呈现卡片数 (2 - 8)
        new Setting(containerEl)
            .setName(t('TOP_N_NAME'))
            .setDesc(t('TOP_N_DESC') + this.plugin.settings.topNResults)
            .addSlider(slider => slider
                .setLimits(2, 8, 1)
                .setValue(this.plugin.settings.topNResults)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.topNResults = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        // 3. 实时防抖延迟
        new Setting(containerEl)
            .setName(t('DEBOUNCE_NAME'))
            .setDesc(t('DEBOUNCE_DESC'))
            .addText(text => text
                .setValue(this.plugin.settings.debounceDelay.toString())
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed) && parsed >= 100) {
                        this.plugin.settings.debounceDelay = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        // 4. 路径排除规则
        new Setting(containerEl)
            .setName(t('EXCLUSION_NAME'))
            .setDesc(t('EXCLUSION_DESC'))
            .addTextArea(text => text
                .setPlaceholder('Templates/**\n**/*.canvas\nArchive/**/*.md')
                .setValue(this.plugin.settings.exclusionRules)
                .onChange(async (value) => {
                    this.plugin.settings.exclusionRules = value;
                    await this.plugin.saveSettings();
                }));

        // =========================================================================
        // Section 3: 知识库索引管理 (Vault Indexing)
        // =========================================================================
        new Setting(containerEl).setName(t('SETTINGS_SECTION_INDEXING')).setHeading();

        // 1. Vault ID
        new Setting(containerEl)
            .setName(t('VAULT_ID_NAME'))
            .setDesc(t('VAULT_ID_DESC'))
            .addText(text => text
                .setValue(this.plugin.vaultId || '')
                .setDisabled(true));

        // 2. 全量建立索引
        new Setting(containerEl)
            .setName(t('START_INDEX_NAME'))
            .setDesc(t('START_INDEX_DESC'))
            .addButton(btn => btn
                .setButtonText(t('START_INDEX_BTN'))
                .setDisabled(this.plugin.isFullIndexingActive())
                .onClick(async () => {
                    btn.setDisabled(true);
                    btn.setButtonText(t('INDEXING_BTN'));
                    await this.plugin.startFullIndexing();
                    this.display();
                }));

        // 3. 取消索引
        new Setting(containerEl)
            .setName(t('CANCEL_INDEX_NAME'))
            .setDesc(t('CANCEL_INDEX_DESC'))
            .addButton(btn => btn
                .setButtonText(t('CANCEL_INDEX_BTN'))
                .setDisabled(!this.plugin.isFullIndexingActive())
                .onClick(() => {
                    this.plugin.cancelFullIndexing();
                    this.display();
                }));

        // 4. 增量同步间隔
        new Setting(containerEl)
            .setName(t('SYNC_INTERVAL_NAME'))
            .setDesc(t('SYNC_INTERVAL_DESC'))
            .addText(text => text
                .setValue(this.plugin.settings.syncBatchInterval.toString())
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed) && parsed >= 5) {
                        this.plugin.settings.syncBatchInterval = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        // =========================================================================
        // Section 4: 移动端与远程访问 (Mobile & Remote Access)
        // =========================================================================
        new Setting(containerEl).setName(t('SETTINGS_SECTION_MOBILE')).setHeading();

        if (Platform.isDesktop) {
            new Setting(containerEl)
                .setName(t('ENABLE_MOBILE_NAME'))
                .setDesc(t('ENABLE_MOBILE_DESC'))
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.enableOnMobile)
                    .onChange(async (value) => {
                        this.plugin.settings.enableOnMobile = value;
                        await this.plugin.saveSettings();
                        new Notice(t('MOBILE_RESTART_NOTICE'));
                    }));
        } else {
            const mobileNotice = containerEl.createEl('div', {
                cls: 'setting-item-description',
                attr: { style: 'margin-bottom: 15px; color: var(--text-muted); font-size: 0.85em; line-height: 1.5;' }
            });
            mobileNotice.setText(t('MOBILE_CURRENT_NOTICE'));
        }

        // =========================================================================
        // Section 5: 存储维护与高级操作 (Storage & Danger)
        // =========================================================================
        new Setting(containerEl).setName(t('SETTINGS_SECTION_STORAGE')).setHeading();

        // 1. LanceDB 物理指标卡片
        const dbSizeMb = this.dbMetrics?.db_size_bytes ? (this.dbMetrics.db_size_bytes / (1024 * 1024)).toFixed(2) : "0.00";
        const lastMt = this.dbMetrics?.last_maintenance_at ? new Date(this.dbMetrics.last_maintenance_at).toLocaleString() : t('STATUS_UNKNOWN');

        const metricsEl = containerEl.createEl('div', { 
            attr: { style: 'margin-bottom: 20px; padding: 15px; border-radius: 8px; background-color: var(--background-secondary-alt); border: 1px solid var(--background-modifier-border);' } 
        });
        metricsEl.createEl('div', { attr: { style: 'margin-bottom: 8px; font-size: 0.9em;' } }).innerHTML = `<strong>${t('DB_SIZE')}</strong> ${dbSizeMb} MB`;
        metricsEl.createEl('div', { attr: { style: 'font-size: 0.9em;' } }).innerHTML = `<strong>${t('LAST_MAINTENANCE')}</strong> ${lastMt}`;

        // 2. 历史保留天数
        new Setting(containerEl)
            .setName(t('RETENTION_DAYS'))
            .setDesc(t('RETENTION_DAYS_DESC'))
            .addSlider(slider => slider
                .setLimits(0, 30, 1)
                .setValue(this.plugin.settings.dbRetentionDays)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.dbRetentionDays = value;
                    await this.plugin.saveSettings();
                }));

        // 3. 执行磁盘优化按钮
        new Setting(containerEl)
            .setName(t('RUN_MAINTENANCE_BTN'))
            .setDesc(t('DB_MAINTENANCE_SECTION'))
            .addButton(btn => btn
                .setButtonText(t('RUN_MAINTENANCE_BTN'))
                .onClick(async () => {
                    btn.setDisabled(true);
                    btn.setButtonText(t('MAINTENANCE_RUNNING'));
                    const success = await this.plugin.apiClient.runMaintenance(this.plugin.settings.dbRetentionDays);
                    if (success) {
                        new Notice(t('MAINTENANCE_SUCCESS'));
                        this.dbMetrics = await this.plugin.apiClient.getMetrics();
                        this.display();
                    } else {
                        new Notice("❌ Maintenance failed.");
                    }
                    btn.setDisabled(false);
                    btn.setButtonText(t('RUN_MAINTENANCE_BTN'));
                }));

        // 4. 启发式噪音分析
        new Setting(containerEl)
            .setName(t('ADAPTIVE_FILTER_NAME'))
            .setDesc(t('ADAPTIVE_FILTER_DESC'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableAdaptiveFiltering)
                .onChange(async (value) => {
                    this.plugin.settings.enableAdaptiveFiltering = value;
                    await this.plugin.saveSettings();
                    
                    if (value && this.plugin.apiClient) {
                        this.plugin.checkConnection({ silent: true });
                    }
                }))
            .addButton(btn => btn
                .setButtonText(t('RUN_ADAPTIVE_ANALYSIS_BTN'))
                .setTooltip(t('RUN_ADAPTIVE_ANALYSIS_DESC'))
                .onClick(async () => {
                    btn.setDisabled(true);
                    const res = await this.plugin.apiClient.computeStopwords();
                    if (res) {
                        new Notice(t('ADAPTIVE_SUCCESS', { count: res.count }));
                        await this.plugin.checkConnection({ silent: true });
                    }
                    btn.setDisabled(false);
                }));

        // 5. 重建/清空向量数据库 (Danger Zone)
        new Setting(containerEl)
            .setName(t('REBUILD_INDEX_NAME'))
            .setDesc(t('REBUILD_INDEX_DESC'))
            .addButton(btn => btn
                .setButtonText(t('REBUILD_BTN'))
                .setWarning()
                .onClick(async () => {
                    // eslint-disable-next-line no-alert
                    const firstConfirm = confirm(t('CONFIRM_CLEAR_1'));
                    if (!firstConfirm) return;

                    // eslint-disable-next-line no-alert
                    const secondConfirm = confirm(t('CONFIRM_CLEAR_2'));
                    if (!secondConfirm) return;

                    btn.setButtonText(t('REBUILDING'));
                    btn.setDisabled(true);

                    const success = await this.plugin.apiClient.clearIndex();
                    if (success) {
                        new Notice(t('CLEAR_SUCCESS'));
                        this.plugin.checkConnection({ silent: true });
                    } else {
                        new Notice(t('CLEAR_FAILED'));
                    }

                    btn.setButtonText(t('REBUILD_BTN'));
                    btn.setDisabled(false);
                }));

        // 关键：在重绘完成后恢复滚动位置
        containerEl.scrollTop = savedScrollTop;
    }
}
