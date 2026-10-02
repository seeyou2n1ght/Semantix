require('./highlights.cjs');
require('./source-location.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

class RadarView {
    errors = 0;
    results = 0;
    progress = [];
    partialResults = 0;
    cancelled = 0;
    showLoading() {}
    clearLoading() {}
    showSearchError() { this.errors++; }
    updateNoteScanProgress(current, total) { this.progress.push([current, total]); }
    renderRadarResults(_r, _d, _p, _h, _q, _w, partial) {
        if (partial) this.partialResults++;
        else this.results++;
    }
    showScanCancelled() { this.cancelled++; }
}
class MarkdownView {}

const source = fs.readFileSync(path.join(__dirname, '../src/core/radar.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020
} }).outputText;
const exported = {};
const noteScan = require('./note-scan.cjs');
const modules = {
    obsidian: { MarkdownView, debounce: fn => fn },
    '@codemirror/view': {},
    '../ui/radar-view': { RADAR_VIEW_TYPE: 'radar', RadarView },
    './context': { ContextEngine: class {} },
    './query-gate': { QueryChangeGate: class { reset() {} } },
    './result-stabilizer': { ResultStabilizer: class { stabilize(related, discover) { return { related, discover }; } } },
    './note-scan': noteScan
};
vm.runInNewContext(code, { exports: exported, require: name => modules[name] || {}, console,
    window: { setTimeout: () => 1, clearTimeout() {} } });

(async () => {
    const view = new RadarView();
    const markdownView = Object.assign(new MarkdownView(), { file: { path: 'current.md' } });
    let fail = true;
    const requests = [];
    const plugin = {
        settings: { debounceDelay: 400, topNResults: 4, rankingMode: 'fast', enableAdaptiveFiltering: false, customStopwords: '示例，Example\n模板' },
        vaultId: 'v',
        getConnectionStatus: () => 'connected',
        app: { workspace: {
            getActiveViewOfType: () => null,
            getActiveFile: () => markdownView.file,
            getLeavesOfType: type => type === 'markdown' ? [{ view: markdownView }] : [{ view }]
        } },
        apiClient: { radarSearch: async request => {
            requests.push(request);
            return fail ? null : { context_id: request.context_id, related: [], discover: [] };
        } }
    };
    const radar = new exported.RadarEngine(plugin);
    const snapshot = { contextId: 'ctx', context: { path: 'current.md', scope: 'focus' }, cleanedText: 'query', transitionType: 'NEW_FILE' };
    await radar.executeRadarSearch(snapshot);
    assert.equal(requests[0].enable_adaptive_filtering, false);
    assert.deepEqual(Array.from(requests[0].custom_stopwords), ['示例', 'Example', '模板']);
    assert.equal(view.errors, 1);
    assert.equal(view.results, 0);

    fail = false;
    const note = { ...snapshot, context: { ...snapshot.context, scope: 'note' }, cleanedText: 'A'.repeat(250) + '\n\nquantum tail', transitionType: 'NOTE_MODE' };
    radar.contextEngine.captureNoteSnapshot = () => note;
    await radar.triggerNoteScan();
    assert(requests.some(request => request.context.text.includes('quantum tail')));
    assert(view.progress.length > 1);
    assert.equal(view.results, 1);
    assert(view.partialResults > 0, 'whole-note scans must show partial results before completion');

    let currentNote = note;
    radar.contextEngine.captureNoteSnapshot = () => currentNote;
    plugin.apiClient.radarSearch = async request => {
        currentNote = { ...note, cleanedText: 'edited while scanning' };
        return { context_id: request.context_id, related: [], discover: [] };
    };
    await radar.triggerNoteScan();
    assert.equal(view.results, 1, 'edited note must not render old scan results');

    radar.debouncedSearch = () => {}; // Leave the next request inside its debounce window.
    for (const event of ['edit', 'cursor', 'selection']) {
        let complete;
        plugin.apiClient.radarSearch = () => new Promise(resolve => { complete = resolve; });
        const before = view.results;
        const pending = radar.executeRadarSearch(snapshot);
        if (event === 'edit') radar.onEditorChange({}, markdownView);
        else radar.onCursorActivity();
        complete({ context_id: snapshot.contextId, related: [], discover: [] });
        await pending;
        assert.equal(view.results, before, `${event} must invalidate before another request is sent`);
    }
    let complete;
    plugin.apiClient.radarSearch = () => new Promise(resolve => { complete = resolve; });
    const pending = radar.executeRadarSearch(snapshot);
    const before = view.results;
    radar.onEditorChange({}, new MarkdownView());
    complete({ context_id: snapshot.contextId, related: [], discover: [] });
    await pending;
    assert.equal(view.results, before + 1, 'an inactive editor must not invalidate the active search');

    const sent = [];
    const completions = [];
    plugin.apiClient.radarSearch = request => {
        sent.push(request.context_id);
        return new Promise(resolve => completions.push(() => resolve({
            context_id: request.context_id, related: [], discover: []
        })));
    };
    const first = radar.executeRadarSearch({ ...snapshot, contextId: 'first' });
    const middle = radar.executeRadarSearch({ ...snapshot, contextId: 'middle' });
    const latest = radar.executeRadarSearch({ ...snapshot, contextId: 'latest' });
    assert.deepEqual(sent, ['first']);
    completions.shift()();
    await first;
    await middle;
    assert.deepEqual(sent, ['first', 'latest'], 'superseded queued contexts must not reach the engine');
    completions.shift()();
    await latest;

    radar.contextEngine.captureNoteSnapshot = () => note;
    sent.length = 0;
    const scanning = radar.triggerNoteScan();
    radar.cancelSearch();
    completions.shift()();
    await scanning;
    assert.equal(sent.length, 1, 'cancel must prevent subsequent note parts');
    assert(view.cancelled > 0);
    console.log('radar failure and note scan state passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
