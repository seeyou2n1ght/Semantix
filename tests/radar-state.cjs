const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

class RadarView {
    errors = 0;
    results = 0;
    progress = [];
    showLoading() {}
    clearLoading() {}
    showSearchError() { this.errors++; }
    updateNoteScanProgress(current, total) { this.progress.push([current, total]); }
    renderRadarResults() { this.results++; }
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
    './query-gate': { QueryChangeGate: class {} },
    './result-stabilizer': { ResultStabilizer: class { stabilize(related, discover) { return { related, discover }; } } },
    './note-scan': noteScan
};
vm.runInNewContext(code, { exports: exported, require: name => modules[name] || {}, console });

(async () => {
    const view = new RadarView();
    const markdownView = Object.assign(new MarkdownView(), { file: { path: 'current.md' } });
    let fail = true;
    const requests = [];
    const plugin = {
        settings: { debounceDelay: 400, topNResults: 4, rankingMode: 'fast' },
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
    assert.equal(view.errors, 1);
    assert.equal(view.results, 0);

    fail = false;
    const note = { ...snapshot, context: { ...snapshot.context, scope: 'note' }, cleanedText: 'A'.repeat(250) + '\n\nquantum tail', transitionType: 'NOTE_MODE' };
    radar.contextEngine.captureNoteSnapshot = () => note;
    await radar.triggerNoteScan();
    assert(requests.some(request => request.context.text.includes('quantum tail')));
    assert(view.progress.length > 1);
    assert.equal(view.results, 1);

    let currentNote = note;
    radar.contextEngine.captureNoteSnapshot = () => currentNote;
    plugin.apiClient.radarSearch = async request => {
        currentNote = { ...note, cleanedText: 'edited while scanning' };
        return { context_id: request.context_id, related: [], discover: [] };
    };
    await radar.triggerNoteScan();
    assert.equal(view.results, 1, 'edited note must not render old scan results');
    console.log('radar failure and note scan state passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
