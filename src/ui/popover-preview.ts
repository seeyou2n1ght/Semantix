import { App, TFile, Keymap } from 'obsidian';
import { RadarCardItem } from '../api/types';
import { t } from '../i18n/helpers';

function applyStyles(element: HTMLElement, styles: Record<string, string>) {
    for (const [prop, val] of Object.entries(styles)) {
        element.style.setProperty(prop, val);
    }
}

export class PopoverPreview {
    private popoverEl: HTMLElement | null = null;
    private hideTimer: number | null = null;
    private showTimer: number | null = null;
    private currentTargetEl: HTMLElement | null = null;
    private onOpenNoteCallback?: (item: RadarCardItem, event?: MouseEvent) => void;

    constructor() {
        this.createPopoverElement();
    }

    private createPopoverElement() {
        if (this.popoverEl) return;
        this.popoverEl = document.body.createDiv({ cls: "semantix-popover-preview is-hidden" });

        // 鼠标移入 Popover 本身时取消隐藏
        this.popoverEl.addEventListener("mouseenter", () => {
            this.cancelHide();
        });
        this.popoverEl.addEventListener("mouseleave", () => {
            this.scheduleHide();
        });
    }

    public setCallbacks(
        _onInsertLink: (item: RadarCardItem) => void,
        onOpenNote: (item: RadarCardItem, event?: MouseEvent) => void
    ) {
        this.onOpenNoteCallback = onOpenNote;
    }

    public scheduleShow(targetEl: HTMLElement, item: RadarCardItem, app?: App, delayMs: number = 200) {
        this.cancelShow();
        this.cancelHide();
        this.showTimer = window.setTimeout(() => {
            this.show(targetEl, item, app);
        }, delayMs);
    }

    public cancelShow() {
        if (this.showTimer !== null) {
            window.clearTimeout(this.showTimer);
            this.showTimer = null;
        }
    }

    public show(targetEl: HTMLElement, item: RadarCardItem, app?: App) {
        this.cancelShow();
        this.cancelHide();
        if (!this.popoverEl) this.createPopoverElement();
        if (!this.popoverEl) return;

        this.currentTargetEl = targetEl;
        this.popoverEl.empty();

        // 1. 顶部标题栏与定位层级
        const header = this.popoverEl.createDiv({ cls: "semantix-popover-header" });

        const titleRow = header.createDiv({ cls: "semantix-popover-title-row" });
        const cleanTitle = item.title ? item.title.replace(/\.md$/i, '') : item.path.split('/').pop()?.replace(/\.md$/i, '') || '';
        
        const titleLeft = titleRow.createDiv({ cls: "semantix-popover-title-group" });
        titleLeft.createSpan({ cls: "semantix-popover-icon", text: "📄" });
        titleLeft.createSpan({ cls: "semantix-popover-title", text: cleanTitle });
        const headingEl = titleLeft.createSpan({ cls: "semantix-popover-heading", text: "" });

        // 红绿灯分数徽标
        if (typeof item.score === 'number' && !isNaN(item.score)) {
            const scoreVal = (Math.round(item.score * 100) / 100).toFixed(2);
            let tierText = "●●○";
            let tierCls = "mid";
            if (item.score >= 0.75) {
                tierText = "●●●";
                tierCls = "high";
            } else if (item.score < 0.50) {
                tierText = "●○○";
                tierCls = "low";
            }
            titleRow.createSpan({ 
                cls: `semantix-card-score mod-${tierCls} semantix-popover-score-badge`, 
                text: `${tierText} ${scoreVal}`,
                attr: { "title": `${t('POPOVER_MATCH')}: ${scoreVal}` }
            });
        }

        // 文件物理路径
        if (item.path) {
            const metaBar = header.createDiv({ cls: "semantix-popover-meta" });
            const pathEl = metaBar.createSpan({ cls: "semantix-popover-path", text: `📁 ${item.path}` });
            pathEl.setAttribute("title", t('CARD_CLICK_OPEN'));
            pathEl.addEventListener("mouseover", (e: MouseEvent) => {
                if (Keymap.isModifier(e, 'Mod') && app) {
                    this.hide();
                    app.workspace.trigger('hover-link', {
                        event: e,
                        source: 'semantix',
                        hoverParent: targetEl,
                        targetEl: pathEl,
                        linktext: item.path,
                    });
                }
            });
        }

        // 2. 完整段落上下文内容阅读区 (异步扩展，支持滚动)
        const body = this.popoverEl.createDiv({ cls: "semantix-popover-body" });
        const textEl = body.createEl("p", { text: item.snippet, cls: "semantix-popover-text" });

        if (app && item.path) {
            const file = app.vault.getAbstractFileByPath(item.path);
            if (file instanceof TFile) {
                app.vault.cachedRead(file).then((rawText) => {
                    if (!this.popoverEl || !this.popoverEl.contains(textEl)) return;
                    const cleanSnip = item.snippet.replace(/^\.\.\.|\.\.\.$/g, '').trim();
                    if (!cleanSnip || cleanSnip.length < 5) return;
                    
                    // 查找段落及对应的小节 Heading
                    const lines = rawText.split('\n');
                    let currentHeading = "";
                    let matchedHeading = "";
                    for (const line of lines) {
                        const hMatch = line.match(/^#{1,6}\s+(.+)$/);
                        if (hMatch && hMatch[1]) {
                            currentHeading = hMatch[1].trim();
                        }
                        if (line.includes(cleanSnip.slice(0, 20))) {
                            matchedHeading = currentHeading;
                            break;
                        }
                    }

                    if (matchedHeading && headingEl) {
                        headingEl.setText(` › ## ${matchedHeading}`);
                    }

                    // 提取完整父级段落
                    const anchor = cleanSnip.slice(0, 30);
                    const paragraphs = rawText.split(/\n\s*\n/);
                    for (const para of paragraphs) {
                        const cleanPara = para.replace(/[#*`_~>[\]]/g, ' ').replace(/\s+/g, ' ').trim();
                        if (cleanPara.includes(anchor) || para.includes(cleanSnip.slice(0, 20))) {
                            const trimmed = para.trim();
                            if (trimmed.length > item.snippet.length) {
                                textEl.setText(trimmed);
                            }
                            break;
                        }
                    }
                }).catch(() => {
                    // ignore
                });
            }
        }

        // 4. 底部微提示 (不设按钮，仅提供纯粹操作指引)
        this.popoverEl.createDiv({ 
            cls: "semantix-popover-footer-hint",
            text: t('POPOVER_CLICK_HINT')
        });

        // 统一点击处理：支持普通点击在当前窗口打开，Shift+点击在新标签页打开
        this.popoverEl.onclick = (e: MouseEvent) => {
            this.hide();
            if (this.onOpenNoteCallback) {
                this.onOpenNoteCallback(item, e);
            }
        };
        this.popoverEl.onauxclick = (e: MouseEvent) => {
            if (e.button === 1) {
                this.hide();
                if (this.onOpenNoteCallback) {
                    this.onOpenNoteCallback(item, e);
                }
            }
        };

        // 5. 定位计算：显示在侧边栏卡片的左侧（若是右侧边栏）或合适方位
        const rect = targetEl.getBoundingClientRect();
        this.popoverEl.removeClass("is-hidden");
        this.popoverEl.addClass("is-visible");

        const popoverWidth = 360;
        let left = rect.left - popoverWidth - 10;
        if (left < 10) {
            left = rect.right + 10;
        }

        let top = rect.top;
        if (top + 280 > window.innerHeight) {
            top = Math.max(10, window.innerHeight - 300);
        }

        applyStyles(this.popoverEl, {
            left: `${Math.max(10, left)}px`,
            top: `${Math.max(10, top)}px`,
        });
    }

    public scheduleHide(delayMs: number = 200) {
        this.cancelHide();
        this.hideTimer = window.setTimeout(() => {
            this.hide();
        }, delayMs);
    }

    public cancelHide() {
        if (this.hideTimer !== null) {
            window.clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
    }

    public hide() {
        this.cancelShow();
        this.cancelHide();
        if (this.popoverEl) {
            this.popoverEl.removeClass("is-visible");
            this.popoverEl.addClass("is-hidden");
        }
        this.currentTargetEl = null;
    }

    public destroy() {
        this.cancelShow();
        this.cancelHide();
        if (this.popoverEl) {
            this.popoverEl.remove();
            this.popoverEl = null;
        }
    }
}
