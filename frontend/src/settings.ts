import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import SemantixPlugin from "./main";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { HealthStatus } from "./api/client";

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
        this.pythonStatus = "⏳ 正在检测 Python 环境...";
        // 简单触发一次刷新
        this.display();

        exec(`"${pythonPath}" --version`, (error, stdout, stderr) => {
            if (error) {
                this.updateStatus('python', `❌ 无效路径或程序不可执行 (${error.message.split('\n')[0]})`);
            } else {
                const version = stdout.trim() || stderr.trim();
                this.updateStatus('python', `✅ 已识别: ${version}`);
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
            this.updateStatus('python', `✅ 已检测到 uv 项目，将通过 uv 驱动服务`);
            return;
        }

        if (fs.existsSync(venvPython)) {
            this.plugin.settings.pythonPath = venvPython;
            this.plugin.saveSettings();
            this.updateStatus('python', `✅ 已自动关联项目虚拟环境: ${venvPython}`);
        } else {
            this.updateStatus('python', `⚠️ 未发现项目虚拟环境，将使用默认配置或系统环境变量`);
        }
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // 状态页眉
        const status = this.plugin.getConnectionStatus();
        let statusText = "未知";
        let statusColor = "var(--text-muted)";
        
        switch (status) {
            case 'connected': statusText = "已连接"; statusColor = "var(--color-green)"; break;
            case 'disconnected': statusText = "未连接"; statusColor = "var(--text-accent)"; break;
            case 'syncing': statusText = "连接中/索引中"; statusColor = "var(--color-blue)"; break;
            case 'disabled': statusText = "已禁用 (移动端休眠或手动停止)"; statusColor = "var(--text-muted)"; break;
        }

        const header = containerEl.createEl('div', { attr: { style: 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding: 10px; border-radius: 8px; background-color: var(--background-secondary);' } });
        header.createEl('h2', { text: 'Semantix 配置', attr: { style: 'margin: 0;' } });
        
        const badge = header.createEl('div', { attr: { style: `display: flex; align-items: center; gap: 8px; padding: 4px 12px; border-radius: 12px; border: 1px solid ${statusColor}; font-size: 0.85em;` } });
        badge.createEl('span', { attr: { style: `width: 8px; height: 8px; border-radius: 50%; background-color: ${statusColor};` } });
        badge.createEl('span', { text: statusText, attr: { style: `color: ${statusColor}; font-weight: bold;` } });

        new Setting(containerEl).setName('通用配置 (General)').setHeading();

        new Setting(containerEl)
            .setName('Backend mode')
            .setDesc('选择后端运行位置。本地边车模式可随插件自动拉起后台进程。')
            .addDropdown(dropdown => dropdown
                .addOption('local', 'Local Sidecar (本地边车)')
                .addOption('remote', 'Remote Service (远程服务)')
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
            new Setting(containerEl).setName('远程连接配置 (Remote Connection)').setHeading();
            new Setting(containerEl)
                .setName('Backend API URL')
                .setDesc('远程后端服务的接口地址')
                .addText(text => text
                    .setPlaceholder('http://your-server:8000')
                    .setValue(this.plugin.settings.backendUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.backendUrl = value;
                        await this.plugin.saveSettings();
                    }))
                .addButton(btn => btn
                    .setButtonText("测试连接")
                    .onClick(async () => {
                        btn.setButtonText("测试中...");
                        await this.plugin.checkConnection({ manual: true });
                        btn.setButtonText("测试连接");
                    }));

            new Setting(containerEl)
                .setName('API token')
                .setDesc('可选：远程后端开启鉴权时需填写')
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
            new Setting(containerEl).setName('本地服务管理 (Local Sidecar)').setHeading();
            
            // 1. [核心输入] 后端项目路径
            new Setting(containerEl)
                .setName('Backend project path')
                .setDesc('后端代码所在的绝对路径（应指向包含 main.py 的文件夹）')
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
                        text: '修改', 
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
                        text: '一键初始化环境', 
                        cls: 'mod-cta',
                        attr: { style: 'font-size: 10px; height: 20px; padding: 0 8px; line-height: 1;' } 
                    });
                    repairBtn.onclick = async () => {
                        repairBtn.disabled = true;
                        repairBtn.innerText = "正在初始化...";
                        this.updateStatus('python', "⏳ 正在创建并同步环境 (uv venv + sync)...");
                        try {
                            await this.plugin.serviceManager.initializeEnvironment();
                            new Notice("Semantix: 环境初始化成功 ✅");
                            // 重新探测
                            this.validateBackend(this.plugin.settings.backendPath);
                        } catch (e) {
                            new Notice(`Semantix: 环境初始化失败 ❌ ${e}`);
                            this.updateStatus('python', `❌ 初始化失败: ${e}`);
                        }
                    };
                }
            }

            // 3. [高级配置] Python 路径（仅在需要时展开）
            const isAutoDetected = this.pythonStatus.includes('✅');
            const shouldShowInput = this.showPythonInput || (!isAutoDetected && this.plugin.settings.pythonPath !== 'uv');

            if (shouldShowInput) {
                new Setting(containerEl)
                    .setName('Python / uv path (Manual Override)')
                    .setDesc('后端运行环境的执行路径')
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

            new Setting(containerEl).setName('自动化与控制 (Automation & Controls)').setHeading();

            new Setting(containerEl)
                .setName('Auto-start server')
                .setDesc('Obsidian 启动时自动拉起后端进程')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.autoStartServer)
                    .onChange(async (value) => {
                        this.plugin.settings.autoStartServer = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Sync dependencies on start')
                .setDesc('启动前自动执行一次 uv sync')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.uvSyncOnStart)
                    .onChange(async (value) => {
                        this.plugin.settings.uvSyncOnStart = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('运行控制')
                .setDesc('检查后端存活状态，或在服务未自动拉起时尝试手动启动。')
                .addButton(btn => btn
                    .setButtonText("探测服务连接")
                    .onClick(async () => {
                        btn.setButtonText("探测中...");
                        await this.plugin.checkConnection({ manual: true });
                        btn.setButtonText("探测服务连接");
                    }))
                .addButton(btn => btn
                    .setButtonText("🚀 立即唤醒后端")
                    .setCta()
                    .onClick(async () => {
                        btn.setDisabled(true);
                        btn.setButtonText("正在唤醒...");
                        const status = await this.plugin.apiClient.checkFullHealth();
                        if (status === "READY") {
                            new Notice("Semantix: 后端已在运行中 ✅");
                        } else if (status === "CONFLICT") {
                            if (confirm("⚠️ 端口冲突预警\n\n检测到 8000 端口已被占用（非本插件进程）。\n\n是否尝试强制清理该端口并启动？")) {
                                await this.plugin.serviceManager.forceKillAndStart();
                            }
                        } else {
                            await this.plugin.serviceManager.start({ force: true });
                        }
                        btn.setDisabled(false);
                        btn.setButtonText("🚀 立即唤醒后端");
                    }));
        }

        new Setting(containerEl)
            .setName('Vault ID')
            .setDesc('自动生成的仓库标识（多库切换的关键）')
            .addText(text => text
                .setValue(this.plugin.vaultId || '')
                .setDisabled(true));

        new Setting(containerEl).setName('索引与同步 (Indexing)').setHeading();

        new Setting(containerEl)
            .setName('初始化向量雷达')
            .setDesc('全量索引当前 Vault。进度不会持久化，关闭或重启将重置。')
            .addButton(btn => btn
                .setButtonText("开始索引")
                .setDisabled(this.plugin.isFullIndexingActive())
                .onClick(async () => {
                    btn.setDisabled(true);
                    btn.setButtonText("索引中...");
                    await this.plugin.startFullIndexing();
                    this.display();
                }));

        new Setting(containerEl)
            .setName('取消当前索引')
            .setDesc('请求取消当前全量索引，当前批次完成后停止。')
            .addButton(btn => btn
                .setButtonText("取消索引")
                .setDisabled(!this.plugin.isFullIndexingActive())
                .onClick(() => {
                    this.plugin.cancelFullIndexing();
                    this.display();
                }));

        new Setting(containerEl)
            .setName('Sync batch interval (s)')
            .setDesc('增量同步批量发送的间隔秒数')
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
            .setName('Exclusion rules')
            .setDesc('每行输入一个不需要索引的路径，支持标准的 Glob 通配符（如 Templates/** 排除目录内所有，**/*.canvas 排除所有画板）')
            .addTextArea(text => text
                .setPlaceholder('Templates/**\n**/*.canvas\nArchive/**/*.md')
                .setValue(this.plugin.settings.exclusionRules)
                .onChange(async (value) => {
                    this.plugin.settings.exclusionRules = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Explainable results')
            .setDesc('返回最匹配的段落片段而非全文开头。默认开启（索引时分块存储，无额外性能开销）。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableExplainableResults)
                .onChange(async (value) => {
                    this.plugin.settings.enableExplainableResults = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName('搜索与推荐 (Search)').setHeading();

        new Setting(containerEl)
            .setName('Whisperer scope')
            .setDesc('动态灵感的作用域')
            .addDropdown(dropdown => dropdown
                .addOption('paragraph', 'Current Paragraph (当前段落)')
                .addOption('document', 'Current File (当前全文)')
                .setValue(this.plugin.settings.whispererScope)
                .onChange(async (value) => {
                    this.plugin.settings.whispererScope = value as 'paragraph' | 'document';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Debounce delay (ms)')
            .setDesc('输入防抖延迟毫秒数 (500ms - 5000ms)')
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
            .setName('Top N results')
            .setDesc('呈现的最大相关笔记数量')
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
            .setName('Minimum similarity threshold')
            .setDesc(`滤除低于此分数的弱相关笔记。调高此值可获得更精准的灵感，调低可获得更发散的联想。当前: ${this.plugin.settings.minSimilarityThreshold.toFixed(2)}`)
            .addSlider(slider => slider
                .setLimits(0, 100, 1)
                .setValue(Math.round(this.plugin.settings.minSimilarityThreshold * 100))
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.minSimilarityThreshold = value / 100;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Filter linked notes')
            .setDesc('是否在推荐列表中隐藏当前笔记已链接过的文件')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.filterLinkedNotes)
                .onChange(async (value) => {
                    this.plugin.settings.filterLinkedNotes = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('High score threshold (green)')
            .setDesc(`相似度 >= 此值显示绿色。必须大于蓝色阈值。当前: ${this.plugin.settings.colorThresholdHigh.toFixed(2)}`)
            .addSlider(slider => slider
                .setLimits(0, 100, 1)
                .setValue(Math.round(this.plugin.settings.colorThresholdHigh * 100))
                .setDynamicTooltip()
                .onChange(async (value) => {
                    const newValue = value / 100;
                    // 确保高分阈值始终大于中分阈值
                    if (newValue <= this.plugin.settings.colorThresholdMedium) {
                        new Notice('高分阈值必须大于中分阈值！');
                        return;
                    }
                    this.plugin.settings.colorThresholdHigh = newValue;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Medium score threshold (blue)')
            .setDesc(`相似度 >= 此值显示蓝色，< 此值显示黄色。当前: ${this.plugin.settings.colorThresholdMedium.toFixed(2)}`)
            .addSlider(slider => slider
                .setLimits(0, 100, 1)
                .setValue(Math.round(this.plugin.settings.colorThresholdMedium * 100))
                .setDynamicTooltip()
                .onChange(async (value) => {
                    const newValue = value / 100;
                    // 确保中分阈值始终小于高分阈值
                    if (newValue >= this.plugin.settings.colorThresholdHigh) {
                        new Notice('中分阈值必须小于高分阈值！');
                        return;
                    }
                    this.plugin.settings.colorThresholdMedium = newValue;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName('移动端与性能').setHeading();

        new Setting(containerEl)
            .setName('Enable on mobile')
            .setDesc('在移动端强制工作（开启可能增加耗电；修改后需要重启插件生效）')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableOnMobile)
                .onChange(async (value) => {
                    this.plugin.settings.enableOnMobile = value;
                    await this.plugin.saveSettings();
                    new Notice("Semantix: 移动端开关修改后请重启插件生效。");
                }));

        new Setting(containerEl).setName('危险操作').setHeading();

        new Setting(containerEl)
            .setName('重建向量索引')
            .setDesc('清空向量数据库并重新触发全量索引。此操作不可逆，索引期间插件功能可能暂时不可用。')
            .addButton(btn => btn
                .setButtonText("重建索引")
                .setWarning()
                .onClick(async () => {
                    // eslint-disable-next-line no-alert
                    const firstConfirm = confirm(
                        "⚠️ 确定要清空向量数据库吗？\n\n此操作将删除所有已建立的语义索引数据，之后需要重新进行全量索引。"
                    );
                    if (!firstConfirm) return;

                    // eslint-disable-next-line no-alert
                    const secondConfirm = confirm(
                        "⚠️ 再次确认：此操作不可逆！\n\n点击「确定」将立即清空向量库。"
                    );
                    if (!secondConfirm) return;

                    btn.setButtonText("清空中...");
                    btn.setDisabled(true);

                    const success = await this.plugin.apiClient.clearIndex();
                    if (success) {
                        new Notice("Semantix: 向量索引已清空 ✅ 请手动触发全量索引或重启插件。");
                        // 更新状态显示
                        this.plugin.checkConnection({ silent: true });
                    } else {
                        new Notice("Semantix: 清空索引失败 ❌ 请检查后端服务。");
                    }

                    btn.setButtonText("重建索引");
                    btn.setDisabled(false);
                }));
    }
}
