import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import SemantixPlugin from "./main";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { HealthStatus } from "./api/client";
import { t } from "./i18n/helpers";

export interface SemantixSettings {
    backendMode: 'local' | 'remote';
    backendUrl: string;
    apiToken: string;
    autoStartServer: boolean;
    pythonPath: string;
    backendPath: string;
    uvSyncOnStart: boolean;
    whispererScope: 'paragraph' | 'document';
    debounceDelay: number;
    syncBatchInterval: number;
    exclusionRules: string;
    filterLinkedNotes: boolean;
    topNResults: number;
    minSimilarityThreshold: number;
    colorThresholdHigh: number;
    colorThresholdMedium: number;
    enableExplainableResults: boolean;
    enableOnMobile: boolean;
}

export const DEFAULT_SETTINGS: SemantixSettings = {
    backendMode: 'local',
    backendUrl: 'http://localhost:8000',
    apiToken: '',
    autoStartServer: false,
    pythonPath: 'uv',
    backendPath: '',
    uvSyncOnStart: false,
    whispererScope: 'paragraph',
    debounceDelay: 2000,
    syncBatchInterval: 60,
    exclusionRules: '',
    filterLinkedNotes: true,
    topNResults: 5,
    minSimilarityThreshold: 0.70,
    colorThresholdHigh: 0.85,
    colorThresholdMedium: 0.75,
    enableExplainableResults: true,
    enableOnMobile: false
};

export class SemantixSettingTab extends PluginSettingTab {
    plugin: SemantixPlugin;
    private pythonStatus: string = "";
    private backendStatus: string = "";
    private showPythonInput: boolean = false;
    private debounceTimer: number | null = null;

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
        if (!pythonPath) {
            this.updateStatus('python', "");
            return;
        }
        this.pythonStatus = t('VALIDATING_PYTHON');
        // 简单触发一次刷新
        this.display();

        exec(`"${pythonPath}" --version`, (error, stdout, stderr) => {
            if (error) {
                this.updateStatus('python', t('PYTHON_INVALID') + ` (${error.message.split('\n')[0]})`);
            } else {
                const version = stdout.trim() || stderr.trim();
                this.updateStatus('python', t('PYTHON_IDENTIFIED') + version);
            }
        });
    }

    private validateBackend(backendPath: string) {
        if (!backendPath) {
            this.updateStatus('backend', "");
            return;
        }

        try {
            if (!fs.existsSync(backendPath)) {
                this.updateStatus('backend', "❌ 路径不存在");
                return;
            }
            
            const stats = fs.statSync(backendPath);
            if (!stats.isDirectory()) {
                this.updateStatus('backend', "❌ 提供的路径不是一个目录");
                return;
            }

            const mainPy = path.join(backendPath, 'main.py');
            if (!fs.existsSync(mainPy)) {
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
        const isWindows = process.platform === "win32";
        const venvPython = isWindows 
            ? path.join(backendPath, '.venv', 'Scripts', 'python.exe')
            : path.join(backendPath, '.venv', 'bin', 'python');

        // 特殊逻辑：如果是 uv 项目（包含 uv.lock），我们强制使用 'uv' 命令，因为 uv run 比直连 .venv 更稳健
        const uvLock = path.join(backendPath, 'uv.lock');
        if (fs.existsSync(uvLock)) {
            this.plugin.settings.pythonPath = 'uv';
            this.plugin.saveSettings();
            this.updateStatus('python', t('UV_DETECTED'));
            return;
        }

        if (fs.existsSync(venvPython)) {
            this.plugin.settings.pythonPath = venvPython;
            this.plugin.saveSettings();
            this.updateStatus('python', t('VENV_DETECTED') + venvPython);
        } else {
            this.updateStatus('python', t('VENV_NOT_FOUND'));
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

        const header = containerEl.createEl('div', { attr: { style: 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding: 10px; border-radius: 8px; background-color: var(--background-secondary);' } });
        header.createEl('h2', { text: t('SETTINGS_TITLE'), attr: { style: 'margin: 0;' } });
        
        const badge = header.createEl('div', { attr: { style: `display: flex; align-items: center; gap: 8px; padding: 4px 12px; border-radius: 12px; border: 1px solid ${statusColor}; font-size: 0.85em;` } });
        badge.createEl('span', { attr: { style: `width: 8px; height: 8px; border-radius: 50%; background-color: ${statusColor};` } });
        badge.createEl('span', { text: statusText, attr: { style: `color: ${statusColor}; font-weight: bold;` } });

        new Setting(containerEl).setName(t('SETTINGS_GENERAL_SECTION')).setHeading();

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

        if (this.plugin.settings.backendMode === 'remote') {
            new Setting(containerEl).setName(t('REMOTE_SECTION')).setHeading();
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
            new Setting(containerEl).setName(t('LOCAL_SECTION')).setHeading();
            
            // 1. [核心输入] 后端项目路径
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

            // 2. [即时反馈] 环境探测状态（紧贴路径下方）
            if (this.pythonStatus || this.backendStatus) {
                const isError = this.pythonStatus.includes('❌') || this.pythonStatus.includes('⚠️');
                const isSuccess = this.pythonStatus.includes('✅');
                let color = 'var(--text-muted)';
                if (isError) color = 'var(--text-accent)'; // 橙色/红色提示
                if (isSuccess) color = 'var(--color-green)';

                const statusDiv = containerEl.createEl('div', { 
                    cls: 'setting-item-description', 
                    attr: { style: `color: ${color}; margin-top: -15px; margin-bottom: 20px; font-size: 0.85em; font-weight: ${isSuccess ? 'bold' : 'normal'}; display: flex; align-items: center; justify-content: space-between;` } 
                });
                
                // 优先显示环境状态，如果没有则显示路径校验状态
                statusDiv.createEl('span', { text: this.pythonStatus || this.backendStatus });

                const rightContainer = statusDiv.createEl('div', { attr: { style: 'display: flex; align-items: center; gap: 10px;' } });

                // 辅助逻辑 A: 如果成功，显示“修改”
                if (isSuccess && !this.showPythonInput) {
                    const changeBtn = rightContainer.createEl('a', { 
                        text: t('BACKEND_MODE_NAME'), // Reuse or use specific 'Modify' key
                        attr: { style: 'color: var(--text-accent); cursor: pointer; text-decoration: underline;' } 
                    });
                    changeBtn.onclick = () => {
                        this.showPythonInput = true;
                        this.display();
                    };
                }

                // 辅助逻辑 B: 如果缺失且是 UV 项目，显示“初始化环境”
                if (this.pythonStatus.includes('⚠️') && this.pythonStatus.includes('uv')) {
                    const repairBtn = rightContainer.createEl('button', { 
                        text: t('INITIALIZE_ENV'), 
                        cls: 'mod-cta',
                        attr: { style: 'font-size: 10px; height: 20px; padding: 0 8px; line-height: 1;' } 
                    });
                    repairBtn.onclick = async () => {
                        repairBtn.disabled = true;
                        repairBtn.innerText = t('INITIALIZING');
                        this.updateStatus('python', t('SYNCING_ENV'));
                        try {
                            await this.plugin.serviceManager.initializeEnvironment();
                            new Notice(t('ENV_SUCCESS'));
                            // 重新探测
                            this.validateBackend(this.plugin.settings.backendPath);
                        } catch (e) {
                            new Notice(t('ENV_FAILED') + e);
                            this.updateStatus('python', t('PYTHON_INVALID') + `: ${e}`);
                        }
                    };
                }
            }

            // 3. [高级配置] Python 路径（仅在需要时展开）
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

            new Setting(containerEl).setName(t('AUTOMATION_SECTION')).setHeading();

            new Setting(containerEl)
                .setName(t('AUTO_START_NAME'))
                .setDesc(t('AUTO_START_DESC'))
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.autoStartServer)
                    .onChange(async (value) => {
                        this.plugin.settings.autoStartServer = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName(t('SYNC_ON_START_NAME'))
                .setDesc(t('SYNC_ON_START_DESC'))
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.uvSyncOnStart)
                    .onChange(async (value) => {
                        this.plugin.settings.uvSyncOnStart = value;
                        await this.plugin.saveSettings();
                    }));

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
                            if (confirm(t('PORT_CONFLICT'))) {
                                await this.plugin.serviceManager.forceKillAndStart();
                            }
                        } else {
                            await this.plugin.serviceManager.start({ force: true });
                        }
                        btn.setDisabled(false);
                        btn.setButtonText(t('WAKE_UP_BACKEND'));
                    }));

            // 存活机制说明
            const tipEl = containerEl.createEl('div', { 
                attr: { style: 'margin-top: 15px; padding: 12px; border-radius: 8px; border-left: 4px solid var(--text-accent); background-color: var(--background-secondary-alt); font-size: 0.85em; line-height: 1.4;' } 
            });
            tipEl.createEl('strong', { text: t('WATCHDOG_TITLE'), attr: { style: 'display: block; margin-bottom: 4px; color: var(--text-accent);' } });
            tipEl.createSpan({ text: t('WATCHDOG_DESC') });
        }

        new Setting(containerEl)
            .setName(t('VAULT_ID_NAME'))
            .setDesc(t('VAULT_ID_DESC'))
            .addText(text => text
                .setValue(this.plugin.vaultId || '')
                .setDisabled(true));

        new Setting(containerEl).setName(t('INDEXING_SECTION')).setHeading();

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

        new Setting(containerEl)
            .setName(t('SYNC_INTERVAL_NAME'))
            .setDesc(t('SYNC_INTERVAL_DESC'))
            .addText(text => text
                .setValue(this.plugin.settings.syncBatchInterval.toString())
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.syncBatchInterval = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

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

        new Setting(containerEl)
            .setName(t('EXPLAINABLE_NAME'))
            .setDesc(t('EXPLAINABLE_DESC'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableExplainableResults)
                .onChange(async (value) => {
                    this.plugin.settings.enableExplainableResults = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName(t('SEARCH_SECTION')).setHeading();

        new Setting(containerEl)
            .setName(t('WHISPERER_SCOPE_NAME'))
            .setDesc(t('WHISPERER_SCOPE_DESC'))
            .addDropdown(dropdown => dropdown
                .addOption('paragraph', t('WHISPERER_PARAGRAPH'))
                .addOption('document', t('WHISPERER_DOCUMENT'))
                .setValue(this.plugin.settings.whispererScope)
                .onChange(async (value) => {
                    this.plugin.settings.whispererScope = value as 'paragraph' | 'document';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('DEBOUNCE_NAME'))
            .setDesc(t('DEBOUNCE_DESC'))
            .addText(text => text
                .setValue(this.plugin.settings.debounceDelay.toString())
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.debounceDelay = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName(t('TOP_N_NAME'))
            .setDesc(t('TOP_N_DESC'))
            .addText(text => text
                .setValue(this.plugin.settings.topNResults.toString())
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.topNResults = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName(t('MIN_SIMILARITY_NAME'))
            .setDesc(t('MIN_SIMILARITY_DESC') + this.plugin.settings.minSimilarityThreshold.toFixed(2))
            .addSlider(slider => slider
                .setLimits(0, 100, 1)
                .setValue(Math.round(this.plugin.settings.minSimilarityThreshold * 100))
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.minSimilarityThreshold = value / 100;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('FILTER_LINKED_NAME'))
            .setDesc(t('FILTER_LINKED_DESC'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.filterLinkedNotes)
                .onChange(async (value) => {
                    this.plugin.settings.filterLinkedNotes = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('THRESHOLD_HIGH_NAME'))
            .setDesc(t('THRESHOLD_HIGH_DESC') + this.plugin.settings.colorThresholdHigh.toFixed(2))
            .addSlider(slider => slider
                .setLimits(0, 100, 1)
                .setValue(Math.round(this.plugin.settings.colorThresholdHigh * 100))
                .setDynamicTooltip()
                .onChange(async (value) => {
                    const newValue = value / 100;
                    // 确保高分阈值始终大于中分阈值
                    if (newValue <= this.plugin.settings.colorThresholdMedium) {
                        new Notice(t('THRESHOLD_ERROR_HIGH'));
                        return;
                    }
                    this.plugin.settings.colorThresholdHigh = newValue;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('THRESHOLD_MED_NAME'))
            .setDesc(t('THRESHOLD_MED_DESC') + this.plugin.settings.colorThresholdMedium.toFixed(2))
            .addSlider(slider => slider
                .setLimits(0, 100, 1)
                .setValue(Math.round(this.plugin.settings.colorThresholdMedium * 100))
                .setDynamicTooltip()
                .onChange(async (value) => {
                    const newValue = value / 100;
                    // 确保中分阈值始终小于高分阈值
                    if (newValue >= this.plugin.settings.colorThresholdHigh) {
                        new Notice(t('THRESHOLD_ERROR_MED'));
                        return;
                    }
                    this.plugin.settings.colorThresholdMedium = newValue;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName(t('MOBILE_SECTION')).setHeading();

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

        new Setting(containerEl).setName(t('DANGER_SECTION')).setHeading();

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
                        // 更新状态显示
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
