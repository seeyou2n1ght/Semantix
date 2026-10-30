import picomatch from 'picomatch';

export class ExclusionMatcher {
    private rulesStr: string;
    private matchers: ((path: string) => boolean)[] = [];

    constructor(rulesStr: string = '') {
        this.rulesStr = rulesStr;
        this.compile();
    }

    private compile(): void {
        this.matchers = [];
        const rules = this.rulesStr
            .split('\n')
            .map(r => r.trim())
            .filter(r => r.length > 0);

        for (const r of rules) {
            let globRule = r;
            // Downward compatibility: If rule doesn't contain glob characters, make it a prefix match
            if (!r.includes('*') && !r.includes('?') && !r.includes('[') && !r.includes(']')) {
                if (r.endsWith('/')) {
                    globRule = `${r}**`;
                } else if (r.includes('.')) {
                    // Keep file match as is
                } else {
                    globRule = `${r}/**`;
                }
            }

            try {
                this.matchers.push(picomatch(globRule));
            } catch (e) {
                console.error(`Semantix: Invalid glob matching rule "${globRule}":`, e);
            }
        }
    }

    public isExcluded(path: string): boolean {
        if (!path || this.matchers.length === 0) return false;
        for (const isMatch of this.matchers) {
            try {
                if (isMatch(path)) return true;
            } catch {
                // Ignore matching errors for invalid paths
            }
        }
        return false;
    }

    /**
     * Expand exclusion rules to concrete matched paths from a set of known paths.
     * Never returns raw globs.
     */
    public expandToPaths(knownPaths: Iterable<string>): string[] {
        const matched: string[] = [];
        for (const p of knownPaths) {
            if (this.isExcluded(p)) matched.push(p);
        }
        return matched;
    }
}
