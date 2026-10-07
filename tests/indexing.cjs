const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

class TFile {
    constructor(path) { this.path = path; this.extension = 'md'; }
}
const notices = [];
const timers = [];
class Notice {
    constructor(text) { notices.push(text); }
    hide() {}
}
const obsidian = { TFile, TFolder: class {}, TAbstractFile: class {}, Plugin: class {},
    Modal: class {}, Notice, Platform: { isDesktop: true, isMobile: false } };
const window = { setTimeout(_fn, ms) { timers.push(ms); return timers.length; },
    clearTimeout() {}, requestIdleCallback(fn) { fn(); } };
function load(file, modules) {
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true
    } }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, require: name => modules[name] || {},
        console: { warn() {}, error() {} }, window });
    return exports;
}
const markdown = load('src/utils/markdown.ts', {});
const batch = load('src/core/index-batch.ts', { '../utils/markdown': markdown });
const SyncManager = load('src/core/sync.ts', { obsidian, './index-batch': batch,
    picomatch: () => () => false }).SyncManager;
const HealthStatus = { READY: 'ready', LOADING: 'loading', ERROR: 'error', NONE: 'none' };
const Semantix = load('src/main.ts', { obsidian, './core/index-batch': batch,
    './api/client': { HealthStatus } }).default;
function stub(files, read) {
    const batches = [];
    const plugin = { settings: { syncBatchInterval: 60, exclusionRules: '' }, vaultId: 'test',
        app: { vault: { getAbstractFileByPath: path => files.find(f => f.path === path),
            cachedRead: read, getMarkdownFiles: () => files } },
        apiClient: { checkHealth: async () => true,
            indexBatch: async request => { batches.push(request.documents); return { status: 'success' }; },
            indexDelete: async () => ({ status: 'success' }), rebuildFtsIndex: async () => true },
        getFileContext: () => ({ tags: [], links: [] }), getIndexingState: () => ({ active: false }),
        updateIndexingProgress() {}, clearIndexingProgress() {}, checkConnection: async () => {},
        updateAllViewStatus() {} };
    return { plugin, batches };
}
async function fullIndex(fixture) {
    const plugin = new Semantix();
    Object.assign(plugin, fixture.plugin);
    plugin.syncManager = { pause: async () => {}, resume() {}, isExcludedPath: () => false };
    await plugin.startFullIndexing({ skipConfirm: true });
}
(async () => {
    const empty = new TFile('blank.md');
    const full = stub([empty], async () => '');
    await fullIndex(full);
    assert.equal(full.batches[0][0].text, '');
    const incremental = stub([empty], async () => '');
    const sync = new SyncManager(incremental.plugin);
    sync.queueUpdate(empty); await sync.flushQueue();
    assert.equal(incremental.batches[0][0].text, '');

    const files = Array.from({ length: 30 }, (_, i) => new TFile(`note-${i}.md`));
    const fullBulk = stub(files, async () => 'x'.repeat(10000));
    await fullIndex(fullBulk);
    const incrementalBulk = stub(files, async () => 'x'.repeat(10000));
    const bulk = new SyncManager(incrementalBulk.plugin);
    files.forEach(file => bulk.queueUpdate(file)); await bulk.flushQueue();
    assert.deepEqual(incrementalBulk.batches.map(b => b.length), [15, 15]);
    assert.deepEqual(fullBulk.batches.map(b => b.length), [15, 15]);
    const small = stub(files, async () => 'short');
    const smallSync = new SyncManager(small.plugin);
    files.forEach(file => smallSync.queueUpdate(file)); await smallSync.flushQueue();
    assert.deepEqual(small.batches.map(b => b.length), [25, 5]);
    const oversized = [...batch.indexBatches([
        { text: 'x'.repeat(150001) }, { text: 'next' }
    ])];
    assert.deepEqual(oversized.map(b => b.length), [1, 1]);

    const bad = stub([new TFile('bad.md'), new TFile('good.md')], async file => {
        if (file.path === 'bad.md') throw new Error('controlled read failure');
        return 'valid';
    });
    const failing = new SyncManager(bad.plugin);
    bad.plugin.app.vault.getMarkdownFiles().forEach(file => failing.queueUpdate(file));
    await failing.flushQueue();
    assert.equal(bad.batches[0][0].path, 'good.md');
    assert.equal(failing.pendingUpdates.size, 1);
    assert.equal(failing.retryAttempts, 1);
    assert.equal(timers.at(-1), 2000);
    await fullIndex(bad);
    assert.match(notices.at(-1), /部分完成/);
    const failedFull = stub([empty], async () => 'valid');
    failedFull.plugin.apiClient.indexBatch = async () => null;
    await fullIndex(failedFull);
    assert.match(notices.at(-1), /批次提交失败/);
    assert.doesNotMatch(notices.at(-1), /索引已取消|完成 ✅/);

    // A failed chunk of a large queue does not prevent later healthy batches.
    const partial = stub(files, async () => 'short');
    const partialSync = new SyncManager(partial.plugin);
    let calls = 0;
    partial.plugin.apiClient.indexBatch = async () => ++calls === 1 ? null : { status: 'success' };
    files.forEach(file => partialSync.queueUpdate(file)); await partialSync.flushQueue();
    assert.equal(calls, 2);
    assert.equal(partialSync.pendingUpdates.size, 25);

    // A newer update or repeated delete during a request needs another acknowledgment.
    const changing = stub([empty], async () => 'valid');
    const changingSync = new SyncManager(changing.plugin);
    changing.plugin.apiClient.indexBatch = async () => {
        changingSync.queueDelete(empty); changingSync.queueUpdate(empty);
        return { status: 'success' };
    };
    changingSync.queueUpdate(empty); await changingSync.flushQueue();
    assert.equal(changingSync.pendingUpdates.size, 1);
    changing.plugin.apiClient.indexDelete = async () => {
        changingSync.queueDelete(empty); return { status: 'success' };
    };
    changingSync.queueDelete(empty); await changingSync.flushQueue();
    assert.equal(changingSync.pendingDeletes.size, 1);

    // Polling a live failed/loading engine must not launch another sidecar.
    const unhealthy = new Semantix();
    Object.assign(unhealthy, stub([], async () => '').plugin);
    unhealthy.checkConnection = Semantix.prototype.checkConnection;
    unhealthy.settings.backendMode = 'local';
    unhealthy.settings.autoStartServer = true;
    let heals = 0;
    let status;
    unhealthy.serviceManager = { isActivating: () => false, isUserStopped: () => false,
        triggerSelfHealing: () => heals++ };
    unhealthy.apiClient.checkFullHealth = async () => HealthStatus.ERROR;
    unhealthy.apiClient.lastHealthResponse = { status: 'error', message: 'Controlled model load failure' };
    unhealthy.updateAllViewStatus = next => { status = next; };
    await unhealthy.checkConnection();
    assert.equal(status, 'disconnected');
    assert.equal(heals, 0);
    assert.equal(notices.at(-1), 'Controlled model load failure');
    unhealthy.apiClient.checkFullHealth = async () => HealthStatus.LOADING;
    await unhealthy.checkConnection();
    assert.equal(status, 'syncing');
    assert.equal(heals, 0);
    console.log('indexing: shared empty/batch rules, read/batch failure isolation and revision acknowledgments passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
