import { RadarCardItem } from '../api/types';
import { ContextTransitionType } from './context';

export interface DisplayedCard {
    item: RadarCardItem;
    enteredAt: number;
    position: number;
    displayLabels: string[];
}

export interface StabilizerPolicy {
    replacementMargin: number;    // 新卡片分数需比旧卡片高出多少才允许置换
    minimumLifetimeMs: number;    // 卡片展示最短时间，防止过早被替换
    maxReplacementsPerTick: number;// 单次更新最多置换多少张卡片
}

export const RELATED_POLICY: StabilizerPolicy = {
    replacementMargin: 0.05,
    minimumLifetimeMs: 1500,
    maxReplacementsPerTick: 2,
};

export const DISCOVER_POLICY: StabilizerPolicy = {
    replacementMargin: 0.15,
    minimumLifetimeMs: 5000,
    maxReplacementsPerTick: 1,
};

export class ResultStabilizer {
    private relatedCards: DisplayedCard[] = [];
    private discoverCards: DisplayedCard[] = [];

    /**
     * 重置所有卡片（如切换到新文件）
     */
    public resetAll() {
        this.relatedCards = [];
        this.discoverCards = [];
    }

    public getRelatedCards(): RadarCardItem[] {
        return this.relatedCards.map(c => c.item);
    }

    public getDiscoverCards(): RadarCardItem[] {
        return this.discoverCards.map(c => c.item);
    }

    /**
     * 稳定化处理双流数据
     */
    public stabilize(
        incomingRelated: RadarCardItem[],
        incomingDiscover: RadarCardItem[],
        transitionType: ContextTransitionType,
    ): { related: RadarCardItem[]; discover: RadarCardItem[] } {
        const now = Date.now();

        // 1. 新文件打开，无条件清空重置
        if (transitionType === 'NEW_FILE') {
            this.resetAll();
        }

        // 2. 上下文明确跃迁（新文件、新标题、新段落、光标换行、Note Mode）：直接呈现当前位置的最新推荐结果
        if (
            transitionType === 'NOTE_MODE' ||
            transitionType === 'NEW_HEADING' ||
            transitionType === 'NEW_FILE' ||
            transitionType === 'NEW_PARAGRAPH' ||
            transitionType === 'LINE_CHANGE'
        ) {
            this.relatedCards = this.createDisplayedCards(incomingRelated, now);
            this.discoverCards = this.createDisplayedCards(incomingDiscover, now);
            return {
                related: this.getRelatedCards(),
                discover: this.getDiscoverCards(),
            };
        }

        // 3. 仅在同一上下文内持续打字输入（SAME_PARAGRAPH）时：按 Policy 执行抗抖置换
        this.relatedCards = this.stabilizeChannel(
            this.relatedCards,
            incomingRelated,
            RELATED_POLICY,
            now,
            false
        );

        this.discoverCards = this.stabilizeChannel(
            this.discoverCards,
            incomingDiscover,
            DISCOVER_POLICY,
            now,
            false
        );

        return {
            related: this.getRelatedCards(),
            discover: this.getDiscoverCards(),
        };
    }

    /**
     * 单通道稳定化置换逻辑
     */
    private stabilizeChannel(
        currentList: DisplayedCard[],
        incomingList: RadarCardItem[],
        policy: StabilizerPolicy,
        now: number,
        isNewParagraph: boolean
    ): DisplayedCard[] {
        if (currentList.length === 0) {
            return this.createDisplayedCards(incomingList, now);
        }
        if (!incomingList || incomingList.length === 0) {
            return currentList;
        }

        const incomingMap = new Map<string, RadarCardItem>();
        for (const item of incomingList) {
            incomingMap.set(item.id, item);
        }

        const nextCards: DisplayedCard[] = [];
        const retainedIds = new Set<string>();
        let replacementCount = 0;
        const maxReplacements = isNewParagraph ? policy.maxReplacementsPerTick + 1 : policy.maxReplacementsPerTick;

        // 遍历当前已展示卡片，判定是否保留
        for (const displayed of currentList) {
            const incomingSame = incomingMap.get(displayed.item.id);
            const age = now - displayed.enteredAt;

            // 情况 1: 该卡片在 incoming 中依然存在
            if (incomingSame) {
                retainedIds.add(displayed.item.id);
                // 关键原则：只要卡片保留，保持原有的 displayLabels，防止标签跳闪
                nextCards.push({
                    item: {
                        ...incomingSame,
                        labels: displayed.displayLabels || incomingSame.labels
                    },
                    enteredAt: displayed.enteredAt,
                    position: nextCards.length,
                    displayLabels: displayed.displayLabels
                });
                continue;
            }

            // 情况 2: 该卡片未出现在 incoming 中，但尚未达到最短展示寿命
            if (age < policy.minimumLifetimeMs) {
                retainedIds.add(displayed.item.id);
                nextCards.push(displayed);
                continue;
            }

            // 情况 3: 达到寿命且已被 incoming 淘汰，尝试允许置换
            if (replacementCount < maxReplacements) {
                replacementCount++;
                // 此卡片被淘汰，不放入 nextCards
            } else {
                // 超过单次置换上限，暂时保留一轮
                retainedIds.add(displayed.item.id);
                nextCards.push(displayed);
            }
        }

        // 用未入选的 incoming 新卡片补充空位
        for (const incoming of incomingList) {
            if (nextCards.length >= incomingList.length) break;
            if (!retainedIds.has(incoming.id)) {
                retainedIds.add(incoming.id);
                nextCards.push({
                    item: incoming,
                    enteredAt: now,
                    position: nextCards.length,
                    displayLabels: [...incoming.labels]
                });
            }
        }

        return nextCards;
    }

    private createDisplayedCards(items: RadarCardItem[], now: number): DisplayedCard[] {
        return items.map((item, idx) => ({
            item,
            enteredAt: now,
            position: idx,
            displayLabels: [...item.labels]
        }));
    }
}
