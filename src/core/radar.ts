import { Editor, MarkdownView, TFile, debounce } from 'obsidian';
import { ViewPlugin, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import SemantixPlugin from '../main';
import { RADAR_VIEW_TYPE, RadarView } from '../ui/radar-view';
import { ContextEngine, ContextSnapshot } from './context';
import { QueryChangeGate } from './query-gate';
import { ResultStabilizer } from './result-stabilizer';

import { RadarCardItem } from '../api/types';

export class RadarEngine {
    plugin: SemantixPlugin;
    private contextEngine: ContextEngine;
    private queryGate: QueryChangeGate;
    private stabilizer: ResultStabilizer;

    private currentSearchId: number = 0;
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

    public onFileOpen(file: TFile | null): void {
        // 同步失效当前在途请求并清理状态
        this.currentSearchId++;
        this.clearLoading();
        this.queryGate.reset();
        this.contextEngine.reset();
        this.stabilizer.resetAll();

        if (!file || file.extension !== 'md') {
            this.renderResults([], [], undefined, undefined, undefined);
            return;
        }

        // 切换笔记时让渡微任务与渲染帧，确保 Obsidian 核心完成编辑器挂载与焦点初始化
        window.setTimeout(() => {
            const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView && activeView.file && activeView.file.path === file.path) {
                void this.handleFocusTrigger(true);
            }
        }, 120);
    }

    public onEditorChange(_editor: Editor, _view: MarkdownView): void {
        this.debouncedSearch();
    }

    public onCursorActivity(): void {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return;

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
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
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
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return;

        const snapshot = this.contextEngine.captureNoteSnapshot(view);
        if (!snapshot) return;

        await this.executeRadarSearch(snapshot);
    }

    /**
     * 用户主动快捷触发“扫描当前焦点 / 选区”
     */
    public async triggerFocusScan() {
        const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return;

        const snapshot = this.contextEngine.captureFocusSnapshot(view.editor, view);
        if (!snapshot) return;

        await this.executeRadarSearch(snapshot);
    }

    /**
     * 发起 Radar 检索与稳定器渲染
     */
    private async executeRadarSearch(snapshot: ContextSnapshot) {
        if (this.plugin.getConnectionStatus() !== 'connected') {
            return;
        }

        const searchId = ++this.currentSearchId;
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
            const response = await this.plugin.apiClient.radarSearch({
                vault_id: this.plugin.vaultId,
                context_id: snapshot.contextId,
                context: snapshot.context,
                top_k_related: this.plugin.settings.topNResults || 4,
                top_k_discover: this.plugin.settings.topNResults || 4,
                ranking_mode: this.plugin.settings.rankingMode || 'balanced',
                exclude_paths: excludes,
                mmr_lambda: this.plugin.settings.mmrLambda ?? 0.65
            });

            // 丢弃陈旧请求结果，核验请求序列号与 context_id
            if (searchId !== this.currentSearchId) {
                return;
            }
            if (!response || response.context_id !== snapshot.contextId) {
                return;
            }

            // 核验当前活动视图是否仍与请求上下文相符（若用户已切换文件则丢弃渲染）
            const activeView = this.plugin.app.workspace?.getActiveViewOfType?.(MarkdownView);
            if (activeView && activeView.file && activeView.file.path !== snapshot.context.path) {
                return;
            }

            if (response) {
                // 通过 ResultStabilizer 实现双 Policy 平滑替换与标签锁定
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
                    snapshot.cleanedText
                );
            }
        } catch (e) {
            console.error("Radar search execution error:", e);
        } finally {
            if (searchId === this.currentSearchId) {
                this.clearLoading();
            }
        }
    }

    private renderResults(
        related: RadarCardItem[],
        discover: RadarCardItem[],
        contextPath?: string,
        contextHeading?: string,
        queryText?: string
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
                queryText
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

export { RadarEngine as Whisperer };