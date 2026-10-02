import { RadarCardItem } from '../api/types';
import { ContextTransitionType } from './context';

export class ResultStabilizer {
    private relatedCards: RadarCardItem[] = [];
    private discoverCards: RadarCardItem[] = [];

    public resetAll() {
        this.relatedCards = [];
        this.discoverCards = [];
    }

    public getRelatedCards(): RadarCardItem[] { return this.relatedCards; }
    public getDiscoverCards(): RadarCardItem[] { return this.discoverCards; }

    public stabilize(
        incomingRelated: RadarCardItem[],
        incomingDiscover: RadarCardItem[],
        transitionType: ContextTransitionType,
    ): { related: RadarCardItem[]; discover: RadarCardItem[] } {
        if (transitionType !== 'SAME_PARAGRAPH') this.resetAll();
        // Stabilize positions only. Membership, scores, labels and highlights
        // always come from the current response, including an empty response.
        this.relatedCards = this.keepOrder(this.relatedCards, incomingRelated);
        const relatedPaths = new Set(this.relatedCards.map(item => item.path));
        this.discoverCards = this.keepOrder(this.discoverCards,
            incomingDiscover.filter(item => !relatedPaths.has(item.path)));
        return { related: this.relatedCards, discover: this.discoverCards };
    }

    private keepOrder(current: RadarCardItem[], incoming: RadarCardItem[]): RadarCardItem[] {
        const remaining = new Map(incoming.map(item => [item.path, item]));
        const result: RadarCardItem[] = [];
        for (const previous of current) {
            const updated = remaining.get(previous.path);
            if (updated) {
                result.push(updated);
                remaining.delete(previous.path);
            }
        }
        return result.concat([...remaining.values()]);
    }
}
