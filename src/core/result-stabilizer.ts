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

        // 2. 上下文明确跃迁（新文件、选区、新标题、新段落、光标换行、Note Mode）：直接呈现当前位置的最新推荐结果
        if (
            transitionType === 'NOTE_MODE' ||
            transitionType === 'SELECTION' ||
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

        // 4. 双流强互斥保证：Related 具有绝对优先权，同一笔记不得同时出现在 Discover
        const relatedPaths = new Set(this.relatedCards.map(c => c.item.path));
        const finalDiscover: DisplayedCard[] = [];
        const usedDiscoverIds = new Set(this.relatedCards.map(c => c.item.id));

        for (const card of this.discoverCards) {
            if (!relatedPaths.has(card.item.path) && !usedDiscoverIds.has(card.item.id)) {
                usedDiscoverIds.add(card.item.id);
                finalDiscover.push(card);
            }
        }

        // 若剔除重复后 Discover 产生空位，使用 incomingDiscover 中未使用的项填补
        if (finalDiscover.length < incomingDiscover.length) {
            for (const item of incomingDiscover) {
                if (finalDiscover.length >= incomingDiscover.length) break;
                if (!relatedPaths.has(item.path) && !usedDiscoverIds.has(item.id)) {
                    usedDiscoverIds.add(item.id);
                    finalDiscover.push({
                        item,
                        enteredAt: now,
                        position: finalDiscover.length,
                        displayLabels: [...item.labels]
                    });
                }
            }
        }
        this.discoverCards = finalDiscover;

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
        allowRelaxedReplacement: boolean
    ): DisplayedCard[] {
        if (currentList.length === 0) {
            return this.createDisplayedCards(incomingList, now);
        }
        // 当 incoming 为空时，超过最低展示寿命后允许清空淡出，避免旧卡片永久常驻
        if (!incomingList || incomingList.length === 0) {
            const hasYoungCard = currentList.some(c => (now - c.enteredAt) < policy.minimumLifetimeMs);
            return hasYoungCard ? currentList : [];
        }

        const incomingMap = new Map<string, RadarCardItem>();
        for (const item of incomingList) {
            incomingMap.set(item.id, item);
        }

        const nextCards: DisplayedCard[] = [];
        const retainedIds = new Set<string>();
        let replacementCount = 0;
        const maxReplacements = allowRelaxedReplacement ? policy.maxReplacementsPerTick + 1 : policy.maxReplacementsPerTick;

        // 遍历当前已展示卡片，判定是否保留
        for (const displayed of currentList) {
            const incomingSame = incomingMap.get(displayed.item.id);
            const age = now - displayed.enteredAt;

            // 情况 1: 该卡片在 incoming 中依然存在
            if (incomingSame) {
                retainedIds.add(displayed.item.id);
                // 标签平滑演进：以既有稳定标签为主，但融合新标签，不锁死
                const mergedLabels = Array.from(new Set([...displayed.displayLabels, ...incomingSame.labels])).slice(0, 2);
                nextCards.push({
                    item: {
                        ...incomingSame,
                        labels: mergedLabels
                    },
                    enteredAt: displayed.enteredAt,
                    position: nextCards.length,
                    displayLabels: mergedLabels
                });
                continue;
            }

            // 情况 2: 未达到最短展示寿命，强制保留，避免打字极速闪烁
            if (age < policy.minimumLifetimeMs) {
                retainedIds.add(displayed.item.id);
                nextCards.push(displayed);
                continue;
            }

            // 情况 3: 已达到最短展示寿命且在新一轮候选池中被淘汰：允许按限额淘汰并由 incoming 新卡片补位
            if (replacementCount < maxReplacements) {
                replacementCount++;
                // 淘汰此卡片，不加入 retainedIds 和 nextCards
            } else {
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
