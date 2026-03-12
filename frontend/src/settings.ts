import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import SemantixPlugin from "./main";

export interface SemantixSettings {
    backendUrl: string;
    apiToken: string;
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
    backendUrl: 'http://localhost:8000',
    apiToken: '',
    whispererScope: 'paragraph',
    debounceDelay: 2000,
    syncBatchInterval: 60,
    exclusionRules: '',
    filterLinkedNotes: true,
    topNResults: 5,
    minSimilarityThreshold: 0.70,
    colorThresholdHigh: 0.85,
    colorThresholdMedium: 0.75,
    enableExplainableResults: false,
    enableOnMobile: false
};

export class SemantixSettingTab extends PluginSettingTab {
    plugin: SemantixPlugin;

    constructor(app: App, plugin: SemantixPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Semantix (语义雷达) 配置' });

        new Setting(containerEl)
            .setName('Backend API URL')
            .setDesc('本地或远程后端服务的接口地址')
            .addText(text => text
                .setPlaceholder('http://localhost:8000')
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
                        new Notice("Semantix: 连接失败 ❌ 请检查后端服务是否启动。");
                    }
                    this.plugin.checkConnection(); // update sidebar indicator
                    btn.setButtonText("测试连接");
                 }));

        new Setting(containerEl)
            .setName('API Token')
            .setDesc('可选：后端开启 SEMANTIX_API_TOKEN 时需填写')
            .addText(text => {
                text.setPlaceholder('optional');
                text.setValue(this.plugin.settings.apiToken);
                text.inputEl.type = 'password';
                text.onChange(async (value) => {
                    this.plugin.settings.apiToken = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('Whisperer Scope')
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
            .setName('Debounce Delay (ms)')
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
            .setName('Sync Batch Interval (s)')
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
            .setName('Filter Linked Notes')
            .setDesc('是否在推荐列表中隐藏当前笔记已链接过的文件')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.filterLinkedNotes)
                .onChange(async (value) => {
                    this.plugin.settings.filterLinkedNotes = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Top N Results')
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
            .setName('Minimum Similarity Threshold')
            .setDesc('滤除低于此分数的弱相关笔记。调高此值可获得更精准的灵感，调低可获得更发散的联想。')
            .addSlider(slider => slider
                .setLimits(0, 100, 1)
                .setValue(Math.round(this.plugin.settings.minSimilarityThreshold * 100))
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.minSimilarityThreshold = value / 100;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Explainable Results')
            .setDesc('开启后返回最匹配的段落片段（默认关闭以减少性能开销）。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableExplainableResults)
                .onChange(async (value) => {
                    this.plugin.settings.enableExplainableResults = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('High Score Threshold (Green)')
            .setDesc(`相似度 >= 此值显示绿色。必须大于蓝色阈值。当前: ${(this.plugin.settings.colorThresholdHigh * 100).toFixed(0)}%`)
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
            .setName('Medium Score Threshold (Blue)')
            .setDesc(`相似度 >= 此值显示蓝色，< 此值显示黄色。当前: ${(this.plugin.settings.colorThresholdMedium * 100).toFixed(0)}%`)
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

        new Setting(containerEl)
            .setName('Exclusion Rules')
            .setDesc('每行输入一个不需要索引的路径模式 (如 Templates/)')
            .addTextArea(text => text
                .setPlaceholder('Templates/\nAttachments/')
                .setValue(this.plugin.settings.exclusionRules)
                .onChange(async (value) => {
                    this.plugin.settings.exclusionRules = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: '索引操作' });

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
            .setName('Vault ID')
            .setDesc('自动生成的 Vault 标识（基于 vault path 哈希）')
            .addText(text => text
                .setValue(this.plugin.vaultId || '')
                .setDisabled(true));

        containerEl.createEl('h3', { text: '高级选项' });

        new Setting(containerEl)
            .setName('Enable on Mobile')
            .setDesc('在移动端强制工作（开启可能增加耗电；修改后需要重启插件生效）')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableOnMobile)
                .onChange(async (value) => {
                    this.plugin.settings.enableOnMobile = value;
                    await this.plugin.saveSettings();
                    new Notice("Semantix: 移动端开关修改后请重启插件生效。");
                }));

        containerEl.createEl('h3', { text: '危险操作' });

        new Setting(containerEl)
            .setName('重建向量索引')
            .setDesc('清空向量数据库并重新触发全量索引。此操作不可逆，索引期间插件功能可能暂时不可用。')
            .addButton(btn => btn
                .setButtonText("重建索引")
                .setWarning()
                .onClick(async () => {
                    // 第一次确认
                    const firstConfirm = confirm(
                        "⚠️ 确定要清空向量数据库吗？\n\n此操作将删除所有已建立的语义索引数据，之后需要重新进行全量索引。"
                    );
                    if (!firstConfirm) return;

                    // 第二次确认
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
                        this.plugin.checkConnection();
                    } else {
                        new Notice("Semantix: 清空索引失败 ❌ 请检查后端服务。");
                    }

                    btn.setButtonText("重建索引");
                    btn.setDisabled(false);
                }));
    }
}
