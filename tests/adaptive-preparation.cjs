const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const exported = {};
const notices = [];
vm.runInNewContext(code, { exports: exported, require: name => {
    if (name === 'obsidian') return {
        Plugin: class {}, Modal: class {}, Platform: { isDesktop: false },
        Notice: class { constructor(message) { notices.push(message); } }
    };
    if (name === './api/client') return { HealthStatus: { READY: 'READY', LOADING: 'LOADING', ERROR: 'ERROR' } };
    if (name === './i18n/helpers') return { t: key => key };
    return {};
}, console });

(async () => {
    let supported = true;
    let calls = 0;
    let response = { words: ['shared'] };
    const plugin = Object.create(exported.default.prototype);
    plugin.settings = { enableAdaptiveFiltering: false };
    plugin.apiClient = {
        supportsAdaptiveSoftFiltering: () => supported,
        computeStopwords: async () => { calls++; return response; }
    };
    plugin.vaultStopwords = [];
    plugin.adaptivePreparation = 'idle';
    plugin.adaptivePreparationTask = null;
    plugin.adaptivePreparationKey = '';
    plugin.adaptivePreparationGeneration = 0;
    plugin.getConnectionStatus = () => 'connected';

    await plugin.prepareAdaptiveFiltering();
    assert.equal(calls, 0, 'default off never recalculates');
    plugin.settings.enableAdaptiveFiltering = true;
    supported = false;
    await plugin.prepareAdaptiveFiltering();
    assert.equal(calls, 0, 'old engine never recalculates');
    assert.equal(plugin.isAdaptiveFilteringEffective(), false);

    supported = true;
    await plugin.prepareAdaptiveFiltering();
    await plugin.prepareAdaptiveFiltering();
    assert.equal(calls, 1, 'successful connection preparation is bounded');
    assert.equal(plugin.isAdaptiveFilteringEffective(), true);
    assert.deepEqual(plugin.vaultStopwords, ['shared']);

    plugin.resetAdaptiveFilteringPreparation();
    response = null;
    await plugin.prepareAdaptiveFiltering();
    await plugin.prepareAdaptiveFiltering();
    assert.equal(calls, 2, 'failed preparation does not retry on every health poll');
    assert.equal(plugin.isAdaptiveFilteringEffective(), false);
    assert.equal(notices.at(-1), 'STOPWORDS_FAILED');
    let resolveOld;
    plugin.settings.backendUrl = 'http://engine-a';
    plugin.apiClient.computeStopwords = () => new Promise(resolve => { resolveOld = resolve; });
    const oldTask = plugin.prepareAdaptiveFiltering();
    plugin.settings.backendUrl = 'http://engine-b';
    plugin.apiClient.computeStopwords = async () => ({ words: ['engine-b'] });
    await plugin.prepareAdaptiveFiltering();
    resolveOld({ words: ['engine-a'] });
    await oldTask;
    assert.deepEqual(plugin.vaultStopwords, ['engine-b'], 'late old-engine result must not overwrite new engine');
    assert.equal(plugin.isAdaptiveFilteringEffective(), true);

    const racing = Object.create(exported.default.prototype);
    racing.settings = { enableAdaptiveFiltering: true, backendMode: 'remote', backendUrl: 'http://engine-b', apiToken: '' };
    racing.vaultId = 'vault';
    racing.lastConnectionStatus = 'disconnected';
    racing.connectionCheckId = 0;
    racing.adaptivePreparation = 'idle';
    racing.adaptivePreparationKey = '';
    racing.adaptivePreparationGeneration = 0;
    racing.adaptivePreparationTask = null;
    racing.adaptiveRefreshPending = false;
    racing.vaultStopwords = [];
    racing.getConnectionStatus = () => racing.lastConnectionStatus;
    racing.updateAllViewStatus = status => { racing.lastConnectionStatus = status; };
    racing.updateAllViewIndexStatus = () => {};
    racing.syncManager = { setConnectionReady() {} };
    racing.serviceManager = { onHealthyStable() {} };
    let resolveCompute;
    racing.apiClient = {
        supportsAdaptiveSoftFiltering: () => true,
        checkFullHealth: async () => 'READY',
        getIndexStatus: async () => ({ total_notes: 2, vault_stopwords: [] }),
        ping: async () => {},
        computeStopwords: () => new Promise(resolve => { resolveCompute = resolve; })
    };
    let refreshes = 0;
    racing.radar = { refreshCurrentScope: () => { refreshes++; } };
    racing.queueAdaptiveRefresh();
    const checkB = racing.checkConnection({ silent: true });
    await new Promise(setImmediate);
    assert.equal(racing.adaptivePreparation, 'pending');
    const checkC = racing.checkConnection({ silent: true });
    await new Promise(setImmediate);
    assert.equal(refreshes, 0, 'no refresh before preparation completes');
    resolveCompute({ words: ['ready'] });
    await Promise.all([checkB, checkC]);
    assert.equal(racing.isAdaptiveFilteringEffective(), true);
    assert.equal(refreshes, 1, 'the latest health check flushes one adaptive refresh');

    // A setting check can be superseded while its preparation is in flight.
    // A later disabled check must settle the queued refresh with adaptive=false.
    racing.resetAdaptiveFilteringPreparation();
    racing.queueAdaptiveRefresh();
    let resolveStale;
    racing.apiClient.computeStopwords = () => new Promise(resolve => { resolveStale = resolve; });
    const superseded = racing.checkConnection({ silent: true });
    await new Promise(setImmediate);
    assert.equal(racing.adaptivePreparation, 'pending');
    racing.isMobileHibernating = true;
    await racing.checkConnection({ silent: true });
    assert.equal(refreshes, 2, 'disabled latest check refreshes without waiting for stale preparation');
    const wordsBeforeStale = racing.vaultStopwords.slice();
    resolveStale({ words: ['stale'] });
    await superseded;
    assert.equal(refreshes, 2, 'stale check cannot refresh again');
    assert.equal(racing.isAdaptiveFilteringEffective(), false);
    assert.deepEqual(racing.vaultStopwords, wordsBeforeStale, 'stale preparation cannot replace the current list');

    racing.isMobileHibernating = false;
    racing.apiClient.checkFullHealth = async () => 'READY';
    racing.apiClient.computeStopwords = async () => ({ words: ['reenabled'] });
    await racing.checkConnection({ silent: true });
    assert.equal(racing.isAdaptiveFilteringEffective(), true, 'reenabling prepares a fresh list');

    let resolveRestarted;
    racing.resetAdaptiveFilteringPreparation();
    racing.apiClient.computeStopwords = () => new Promise(resolve => { resolveRestarted = resolve; });
    const beforeRestart = racing.checkConnection({ silent: true });
    await new Promise(setImmediate);
    racing.apiClient.checkFullHealth = async () => 'ERROR';
    await racing.checkConnection({ silent: true });
    racing.apiClient.checkFullHealth = async () => 'READY';
    racing.apiClient.computeStopwords = async () => ({ words: ['after-restart'] });
    await racing.checkConnection({ silent: true });
    resolveRestarted({ words: ['before-restart'] });
    await beforeRestart;
    assert.deepEqual(racing.vaultStopwords, ['after-restart'], 'same-endpoint restart rejects old computation');

    let resolveManual;
    racing.apiClient.computeStopwords = () => new Promise(resolve => { resolveManual = resolve; });
    const oldManual = racing.recalculateAdaptiveFiltering();
    racing.settings.backendUrl = 'http://engine-c';
    racing.apiClient.computeStopwords = async () => ({ words: ['engine-c'] });
    await racing.checkConnection({ silent: true });
    resolveManual({ words: ['engine-b'] });
    assert.equal(await oldManual, undefined, 'manual response from old endpoint is rejected');
    assert.deepEqual(racing.vaultStopwords, ['engine-c']);
    assert.equal(racing.isAdaptiveFilteringEffective(), true);

    const displayedWords = [];
    racing.settingTab = { updateIndexSnapshot() {}, refreshAdaptiveStopwordsDisplay: () => displayedWords.push(racing.vaultStopwords.slice()) };
    let resolveOldStatus;
    racing.apiClient.getIndexStatus = () => new Promise(resolve => { resolveOldStatus = resolve; });
    const oldStatusCheck = racing.checkConnection({ silent: true });
    await new Promise(setImmediate);
    racing.apiClient.computeStopwords = async () => ({ words: ['fresh-manual'] });
    assert.deepEqual((await racing.recalculateAdaptiveFiltering()).words, ['fresh-manual']);
    resolveOldStatus({ total_notes: 2, vault_stopwords: ['old-snapshot'] });
    await oldStatusCheck;
    assert.deepEqual(racing.vaultStopwords, ['fresh-manual'], 'older index status cannot overwrite manual recomputation');
    assert.deepEqual(displayedWords.at(-1), ['fresh-manual'], 'visible list follows the accepted computation');
    console.log('adaptive preparation: off, old engine, ready, failure and bounded retry passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
