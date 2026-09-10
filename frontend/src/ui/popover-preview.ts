import { RadarCardItem } from '../api/types';

function applyStyles(element: HTMLElement, styles: Record<string, string>) {
    for (const [prop, val] of Object.entries(styles)) {
        element.style.setProperty(prop, val);
    }
}

export class PopoverPreview {
    private popoverEl: HTMLElement | null = null;
    private hideTimer: number | null = null;
    private currentTargetEl: HTMLElement | null = null;
    private onInsertLinkCallback?: (item: RadarCardItem) => void;
    private onOpenNoteCallback?: (item: RadarCardItem) => void;

    constructor() {
        this.createPopoverElement();
    }

    private createPopoverElement() {
        if (this.popoverEl) return;
        this.popoverEl = document.body.createEl("div", { cls: "semantix-popover-preview is-hidden" });

        // 鼠标移入 Popover 本身时取消隐藏
        this.popoverEl.addEventListener("mouseenter", () => {
            this.cancelHide();
        });
        this.popoverEl.addEventListener("mouseleave", () => {
            this.scheduleHide();
        });
    }

    public setCallbacks(
        onInsertLink: (item: RadarCardItem) => void,
        onOpenNote: (item: RadarCardItem) => void
    ) {
        this.onInsertLinkCallback = onInsertLink;
        this.onOpenNoteCallback = onOpenNote;
    }

    public show(targetEl: HTMLElement, item: RadarCardItem) {
        this.cancelHide();
        if (!this.popoverEl) this.createPopoverElement();
        if (!this.popoverEl) return;

        this.currentTargetEl = targetEl;
        this.popoverEl.empty();

        // 1. 顶部操作栏与标题
        const header = this.popoverEl.createEl("div", { cls: "semantix-popover-header" });
        header.createEl("span", { cls: "semantix-popover-title", text: item.title });

        const actions = header.createEl("div", { cls: "semantix-popover-actions" });
        const insertBtn = actions.createEl("button", {
            cls: "semantix-popover-btn",
            text: "🔗 插入链接"
        });
        insertBtn.addEventListener("click", (e: MouseEvent) => {
            e.stopPropagation();
            this.hide();
            if (this.onInsertLinkCallback) this.onInsertLinkCallback(item);
        });

        const openBtn = actions.createEl("button", {
            cls: "semantix-popover-btn mod-cta",
            text: "查看全文"
        });
        openBtn.addEventListener("click", (e: MouseEvent) => {
            e.stopPropagation();
            this.hide();
            if (this.onOpenNoteCallback) this.onOpenNoteCallback(item);
        });

        // 2. 完整父块上下文内容
        const body = this.popoverEl.createEl("div", { cls: "semantix-popover-body" });
        body.createEl("p", { text: item.snippet, cls: "semantix-popover-text" });

        // 3. 标签行
        if (item.labels && item.labels.length > 0) {
            const footer = this.popoverEl.createEl("div", { cls: "semantix-popover-footer" });
            for (const lbl of item.labels) {
                footer.createEl("span", { cls: "semantix-badge", text: lbl });
            }
        }

        // 4. 定位计算：显示在侧边栏卡片的左侧（若是右侧边栏）或合适方位
        const rect = targetEl.getBoundingClientRect();
        this.popoverEl.removeClass("is-hidden");
        this.popoverEl.addClass("is-visible");

        const popoverWidth = 320;
        let left = rect.left - popoverWidth - 10;
        if (left < 10) {
            left = rect.right + 10;
        }

        let top = rect.top;
        if (top + 200 > window.innerHeight) {
            top = Math.max(10, window.innerHeight - 220);
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
        this.cancelHide();
        if (this.popoverEl) {
            this.popoverEl.removeClass("is-visible");
            this.popoverEl.addClass("is-hidden");
        }
        this.currentTargetEl = null;
    }

    public destroy() {
        this.hide();
        if (this.popoverEl) {
            this.popoverEl.remove();
            this.popoverEl = null;
        }
    }
}
