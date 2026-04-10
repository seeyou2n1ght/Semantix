import { ItemView, WorkspaceLeaf } from 'obsidian';
import SemantixPlugin from '../main';
import { SearchResultItem } from '../api/types';
import { t } from '../i18n/helpers';

export const WHISPERER_VIEW_TYPE = "semantix-whisperer-view";

/**
 * 动态灵感视图 —— 独立侧边栏面板
 * 实时展示与当前编辑/阅读内容语义相关的历史笔记
 */
export class WhispererView extends ItemView {
    plugin: SemantixPlugin;
    private indicatorEl: HTMLElement;
    private statusTextEl: HTMLElement;
    private indexStatusEl: HTMLElement;
    private indexTimestampEl: HTMLElement;
    private indexProgressTextEl: HTMLElement;
    private indexProgressBarEl: HTMLElement;
    private indexProgressRowEl: HTMLElement;
    private whispererContainer: HTMLElement;
    private whispererResultsEl: HTMLElement;
    private loadingEl: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: SemantixPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() {
        return WHISPERER_VIEW_TYPE;
    }

    getDisplayText() {
        return t('VIEW_WHISPERER_TITLE');
    }

    getIcon() {
        return "message-circle";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        if (!container) return;

        container.empty();

        // 移动端休眠检测
        if (this.plugin.isMobileHibernating) {
            container.createEl("div", { cls: "semantix-hibernating" }).createEl("p", {
                text: t('MOBILE_HIBERNATING'),
                cls: "semantix-empty-text"
            });
            return;
        }
        
        const wrapper = container.createEl("div", { cls: "semantix-sidebar-wrapper" });
        
        // --- 状态指示灯 ---
        const statusArea = wrapper.createEl("div", { cls: "semantix-status-area" });

        const statusRow = statusArea.createEl("div", { cls: "semantix-status-row" });

        this.indicatorEl = statusRow.createEl("div", { cls: "semantix-status-indicator" });
        
        this.statusTextEl = statusRow.createEl("span", { 
            text: t('TESTING'), 
            cls: "semantix-status-text" 
        });

        this.indexStatusEl = statusArea.createEl("span", { 
            text: t('INDEXED_COUNT') + "-", 
            cls: "semantix-index-status" 
        });

        this.indexTimestampEl = statusArea.createEl("span", { 
            text: "", 
            cls: "semantix-index-timestamp" 
        });
        this.indexTimestampEl.style.display = "none";

        this.indexProgressRowEl = statusArea.createEl("div", { cls: "semantix-indexing-row" });

        this.indexProgressTextEl = this.indexProgressRowEl.createEl("span", { 
            text: t('INDEXING_PROGRESS') + "0 / 0", 
            cls: "semantix-index-status" 
        });

        const progressBar = this.indexProgressRowEl.createEl("div", { cls: "semantix-progress-bar" });
        this.indexProgressBarEl = progressBar.createEl("div", { cls: "semantix-progress-bar-fill" });

        // --- 动态灵感结果区 ---
        const contentArea = wrapper.createEl("div", { cls: "semantix-content-area" });
        contentArea.style.padding = "10px";
        
        contentArea.createEl("h4", { text: t('WHISPERER_HEADER') });
        
        this.whispererContainer = contentArea.createEl("div", { cls: "semantix-whisperer-results" });
        this.whispererContainer.style.transition = "opacity 150ms ease";
        this.whispererResultsEl = this.whispererContainer.createEl("div", { cls: "semantix-whisperer-results-inner" });
        this.whispererResultsEl.createEl("p", { 
            text: t('WAITING_INPUT'), 
            cls: "semantix-empty-text" 
        });

        this.updateIndexingProgress(this.plugin.getIndexingState());
        // 强制同步插件当前的连接状态，避免显示默认的 "Connecting..."
        this.updateStatus(this.plugin.getConnectionStatus());
    }

    async onClose() {
        // 清理
    }

    /**
     * 渲染 Whisperer 的检索结果
     */
    public renderWhispererResults(results: SearchResultItem[], queryText?: string, colorSettings?: { colorThresholdHigh: number; colorThresholdMedium: number }) {
        if (!this.whispererContainer || !this.whispererResultsEl) return;
        this.clearLoading();
        this.whispererResultsEl.empty();

        if (results.length === 0) {
            this.whispererResultsEl.createEl("p", { 
                text: t('NO_RESULTS'), 
                cls: "semantix-empty-text" 
            });
            return;
        }

        const defaultSettings = {
            colorThresholdHigh: this.plugin.settings.colorThresholdHigh || 0.85,
            colorThresholdMedium: this.plugin.settings.colorThresholdMedium || 0.75
        };
        const settings = colorSettings || defaultSettings;

        const listEl = this.whispererResultsEl.createEl("ul", { cls: "semantix-result-list" });

        for (const item of results) {
            const li = listEl.createEl("li", { cls: "semantix-result-item" });
            
            // 结果悬浮提示：显示详细对比
            if (queryText) {
                li.title = this.getComparisonTooltip(queryText, item.snippet);
            }
            
            // 左侧：链接 + 摘要
            const leftDiv = li.createEl("div", { cls: "semantix-result-content" });
            
            const link = leftDiv.createEl("a", { 
                text: this.getBasename(item.path), 
                cls: "semantix-result-link" 
            });
            link.href = "#";
            link.addEventListener("click", (e) => {
                e.preventDefault();
                this.plugin.app.workspace.openLinkText(item.path, "", false);
            });
            
            const snippetEl = leftDiv.createEl("div", { cls: "semantix-result-snippet" });
            
            // 高亮关键词
            if (queryText) {
                this.renderHighlightedSnippet(snippetEl, item.snippet, queryText);
            } else {
                snippetEl.setText(item.snippet);
            }
            
            // 右侧：相似度分数标签
            const scoreEl = li.createEl("span", { 
                text: item.score.toFixed(2),
                cls: "semantix-score-badge"
            });
            scoreEl.style.color = this.getScoreColor(item.score, settings.colorThresholdHigh, settings.colorThresholdMedium);
            
            // 悬浮提示解耦：分数 Badge 显示打分明细和理由
            scoreEl.title = this.getDetailedScoreTooltip(item);
        }
    }

    /**
     * 生成打分构成的详细悬浮提示
     */
    private getDetailedScoreTooltip(item: SearchResultItem): string {
        const lines: string[] = [];
        
        // 1. 总体评价
        lines.push(this.getScoreSummaryText(item.score));
        lines.push("----------------");

        // 2. 得分构成
        lines.push(t('SCORE_BREAKDOWN_TITLE'));
        
        if (item.score_details) {
            const details = item.score_details;
            // 核心语义分
            if (details.semantic !== undefined) {
                lines.push(`${t('SCORE_SEMANTIC')}: ${details.semantic.toFixed(2)}`);
            } else if (details.base_semantic !== undefined) {
                lines.push(`${t('SCORE_SEMANTIC')}: ${details.base_semantic.toFixed(2)}`);
            }

            // 额外加分项
            const bonuses: string[] = [];
            if (details.path_bonus) bonuses.push(`${t('REASON_SAME_FOLDER') || t('REASON_RELATED_FOLDER')}: +${details.path_bonus.toFixed(2)}`);
            if (details.tag_bonus) bonuses.push(`${t('REASON_SHARE_TAGS')}: +${details.tag_bonus.toFixed(2)}`);
            if (details.link_bonus) bonuses.push(`${t('REASON_LINKED')}: +${details.link_bonus.toFixed(2)}`);
            if (details.density_bonus) bonuses.push(`${t('REASON_HIGH_DENSITY')}: +${details.density_bonus.toFixed(2)}`);

            if (bonuses.length > 0) {
                // lines.push(""); // 间隔
                bonuses.forEach(b => lines.push(b));
            }
        }

        return lines.join("\n");
    }

    private getScoreSummaryText(score: number): string {
        const h = this.plugin.settings.colorThresholdHigh || 0.85;
        const m = this.plugin.settings.colorThresholdMedium || 0.75;
        if (score >= h) return t('SCORE_HIGH');
        if (score >= m) return t('SCORE_MED');
        return t('SCORE_LOW');
    }

    private getComparisonTooltip(queryText: string, snippet: string): string {
        const queryPreview = queryText.length > 50 ? queryText.slice(0, 50) + "..." : queryText;
        const snippetPreview = snippet.length > 80 ? snippet.slice(0, 80) + "..." : snippet;
        return `${t('COMPARE_QUERY')}${queryPreview}\n\n${t('COMPARE_MATCH')}${snippetPreview}`;
    }

    private renderHighlightedSnippet(container: HTMLElement, snippet: string, queryText: string) {
        const keywords = this.extractKeywords(queryText);
        if (keywords.length === 0) {
            container.setText(this.truncateText(snippet, 80));
            return;
        }

        const focusedSnippet = this.focusOnKeyword(snippet, keywords, 80);
        const regex = new RegExp(`(${keywords.map(k => this.escapeRegex(k)).join('|')})`, 'gi');
        const parts = focusedSnippet.split(regex);

        for (const part of parts) {
            const isKeyword = keywords.some(k => part.toLowerCase() === k.toLowerCase());
            if (isKeyword) {
                const mark = container.createEl("mark");
                mark.setText(part);
                mark.style.backgroundColor = "var(--text-highlight-bg, #ffff00)";
                mark.style.color = "var(--text-highlight-fg, inherit)";
                mark.style.padding = "0 2px";
                mark.style.borderRadius = "2px";
            } else {
                container.appendChild(document.createTextNode(part));
            }
        }
    }

    private focusOnKeyword(text: string, keywords: string[], maxLen: number): string {
        const lowerText = text.toLowerCase();
        let firstMatchIndex = -1;
        
        for (const keyword of keywords) {
            const idx = lowerText.indexOf(keyword.toLowerCase());
            if (idx !== -1) {
                if (firstMatchIndex === -1 || idx < firstMatchIndex) {
                    firstMatchIndex = idx;
                }
            }
        }
        
        if (firstMatchIndex === -1) {
            return this.truncateText(text, maxLen);
        }
        
        const halfLen = Math.floor(maxLen / 2);
        let start = Math.max(0, firstMatchIndex - halfLen);
        const end = Math.min(text.length, start + maxLen);
        
        if (end === text.length) {
            start = Math.max(0, end - maxLen);
        }
        
        let result = text.slice(start, end);
        
        if (start > 0) {
            result = "..." + result;
        }
        if (end < text.length) {
            result = result + "...";
        }
        
        return result;
    }

    private truncateText(text: string, maxLen: number): string {
        if (text.length <= maxLen) return text;
        return text.slice(0, maxLen) + "...";
    }

    private extractKeywords(text: string): string[] {
        if (!text) return [];
        
        // 1. 扩充后的权威停用词列表 (涵盖常见虚词、代词、副词、连词等)
        const stopWords = new Set([
            // 基础虚词
            '的', '了', '在', '是', '和', '与', '或', '也', '都', '就', '不', '有', '这', '那',
            '我', '你', '他', '她', '它', '们', '个', '上', '下', '中', '来', '去', '到', '说',
            '要', '会', '能', '对', '着', '过', '从', '把', '给', '向', '而', '但', '如', '所',
            '以', '为', '于', '之', '其', '者', '等', '时', '地', '得', '啊', '吗', '呢', '吧', 
            '呀', '哦', '哈', '嗯', '哎', '唉', '且', '并', '若', '况', '非', '莫', '既', '且',
            // 常见功能词
            '怎么', '如何', '什么', '为什么', '哪里', '什么时候', '这样', '那样', '哪个', '哪些',
            '觉得', '认为', '就是', '其实', '大概', '可能', '虽然', '但是', '如果', '由于', '因此',
            '所以', '因为', '既然', '以此', '不仅', '而且', '此外', '或者', '否则', '还是', '甚至',
            '以及', '至于', '关于', '对于', '所谓', '比如', '例如', '总之', '最后', '首先', '其次',
            '已经', '曾经', '正在', '即将', '刚刚', '一直', '总是', '经常', '偶尔', '非常', '相当',
            '及其', '更加', '比较', '稍微', '几乎', '所有', '整个', '一切', '各种', '各个', '部分',
            '一些', '一点', '有些', '好多', '若干', '很多', '只有', '只有', '只要', '只要', '无论',
            '不管', '即使', '即便', '哪怕', '既然', '反正', '总之', '甚至', '还有', '并且', '而且',
        ]);

        // 1.1 合并来自后端的仓库自适应停用词 (如果开启了该功能)
        if (this.plugin.settings.enableAdaptiveFiltering && this.plugin.vaultStopwords.length > 0) {
            for (const word of this.plugin.vaultStopwords) {
                stopWords.add(word.toLowerCase());
            }
        }

        const keywords: Set<string> = new Set();
        
        // 2. 利用原生 Intl.Segmenter 进行语言感知分词 (Obsidain/Electron 内置)
        try {
            const segmenter = new (Intl as any).Segmenter('zh', { granularity: 'word' });
            const segments = segmenter.segment(text);
            
            for (const { segment, isWordLike } of segments) {
                if (!isWordLike) continue; // 忽略标点符号和空格
                
                const lower = segment.toLowerCase().trim();
                
                // 3. 过滤逻辑
                // - 必须在停用词表外
                // - 长度 >= 2 (除非是纯英文单词/缩写)
                // - 不是纯数字
                if (stopWords.has(lower)) continue;
                if (/^\d+$/.test(lower)) continue;
                
                const isAlpha = /^[a-zA-Z]+$/.test(lower);
                if (!isAlpha && lower.length < 2) continue;
                if (isAlpha && lower.length < 3 && !['ai', 'ml', 'ds', 'py', 'go'].includes(lower)) continue;
                
                keywords.add(lower);
            }
        } catch (e) {
            // 降级方案：正则粗略切分 (主要防备极旧版本或不支持该 API 的环境)
            const words = text.match(/[\u4e00-\u9fa5]{2,}|[a-zA-Z]{3,}/g) || [];
            for (const word of words) {
                const lower = word.toLowerCase();
                if (!stopWords.has(lower)) keywords.add(lower);
            }
        }
        
        const result = Array.from(keywords);
        // 按长度降序排列，优先匹配长词进行高亮
        result.sort((a, b) => b.length - a.length);
        
        return result.slice(0, 10);
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private getScoreColor(score: number, thresholdHigh: number, thresholdMedium: number): string {
        if (score >= thresholdHigh) {
            return "var(--color-green)";
        }
        if (score >= thresholdMedium) {
            return "var(--color-blue)";
        }
        return "var(--color-yellow)";
    }

    private getBasename(path: string): string {
        const parts = path.split('/');
        const name = parts.length > 0 ? parts[parts.length - 1] : '';
        return (name || '').replace(/\.md$/, '');
    }

    /**
     * 更新状态指示灯
     */
    public updateStatus(status: 'connected' | 'disconnected' | 'syncing' | 'disabled') {
        if (!this.indicatorEl || !this.statusTextEl) return;

        this.indicatorEl.classList.remove('is-connected', 'is-disconnected', 'is-syncing', 'is-disabled');

        if (status === 'connected') {
            this.indicatorEl.classList.add('is-connected');
            this.statusTextEl.innerText = t('STATUS_CONNECTED');
        } else if (status === 'disconnected') {
            this.indicatorEl.classList.add('is-disconnected');
            this.statusTextEl.innerText = t('STATUS_DISCONNECTED');
        } else if (status === 'syncing') {
            this.indicatorEl.classList.add('is-syncing');
            this.statusTextEl.innerText = t('TESTING');
        } else if (status === 'disabled') {
            this.indicatorEl.classList.add('is-disabled');
            this.statusTextEl.innerText = t('STATUS_DISABLED');
        }
    }

    public updateIndexStatus(totalNotes: number, lastUpdated?: string) {
        if (!this.indexStatusEl) return;
        this.indexStatusEl.innerText = `${t('INDEXED_COUNT')}${totalNotes}`;
        if (this.indexTimestampEl) {
            if (lastUpdated) {
                this.indexTimestampEl.innerText = `${t('LAST_UPDATE')}${lastUpdated}`;
                this.indexTimestampEl.style.display = "block";
            } else {
                this.indexTimestampEl.innerText = "";
                this.indexTimestampEl.style.display = "none";
            }
        }
    }

    public showLoading() {
        if (!this.whispererContainer) return;
        this.whispererContainer.style.opacity = "0.6";
        if (this.loadingEl) return;

        const loading = this.whispererContainer.createEl("div", { cls: "semantix-loading" });
        loading.style.marginTop = "8px";

        for (let i = 0; i < 2; i += 1) {
            const card = loading.createEl("div", { cls: "semantix-loading-card" });
            card.createEl("div", { cls: "semantix-skeleton-title" });
            card.createEl("div", { cls: "semantix-skeleton-text" });
        }

        this.loadingEl = loading;
    }

    public clearLoading() {
        if (!this.whispererContainer) return;
        if (this.loadingEl) {
            this.loadingEl.remove();
            this.loadingEl = null;
        }
        this.whispererContainer.style.opacity = "1";
    }

    public updateIndexingProgress(state: { active: boolean; current: number; total: number }) {
        if (!this.indexProgressTextEl || !this.indexProgressBarEl || !this.indexProgressRowEl) return;

        const total = Math.max(state.total, 0);
        const current = Math.max(state.current, 0);

        if (state.active && total > 0) {
            this.indexProgressRowEl.style.display = "flex";
            const percent = Math.min(100, Math.round((current / total) * 100));
            this.indexProgressTextEl.innerText = `${t('INDEXING_PROGRESS')}${current} / ${total}`;
            this.indexProgressBarEl.style.width = `${percent}%`;
            this.indexProgressBarEl.style.background = "var(--interactive-accent)";
        } else {
            this.indexProgressRowEl.style.display = "none";
            this.indexProgressTextEl.innerText = "Indexing: 0 / 0";
            this.indexProgressBarEl.style.width = "0%";
            this.indexProgressBarEl.style.background = "var(--text-faint)";
        }
    }
}
