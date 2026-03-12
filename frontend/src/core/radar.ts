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
     */
    public async getRecommendationsForOrphan(file: TFile): Promise<SearchResultItem[]> {
        const rawText = await this.plugin.app.vault.cachedRead(file);
        const cleaned = cleanMarkdown(rawText);
        
        if (cleaned.length < 5) {
            const titleCleared = cleanMarkdown(file.basename);
            return await this.fetchSearch(titleCleared, [file.path]);
        }
        return await this.fetchSearch(cleaned, [file.path]);
    }

    private async fetchSearch(query: string, excludes: string[]): Promise<SearchResultItem[]> {
        const response = await this.plugin.apiClient.semanticSearch({
            vault_id: this.plugin.vaultId,
            text: query,
            top_k: this.plugin.settings.topNResults,
            exclude_paths: excludes
        });
        
        return response ? response.results : [];
    }

    /**
     * 主动触发扫描并更新 RadarView
     */
    public scanAndRender() {
        const orphans = this.findOrphans();
        
        const leaves = this.plugin.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE);
        if (leaves.length > 0) {
            const leaf = leaves[0];
            if (leaf && leaf.view instanceof RadarView) {
                (leaf.view as RadarView).renderOrphans(orphans);
            }
        }
    }
}
