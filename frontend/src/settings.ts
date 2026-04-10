import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import SemantixPlugin from "./main";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";

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
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            this.updateStatus('backend', `❌ 校验出错: ${errorMsg}`);
        }
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        new Setting(containerEl).setName('配置 (Settings)').setHeading();

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
                        const isConnected = await this.plugin.apiClient.checkHealth();
                        if (isConnected) {
                            new Notice("Semantix: 连接成功 ✅");
                        } else {
                            new Notice("Semantix: 连接失败 ❌ 请检查远程地址或网络环境。");
                        }
                        this.plugin.checkConnection({ manual: true });
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
            
            new Setting(containerEl)
                .setName('Auto-start server')
                .setDesc('当 Obsidian 启动时，自动在后台拉起后端服务（约占用 400MB 内存）')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.autoStartServer)
                    .onChange(async (value) => {
                        this.plugin.settings.autoStartServer = value;
                        await this.plugin.saveSettings();
                        new Notice(value ? "已开启自启，重启插件或 Obsidian 生效。" : "已关闭自启。");
                    }));

            new Setting(containerEl)
                .setName('Python / uv path')
                .setDesc('后端运行环境的执行路径 (例如 uv, python, C:\\Python311\\python.exe)')
                .addText(text => text
                    .setPlaceholder('uv')
                    .setValue(this.plugin.settings.pythonPath)
                    .onChange(async (value) => {
                        this.plugin.settings.pythonPath = value;
                        await this.plugin.saveSettings();
                        
                        if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
                        this.debounceTimer = window.setTimeout(() => this.validatePython(value), 800);
                    }));
            
            if (this.pythonStatus) {
                containerEl.createEl('div', { text: this.pythonStatus, cls: 'setting-item-description', attr: { style: 'color: var(--text-muted); margin-top: -10px; margin-bottom: 10px; font-size: 0.85em;' } });
            }

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

            if (this.backendStatus) {
                containerEl.createEl('div', { text: this.backendStatus, cls: 'setting-item-description', attr: { style: 'color: var(--text-muted); margin-top: -10px; margin-bottom: 20px; font-size: 0.85em;' } });
            }

            new Setting(containerEl)
                .setName('Sync dependencies on start')
                .setDesc('启动前自动执行一次 uv sync (推荐开启，确保后端依赖最新)')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.uvSyncOnStart)
                    .onChange(async (value) => {
                        this.plugin.settings.uvSyncOnStart = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('本地后端测试')
                .setDesc('手动尝试拉起或探测后端连接状态')
                .addButton(btn => btn
                    .setButtonText("测试自启动")
                    .onClick(async () => {
                        btn.setButtonText("测试中...");
                        const isConnected = await this.plugin.apiClient.checkHealth();
                        if (isConnected) {
                            new Notice("Semantix: 后端已就绪 ✅");
                        } else {
                            new Notice("Semantix: 目前无法连接，请确认路径配置并点击自启尝试。");
                        }
                        this.plugin.checkConnection({ manual: true });
                        btn.setButtonText("测试自启动");
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
