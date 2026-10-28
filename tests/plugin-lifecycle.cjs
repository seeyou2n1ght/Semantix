const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const VIEW = 'semantix-whisperer-view';
const HealthStatus = { READY: 'ready', LOADING: 'loading', ERROR: 'error', NONE: 'none' };
const modules = {
    obsidian: { Plugin: class {}, Modal: class {}, Notice: class {}, Platform: { isDesktop: true } },
    './ui/radar-view': { RADAR_VIEW_TYPE: VIEW },
    './api/client': { HealthStatus },
    './i18n/helpers': { t: key => key }
};
const code = ts.transpileModule(fs.readFileSync('src/main.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const exportsObject = {};
vm.runInNewContext(code, { exports: exportsObject, require: name => modules[name] || {}, console });
const Semantix = exportsObject.default;

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function fixture() {
    const leaves = [];
    const revealed = [];
    let created = 0;
    let viewSetup = async () => {};
    const makeLeaf = type => {
        const leaf = {
            type,
            isDeferred: false,
            getViewState() { return { type: this.type }; },
            async loadIfDeferred() { this.isDeferred = false; },
            async setViewState(state) { await viewSetup(); this.type = state.type; },
            detach() { leaves.splice(leaves.indexOf(this), 1); }
        };
        leaves.push(leaf);
        return leaf;
    };
    const plugin = new Semantix();
    plugin.app = { workspace: {
        getLeavesOfType: type => leaves.filter(leaf => !leaf.isDeferred && leaf.type === type),
        iterateAllLeaves: callback => leaves.slice().forEach(callback),
        getRightLeaf: () => { created++; return makeLeaf('empty'); },
        revealLeaf: async leaf => { revealed.push(leaf); }
    } };
    plugin.syncManager = { clearTimer() {}, setConnectionReady() {} };
    plugin.serviceManager = { stop() {} };
    return { plugin, leaves, revealed, makeLeaf, created: () => created,
        setup: fn => { viewSetup = fn; } };
}

(async () => {
    // Both callers see no registered view until async initialization completes.
    const concurrent = fixture();
    const gate = deferred();
    concurrent.setup(() => gate.promise);
    const opening = [concurrent.plugin.activateRadarView(), concurrent.plugin.activateRadarView()];
    assert.equal(concurrent.created(), 1);
    gate.resolve();
    await Promise.all(opening);
    assert.equal(concurrent.leaves.filter(leaf => leaf.type === VIEW).length, 1);
    assert.equal(concurrent.revealed.length, 1);
    await concurrent.plugin.activateRadarView();
    assert.equal(concurrent.created(), 1);

    // Reopening a restored layout coalesces only Semantix tabs.
    const restored = fixture();
    const first = restored.makeLeaf(VIEW);
    restored.makeLeaf(VIEW);
    restored.makeLeaf(VIEW);
    const markdown = restored.makeLeaf('markdown');
    await restored.plugin.activateRadarView();
    assert.deepEqual(restored.leaves, [first, markdown]);
    assert.deepEqual(restored.revealed, [first]);
    assert.equal(restored.created(), 0);

    // Deferred background tabs retain the saved Semantix type despite not being live views.
    const background = fixture();
    const placeholder = background.makeLeaf(VIEW);
    placeholder.isDeferred = true;
    await background.plugin.activateRadarView();
    assert.equal(background.created(), 0, 'reuse a deferred view instead of creating a new tab');
    assert.equal(placeholder.isDeferred, false);
    assert.deepEqual(background.revealed, [placeholder]);

    // A later restored layout must keep the working panel and its current position.
    const late = fixture();
    const dormant = late.makeLeaf(VIEW);
    dormant.isDeferred = true;
    const working = late.makeLeaf(VIEW);
    const unrelated = late.makeLeaf('markdown');
    const originalDetach = dormant.detach;
    dormant.detach = () => {
        originalDetach.call(dormant);
        late.plugin.consolidateRadarLeaves(); // detach can synchronously trigger layout-change.
    };
    assert.equal(late.plugin.consolidateRadarLeaves(), working);
    assert.deepEqual(late.leaves, [working, unrelated]);
    const newPlaceholder = late.makeLeaf(VIEW);
    newPlaceholder.isDeferred = true;
    late.plugin.consolidateRadarLeaves();
    assert.deepEqual(late.leaves, [working, unrelated]);
    assert.equal(late.revealed.length, 0, 'layout maintenance must not steal focus');

    const deferredUnload = fixture();
    const deferredLeaf = deferredUnload.makeLeaf(VIEW);
    deferredLeaf.isDeferred = true;
    const loadingDeferred = deferred();
    deferredLeaf.loadIfDeferred = () => loadingDeferred.promise;
    const deferredActivation = deferredUnload.plugin.activateRadarView();
    deferredUnload.plugin.onunload();
    loadingDeferred.resolve();
    await deferredActivation;
    assert.equal(deferredUnload.revealed.length, 0);
    assert.equal(deferredUnload.created(), 0);

    // A rejected initialization releases the lock so an explicit retry works.
    const failed = fixture();
    failed.setup(async () => { throw new Error('view initialization failed'); });
    await assert.rejects(failed.plugin.activateRadarView(), /view initialization failed/);
    failed.setup(async () => {});
    await failed.plugin.activateRadarView();
    assert.equal(failed.leaves.filter(leaf => leaf.type === VIEW).length, 1);

    // An outstanding creation cannot revive the sidebar after plugin unload.
    const unloaded = fixture();
    const pending = deferred();
    unloaded.setup(() => pending.promise);
    const activation = unloaded.plugin.activateRadarView();
    unloaded.plugin.onunload();
    pending.resolve();
    await activation;
    await unloaded.plugin.activateRadarView();
    assert.equal(unloaded.created(), 1);
    assert.equal(unloaded.leaves.length, 0);
    assert.equal(unloaded.revealed.length, 0);

    // One failed health check must request recovery only once.
    const connection = fixture().plugin;
    let recoveries = 0;
    const statuses = [];
    const readiness = [];
    connection.syncManager.setConnectionReady = ready => readiness.push(ready);
    connection.settings = { backendMode: 'local', autoStartServer: true };
    connection.apiClient = { checkFullHealth: async () => HealthStatus.NONE };
    connection.serviceManager = { isActivating: () => false, isUserStopped: () => false,
        triggerSelfHealing: () => { recoveries++; } };
    connection.updateAllViewStatus = status => statuses.push(status);
    await connection.checkConnection({ silent: true });
    assert.equal(recoveries, 1);
    assert.deepEqual(statuses, ['disconnected']);
    assert.deepEqual(readiness, [false]);
    connection.apiClient = { checkFullHealth: async () => HealthStatus.READY,
        ping() {}, getIndexStatus: async () => null };
    connection.serviceManager.onHealthyStable = () => {};
    await connection.checkConnection({ silent: true });
    assert.deepEqual(readiness, [false, true]);
    connection.apiClient.checkFullHealth = async () => HealthStatus.LOADING;
    await connection.checkConnection({ silent: true });
    connection.apiClient.checkFullHealth = async () => HealthStatus.ERROR;
    await connection.checkConnection({ silent: true });
    connection.serviceManager.isUserStopped = () => true;
    await connection.checkConnection({ silent: true });
    assert.deepEqual(readiness, [false, true, false, false, false]);

    // Stop/unload during a health request cannot resume queued indexing.
    connection.serviceManager.isUserStopped = () => false;
    const lateHealth = deferred();
    connection.apiClient.checkFullHealth = () => lateHealth.promise;
    const checking = connection.checkConnection({ silent: true });
    connection.serviceManager.isUserStopped = () => true;
    lateHealth.resolve(HealthStatus.READY);
    await checking;
    assert.equal(readiness.at(-1), false);
    assert.equal(statuses.at(-1), 'disabled');
    connection.serviceManager.isUserStopped = () => false;
    connection.serviceManager.stop = () => {};
    const unloadHealth = deferred();
    connection.apiClient.checkFullHealth = () => unloadHealth.promise;
    const lastCheck = connection.checkConnection({ silent: true });
    connection.onunload();
    const readinessCount = readiness.length;
    unloadHealth.resolve(HealthStatus.READY);
    await lastCheck;
    assert.equal(readiness.length, readinessCount);
    assert.equal(readiness.at(-1), false);
    console.log('plugin lifecycle regressions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
