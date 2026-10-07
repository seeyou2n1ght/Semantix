import { Editor, MarkdownView, TFile, debounce } from 'obsidian';
import { ViewPlugin, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import SemantixPlugin from '../main';
import { RADAR_VIEW_TYPE, RadarView } from '../ui/radar-view';
import { ContextEngine, ContextSnapshot } from './context';
import { QueryChangeGate } from './query-gate';
import { ResultStabilizer } from './result-stabilizer';
import { mergeNoteResults, splitNoteQueries } from './note-scan';

import { RadarCardItem, RadarSearchRequest, RadarSearchResponse } from '../api/types';

export class RadarEngine {
    plugin: SemantixPlugin;
    private contextEngine: ContextEngine;
    private queryGate: QueryChangeGate;
    private stabilizer: ResultStabilizer;

    private currentSearchId: number = 0;
    private activeSearch: { id: number; scope: string | undefined } | null = null;
    private requestInFlight: Promise<RadarSearchResponse | null> | null = null;
    private cursorActivityTimer: number | null = null;
    public debouncedSearch: () => void;

    constructor(plugin: SemantixPlugin) {
        this.plugin = plugin;
        this.contextEngine = new ContextEngine();
        this.queryGate = new QueryChangeGate();
        this.stabilizer = new ResultStabilizer();
        this.setupDebounce();
    }

    public setupDebounce() {
        const delay = this.plugin.settings.debounceDelay || 400;
        this.debouncedSearch = debounce(
            this.handleFocusTrigger.bind(this),
            delay,
            false
        );
    }

    public getCursorActivityExtension(): Extension {
        const onCursorActivity = () => this.onCursorActivity();
        return ViewPlugin.fromClass(class {
            update(update: ViewUpdate) {
                if (update.selectionSet) {
                    onCursorActivity();
                }
            }
        });
    }

    private getCurrentMarkdownView(): MarkdownView | null {
        const workspace = this.plugin.app.workspace;
        const active = workspace.getActiveViewOfType(MarkdownView);
        if (active?.file) return active;
        const file = workspace.getActiveFile();
        if (!file) return null;
        const leaf = workspace.getLeavesOfType('markdown')
            .find(candidate => candidate.view instanceof MarkdownView && candidate.view.file?.path === file.path);
        return leaf?.view instanceof MarkdownView ? leaf.view : null;
    }

    public onFileOpen(file: TFile | null): void {
        // 同步失效当前在途请求并清理状态
        this.currentSearchId++;
        this.activeSearch = null;
        this.clearLoading();
        this.queryGate.reset();
        this.contextEngine.reset();
        this.stabilizer.resetAll();
        const radarLeaf = this.plugin.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE)[0];
        if (radarLeaf?.view instanceof RadarView) radarLeaf.view.resetForContext();

        if (!file || file.extension !== 'md') {
            return;
        }

        // 切换笔记时让渡微任务与渲染帧，确保 Obsidian 核心完成编辑器挂载与焦点初始化
        window.setTimeout(() => {
            const activeView = this.getCurrentMarkdownView();
            if (activeView && activeView.file && activeView.file.path === file.path) {
                void this.handleFocusTrigger(true);
            }
        }, 120);
    }

    private invalidateActiveSearch(): void {
        if (!this.activeSearch) return;
        const wasNoteScan = this.activeSearch.scope === 'note';
        this.currentSearchId++;
        this.activeSearch = null;
        // The gate previously admitted a request that can no longer be displayed.
        this.queryGate.reset();
        this.clearLoading();
        if (wasNoteScan) {
            const leaf = this.plugin.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE)[0];
            if (leaf?.view instanceof RadarView) leaf.view.showScanCancelled();
        }
    }

    public onEditorChange(_editor: Editor, view: MarkdownView): void {
        if (view !== this.getCurrentMarkdownView()) return;
        this.invalidateActiveSearch();
        this.debouncedSearch();
    }

    public onCursorActivity(): void {
        const view = this.getCurrentMarkdownView();
        if (!view || !view.file) return;
        // Moving the cursor does not change the text of an explicit whole-note scan.
        if (this.activeSearch?.scope === 'note') return;
        this.invalidateActiveSearch();

        if (this.cursorActivityTimer !== null) {
            window.clearTimeout(this.cursorActivityTimer);
        }

        // 光标位移轻量 300ms 防抖
        this.cursorActivityTimer = window.setTimeout(() => {
            void this.handleFocusTrigger(false);
        }, 300);
    }

    /**
     * 核心触发逻辑：Focus 模式
     */
    private async handleFocusTrigger(isJump: boolean = false) {
        if (this.activeSearch?.scope === 'note') return;
        const view = this.getCurrentMarkdownView();
        if (!view || !view.file) return;

        const snapshot = this.contextEngine.captureFocusSnapshot(view.editor, view);
        if (!snapshot) return;

        const isContextJump = isJump || snapshot.transitionType !== 'SAME_PARAGRAPH';
        if (!isContextJump && this.plugin.settings.autoTrigger === false) {
            return;
        }
        const decision = this.queryGate.evaluate(snapshot.cleanedText, isContextJump);
        if (!decision.shouldTrigger) {
            return;
        }

        await this.executeRadarSearch(snapshot);
    }

    /**
     * 用户主动点击“扫描整篇” (Note Mode)
     */
    public async triggerNoteScan() {
        if (this.cursorActivityTimer !== null) {
            window.clearTimeout(this.cursorActivityTimer);
            this.cursorActivityTimer = null;
        }
        const view = this.getCurrentMarkdownView();
        if (!view || !view.file) return;

        const snapshot = this.contextEngine.captureNoteSnapshot(view);
        if (!snapshot) return;

        await this.executeRadarSearch(snapshot);
    }

    public cancelSearch(): void {
        this.invalidateActiveSearch();
        const leaf = this.plugin.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE)[0];
        if (leaf?.view instanceof RadarView) leaf.view.showScanCancelled();
    }

    private async requestLatest(request: RadarSearchRequest, searchId: number): Promise<RadarSearchResponse | null> {
        // requestUrl cannot cancel model inference. Keep one request in flight and
        // discard superseded waiters before they reach the engine.
        if (this.requestInFlight) {
            try { await this.requestInFlight; } catch { /* The owning search reports failure. */ }
        }
        if (searchId !== this.currentSearchId) return null;
        const pending = this.plugin.apiClient.radarSearch(request);
        this.requestInFlight = pending;
        try {
            return await pending;
        } finally {
            if (this.requestInFlight === pending) this.requestInFlight = null;
        }
    }

    /**
     * 用户主动快捷触发“扫描当前焦点 / 选区”
     */
    public async triggerFocusScan() {
        const view = this.getCurrentMarkdownView();
        if (!view || !view.file) return;

        const snapshot = this.contextEngine.captureFocusSnapshot(view.editor, view);
        if (!snapshot) return;

        await this.executeRadarSearch(snapshot);
    }

    /**
     * 发起 Radar 检索与稳定器渲染
     */
    private async executeRadarSearch(snapshot: ContextSnapshot) {
        const searchId = ++this.currentSearchId;
        this.activeSearch = null;
        if (this.plugin.getConnectionStatus() !== 'connected') {
            this.clearLoading();
            this.showSearchError(snapshot);
            return;
        }

        this.activeSearch = { id: searchId, scope: snapshot.context.scope };
        this.showLoading();

        let excludes: string[] = snapshot.context.path ? [snapshot.context.path] : [];
        if (this.plugin.settings.exclusionRules) {
            const extraExcludes = this.plugin.settings.exclusionRules
                .split('\n')
                .map(s => s.trim())
                .filter(Boolean);
            excludes = excludes.concat(extraExcludes);
        }

        try {
            const queries = snapshot.context.scope === 'note'
                ? splitNoteQueries(snapshot.cleanedText) : [snapshot.cleanedText];
            if (snapshot.context.scope === 'note') this.showNoteScanProgress(0, queries.length);
            const responses = [];
            for (const [index, query] of queries.entries()) {
                const contextId = queries.length === 1 ? snapshot.contextId : `${snapshot.contextId}#${index}`;
                const response = await this.requestLatest({
                    vault_id: this.plugin.vaultId,
                    context_id: contextId,
                    context: { ...snapshot.context, text: query },
                    top_k_related: this.plugin.settings.topNResults || 4,
                    top_k_discover: this.plugin.settings.topNResults || 4,
                    ranking_mode: this.plugin.settings.rankingMode || 'balanced',
                    exclude_paths: excludes,
                    enable_adaptive_filtering: this.plugin.settings.enableAdaptiveFiltering,
                    custom_stopwords: (this.plugin.settings.customStopwords || '').split(/[\s,，]+/).filter(Boolean),
                    mmr_lambda: this.plugin.settings.mmrLambda ?? 0.65
                }, searchId);
                if (searchId !== this.currentSearchId) return;
                if (!response) {
                    this.showSearchError(snapshot);
                    return;
                }
                if (response.context_id !== contextId) {
                    this.showSearchError(snapshot);
                    return;
                }
                responses.push(response);
                if (snapshot.context.scope === 'note') {
                    const currentView = this.getCurrentMarkdownView();
                    if (!currentView || currentView.file?.path !== snapshot.context.path
                        || this.contextEngine.captureNoteSnapshot(currentView)?.cleanedText !== snapshot.cleanedText) return;
                    if (index + 1 < queries.length) {
                        const partial = mergeNoteResults(responses, this.plugin.settings.topNResults || 4);
                        this.renderResults(partial.related, partial.discover, snapshot.context.path,
                            snapshot.context.heading, undefined, partial.warnings, true);
                    }
                    this.showNoteScanProgress(index + 1, queries.length);
                }
            }
            const response = responses.length === 1 ? responses[0]
                : { context_id: snapshot.contextId, ...mergeNoteResults(responses, this.plugin.settings.topNResults || 4) };

            // 丢弃陈旧请求结果，核验请求序列号与 context_id
            if (searchId !== this.currentSearchId) {
                return;
            }
            // 核验当前活动视图是否仍与请求上下文相符（若用户已切换文件则丢弃渲染）
            const activeView = this.getCurrentMarkdownView();
            if (!activeView?.file || activeView.file.path !== snapshot.context.path) {
                return;
            }
            if (snapshot.context.scope === 'note'
                && this.contextEngine.captureNoteSnapshot(activeView)?.cleanedText !== snapshot.cleanedText) {
                return;
            }

            if (response) {
                // Keep current cards in stable positions without retaining old evidence.
                const stabilized = this.stabilizer.stabilize(
                    response.related || [],
                    response.discover || [],
                    snapshot.transitionType
                );

                this.renderResults(
                    stabilized.related,
                    stabilized.discover,
                    snapshot.context.path,
                    snapshot.context.heading,
                    snapshot.context.scope === 'note' ? undefined : snapshot.cleanedText,
                    response.warnings
                );
            }
        } catch (e) {
            console.error("Radar search execution error:", e);
            if (searchId === this.currentSearchId) this.showSearchError(snapshot);
        } finally {
            if (searchId === this.currentSearchId) {
                this.activeSearch = null;
                this.clearLoading();
            }
        }
    }

    private showNoteScanProgress(current: number, total: number) {
        const leaf = this.plugin.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE)[0];
        if (leaf?.view instanceof RadarView) leaf.view.updateNoteScanProgress(current, total);
    }

    private showSearchError(snapshot: ContextSnapshot) {
        const activeView = this.getCurrentMarkdownView();
        if (activeView?.file?.path !== snapshot.context.path) return;
        const leaf = this.plugin.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE)[0];
        if (leaf?.view instanceof RadarView) {
            leaf.view.showSearchError(() => {
                void (async () => {
                    try {
                        await this.plugin.checkConnection({ silent: true });
                        if (snapshot.context.scope === 'note') await this.triggerNoteScan();
                        else await this.triggerFocusScan();
                    } catch (error) {
                        console.error('Semantix: Search retry failed.', error);
                        this.showSearchError(snapshot);
                    }
                })();
            });
        }
    }

    private renderResults(
        related: RadarCardItem[],
        discover: RadarCardItem[],
        contextPath?: string,
        contextHeading?: string,
        queryText?: string,
        warnings?: string[],
        partial = false
    ) {
        const leaves = this.plugin.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE);
        if (leaves.length === 0) return;
        const leaf = leaves[0];
        if (leaf && leaf.view instanceof RadarView) {
            leaf.view.renderRadarResults(
                related,
                discover,
                contextPath,
                contextHeading,
                queryText,
                warnings,
                partial
            );
        }
    }

    private showLoading() {
        const leaves = this.plugin.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE);
        if (leaves.length === 0) return;
        const leaf = leaves[0];
        if (leaf && leaf.view instanceof RadarView) {
            leaf.view.showLoading();
        }
    }

    private clearLoading() {
        const leaves = this.plugin.app.workspace.getLeavesOfType(RADAR_VIEW_TYPE);
        if (leaves.length === 0) return;
        const leaf = leaves[0];
        if (leaf && leaf.view instanceof RadarView) {
            leaf.view.clearLoading();
        }
    }
}
