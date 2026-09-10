export interface GateDecision {
    shouldTrigger: boolean;
    reason: 'PUNCTUATION_OR_WHITESPACE' | 'TOO_SHORT' | 'SIGNIFICANT_CHANGE' | 'PUNCTUATION_END' | 'MAX_WAIT_EXCEEDED' | 'NO_CHANGE';
}

export class QueryChangeGate {
    private lastTriggeredText: string = "";
    private lastChangeTimestamp: number = Date.now();
    private readonly maxWaitMs: number = 2500;
    private readonly minCharChange: number = 4;

    /**
     * 重置门控历史
     */
    public reset() {
        this.lastTriggeredText = "";
        this.lastChangeTimestamp = Date.now();
    }

    /**
     * 规范化文本：去除连续空白与换行格式干扰
     */
    public normalizeText(text: string): string {
        return text.replace(/\s+/g, ' ').trim();
    }

    /**
     * 去除标点后的纯文本，用于判断是否仅仅是标点变化
     */
    private stripPunctuation(text: string): string {
        return text.replace(/[.,/#!$%^&*;:{}=\-_`~()?"'，。！？、；：‘’“”《》【】]/g, '').trim();
    }

    /**
     * 评估当前文本变动是否应放行检索请求
     */
    public evaluate(currentText: string, isContextJump: boolean = false): GateDecision {
        const now = Date.now();
        const normCurrent = this.normalizeText(currentText);

        // 如果发生了文件/Heading/段落跳转，直接放行
        if (isContextJump) {
            this.lastTriggeredText = normCurrent;
            this.lastChangeTimestamp = now;
            return { shouldTrigger: true, reason: 'SIGNIFICANT_CHANGE' };
        }

        if (normCurrent === this.lastTriggeredText) {
            return { shouldTrigger: false, reason: 'NO_CHANGE' };
        }

        if (normCurrent.length < 3) {
            return { shouldTrigger: false, reason: 'TOO_SHORT' };
        }

        // 检查持续打字是否超过 MaxWait (避免长写作流一直不刷新)
        if (now - this.lastChangeTimestamp >= this.maxWaitMs && normCurrent !== this.lastTriggeredText) {
            this.lastTriggeredText = normCurrent;
            this.lastChangeTimestamp = now;
            return { shouldTrigger: true, reason: 'MAX_WAIT_EXCEEDED' };
        }

        // 检查是否仅修改了标点或空白
        const pureCurrent = this.stripPunctuation(normCurrent);
        const pureLast = this.stripPunctuation(this.lastTriggeredText);
        if (pureCurrent === pureLast) {
            return { shouldTrigger: false, reason: 'PUNCTUATION_OR_WHITESPACE' };
        }

        // 句末标点立即触发（用户刚敲完一句话）
        const lastChar = normCurrent.slice(-1);
        if (['。', '！', '？', '.', '!', '?'].includes(lastChar)) {
            this.lastTriggeredText = normCurrent;
            this.lastChangeTimestamp = now;
            return { shouldTrigger: true, reason: 'PUNCTUATION_END' };
        }

        // 字符编辑量检查
        const charDiff = Math.abs(normCurrent.length - this.lastTriggeredText.length);
        if (charDiff >= this.minCharChange) {
            this.lastTriggeredText = normCurrent;
            this.lastChangeTimestamp = now;
            return { shouldTrigger: true, reason: 'SIGNIFICANT_CHANGE' };
        }

        return { shouldTrigger: false, reason: 'TOO_SHORT' };
    }
}
