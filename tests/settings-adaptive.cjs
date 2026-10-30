const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/settings.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020
} }).outputText;
const exported = {};
const notices = [];
class FakeElement {
    constructor(cls = '', text = '') { this.cls = cls; this.text = text; this.children = []; }
    createDiv(options = {}) { const child = new FakeElement(options.cls, options.text); this.children.push(child); return child; }
    createSpan(options = {}) { return this.createDiv(options); }
    empty() { this.children = []; }
    setText(value) { this.text = value; }
    toggleClass() {}
    findAll(cls) { return [...(this.cls === cls ? [this] : []), ...this.children.flatMap(child => child.findAll(cls))]; }
}
class FakeSetting {
    setName() { return this; }
    setDesc() { return this; }
    addButton(callback) {
        callback({ setButtonText() { return this; }, onClick() { return this; }, setDisabled() { return this; } });
        return this;
    }
    addToggle(callback) { callback({ setValue() { return this; }, onChange() { return this; } }); return this; }
    addTextArea(callback) { callback({ setPlaceholder() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
}
vm.runInNewContext(code, { exports: exported, require: name => {
    if (name === 'obsidian') return {
        PluginSettingTab: class {}, Setting: FakeSetting,
        Notice: class { constructor(message) { notices.push(message); } }
    };
    if (name === './i18n/helpers') return { t: key => key };
    return {};
}, console });

(async () => {
    let connected = true;
    let supported = true;
    let computeResult = { words: ['common'], total_docs: 10, min_doc_freq: 3, threshold: 0.3 };
    let effective = false;
    const events = [];
    const plugin = {
        settings: { enableAdaptiveFiltering: false }, vaultStopwords: [],
        getConnectionStatus: () => connected ? 'connected' : 'disconnected',
        saveSettings: async () => { events.push('save'); },
        checkConnection: async () => {
            events.push('health');
            effective = plugin.settings.enableAdaptiveFiltering && connected && supported && !!computeResult;
            if (effective) {
                events.push('compute');
                plugin.vaultStopwords = computeResult.words;
            }
            plugin.radar.refreshCurrentScope();
        },
        resetAdaptiveFilteringPreparation: () => { events.push('reset'); effective = false; },
        queueAdaptiveRefresh: () => { events.push('queue'); },
        isAdaptiveFilteringEffective: () => effective,
        isAdaptiveFilteringPreparing: () => false,
        apiClient: {
            supportsAdaptiveSoftFiltering: () => supported,
            computeStopwords: async () => { events.push('compute'); return computeResult; }
        },
        radar: {
            invalidateForSettingsChange: () => { events.push('invalidate'); },
            refreshCurrentScope: () => { events.push('refresh'); }
        }
    };
    const tab = Object.create(exported.SemantixSettingTab.prototype);
    tab.plugin = plugin;
    const status = { text: '', hidden: false,
        setText(value) { this.text = value; },
        toggleClass(_name, value) { this.hidden = value; } };
    tab.adaptiveStatusEl = status;

    await tab.applyAdaptiveFiltering(true);
    assert.equal(plugin.settings.enableAdaptiveFiltering, true);
    tab.updateAdaptiveStatus();
    assert.equal(status.text, 'ADAPTIVE_ACTIVE');
    assert.deepEqual(events, ['invalidate', 'queue', 'reset', 'save', 'health', 'compute', 'refresh']);
    assert.deepEqual(plugin.vaultStopwords, ['common']);
    events.length = 0;

    await tab.applyAdaptiveFiltering(false);
    assert.equal(plugin.settings.enableAdaptiveFiltering, false);
    tab.updateAdaptiveStatus();
    assert.equal(status.hidden, true);
    assert.deepEqual(events, ['invalidate', 'queue', 'reset', 'save', 'health', 'refresh']);
    events.length = 0;

    supported = false;
    await tab.applyAdaptiveFiltering(true);
    assert.deepEqual(events, ['invalidate', 'queue', 'reset', 'save', 'health', 'refresh']);
    assert.equal(notices.at(-1), 'ADAPTIVE_INACTIVE');
    tab.updateAdaptiveStatus();
    assert.equal(status.text, 'ADAPTIVE_INACTIVE');
    events.length = 0;

    connected = false;
    await tab.applyAdaptiveFiltering(false);
    await tab.applyAdaptiveFiltering(true);
    assert.equal(events.filter(event => event === 'compute').length, 0);
    assert.equal(events.filter(event => event === 'refresh').length, 2);
    events.length = 0;

    connected = true;
    supported = true;
    computeResult = null;
    await tab.applyAdaptiveFiltering(true);
    assert.equal(notices.at(-1), 'ADAPTIVE_INACTIVE');
    assert.equal(events.at(-1), 'refresh');

    const root = new FakeElement();
    tab.isStopwordsOpen = true;
    plugin.vaultStopwords = ['old'];
    tab.renderStopwordsFilter(root);
    plugin.vaultStopwords = ['current', 'manual'];
    tab.refreshAdaptiveStopwordsDisplay();
    assert.deepEqual(root.findAll('semantix-stopword-chip').map(el => el.text), ['current', 'manual'],
        'open drawer rerenders accepted words without closing it');
    assert.equal(root.findAll('semantix-stopwords-title')[0].text, 'ADAPTIVE_STOPWORDS_TITLE (2):');
    // PluginSettingTab uses display(), not onOpen(): opening the tab must request metrics.
    let identity = 'engine-a';
    let resolveMetrics;
    let metricRequests = 0;
    const metricsPlugin = {
        getIndexIdentity: () => identity,
        apiClient: { getMetrics: () => { metricRequests++; return new Promise(resolve => { resolveMetrics = resolve; }); } }
    };
    const metricsTab = new exported.SemantixSettingTab({}, metricsPlugin);
    metricsTab.containerEl = new FakeElement();
    metricsTab.containerEl.scrollTop = 0;
    let renders = 0, stateRefreshes = 0;
    metricsTab.renderStatusHeader = () => { renders++; };
    for (const name of ['renderRecommendationCard','renderVaultIndexCard','renderEngineCard','renderMaintenanceCard']) metricsTab[name] = () => {};
    metricsTab.refreshStatusDisplay = () => { stateRefreshes++; };
    metricsTab.display();
    assert.equal(metricRequests, 1, 'first display fetches actual metrics');
    metricsTab.updateIndexSnapshot(3, 'newer-index-status');
    resolveMetrics({ total_indexed_docs: 0, db_size_bytes: 120, last_index_at: 'old' });
    await new Promise(setImmediate);
    assert.equal(metricsTab.dbMetrics.total_indexed_docs, 3, 'late metrics preserve a newer accepted index count');
    assert.equal(metricsTab.dbMetrics.db_size_bytes, 120);
    assert.equal(stateRefreshes, 1);
    assert.equal(renders, 1, 'metric refresh does not rebuild inputs or drawers');
    metricsTab.display();
    identity = 'engine-b';
    resolveMetrics({ total_indexed_docs: 99, db_size_bytes: 999 });
    await new Promise(setImmediate);
    assert.equal(metricsTab.dbMetrics.total_indexed_docs, 3, 'old endpoint metrics cannot replace current state');
    console.log('adaptive setting on/off, old engine, offline and compute failure passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
