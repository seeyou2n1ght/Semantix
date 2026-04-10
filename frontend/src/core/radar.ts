import { TFile } from 'obsidian';
import SemantixPlugin from '../main';
import { RADAR_VIEW_TYPE, RadarView } from '../ui/radar-view';
import { SearchResultItem } from '../api/types';
import { cleanMarkdown } from '../utils/markdown';

export interface OrphanNode {
    file: TFile;
    linkCount: number;
}

export class OrphanRadar {
    plugin: SemantixPlugin;

    constructor(plugin: SemantixPlugin) {
        this.plugin = plugin;
    }

    /**
     * 发现所有孤岛笔记
     */
    public findOrphans(): OrphanNode[] {
        const orphans: OrphanNode[] = [];
        const files = this.plugin.app.vault.getMarkdownFiles();
        
        const resolvedLinks = this.plugin.app.metadataCache.resolvedLinks;
        
        // 统计入度
        const backlinkCount: Record<string, number> = {};
        for (const sourcePath in resolvedLinks) {
            const targets = resolvedLinks[sourcePath];
            for (const targetPath in targets) {
                const incomingAmt = targets[targetPath] || 0;
                backlinkCount[targetPath] = (backlinkCount[targetPath] || 0) + incomingAmt;
            }
        }

        for (const file of files) {
            if (this.plugin.syncManager.isExcludedPath(file.path)) continue;

            // 出度
            const outgoingLinks = resolvedLinks[file.path];
            const outgoing = outgoingLinks ? Object.keys(outgoingLinks).length : 0;
            // 入度
            const incoming = backlinkCount[file.path] || 0;

            const totalLinks = outgoing + incoming;
            
            // 孤岛阈值：完全无链接
            if (totalLinks === 0) {
                orphans.push({ file, linkCount: totalLinks });
            }
        }

        return orphans;
    }

    /**
     * 针对某篇孤岛笔记获取推荐结果
     * P1 优化：注入文件名、Tags、路径等上下文以增强推荐准确度
     */
    public async getRecommendationsForOrphan(file: TFile): Promise<SearchResultItem[]> {
        const rawText = await this.plugin.app.vault.cachedRead(file);
        const cleaned = cleanMarkdown(rawText);
        
        // 获取元数据增强上下文
        const cache = this.plugin.app.metadataCache.getFileCache(file);
        const tags = cache?.tags?.map(t => t.tag) || [];
        const frontmatterTags = cache?.frontmatter?.tags;
        if (frontmatterTags) {
            if (Array.isArray(frontmatterTags)) {
                tags.push(...frontmatterTags);
            } else if (typeof frontmatterTags === 'string') {
                tags.push(...frontmatterTags.split(',').map(t => t.trim()));
            }
        }
        
        const uniqueTags = [...new Set(tags)];
        const folder = file.parent?.path && file.parent.path !== '/' ? `目录: ${file.parent.path}\n` : '';
        const tagStr = uniqueTags.length > 0 ? `标签: ${uniqueTags.join(' ')}\n` : '';
        const titleStr = `标题: ${file.basename}\n`;
        
        // 组装增强型的查询文本
        const enrichedQuery = `${titleStr}${folder}${tagStr}${cleaned}`;
        
        if (cleaned.length < 5 && uniqueTags.length === 0) {
            const titleOnly = cleanMarkdown(file.basename);
            return await this.fetchSearch(titleOnly, [file.path]);
        }
        
        return await this.fetchSearch(enrichedQuery, [file.path]);
    }

    private async fetchSearch(query: string, excludes: string[]): Promise<SearchResultItem[]> {
        const response = await this.plugin.apiClient.semanticSearch({
            vault_id: this.plugin.vaultId,
            text: query,
            top_k: this.plugin.settings.topNResults,
            exclude_paths: excludes,
            with_context: this.plugin.settings.enableExplainableResults,
            rerank: this.plugin.settings.enableReranking
        });
        
        return response ? response.results : [];
    }

    /**
     * 主动触发扫描并更新 RadarView
     */
    public async scanAndRender() {
        if (this.plugin.getConnectionStatus() !== 'connected') {
            return;
        }

        const leaves = this.plugin.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE);
        if (leaves.length > 0) {
            const leaf = leaves[0];
            if (leaf && leaf.view instanceof RadarView) {
                (leaf.view as RadarView).showLoading();
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        const orphans = this.findOrphans();
        
        if (leaves.length > 0) {
            const leaf = leaves[0];
            if (leaf && leaf.view instanceof RadarView) {
                (leaf.view as RadarView).renderOrphans(orphans);
            }
        }
    }
}
