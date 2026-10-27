const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const ts = require('typescript');

let spawned;
let commands = [];
let groupKill;
let netModule;
let now = 1_000_000;
let nextTimer = 0;
const timers = new Map();
const notices = [];
const child = {
    pid: 12345,
    stdout: { on() {} },
    stderr: { on() {} },
    on() {},
    kill() { return true; }
};
const cp = {
    spawn(command, args, options) { spawned = { command, args, options }; return child; },
    execFileSync(file, args, options) { commands.push({ file, args: Array.from(args), options: { ...options } }); return Buffer.from(''); }
};
const modules = {
    obsidian: { Platform: { isDesktop: true, isWin: true }, Notice: class { constructor(message) { notices.push(message); } } },
    '../api/client': { HealthStatus: { READY: 'ready', LOADING: 'loading', ERROR: 'error', NONE: 'none' } },
    '../utils/node-adapter': {
        getElectronNodeModule(name) { return { child_process: cp,
            fs: { existsSync: file => file === path.join(__dirname, '../engine/.venv/Scripts/python.exe') },
            path, net: netModule,
            process: { kill(pid, signal) { groupKill = { pid, signal }; } } }[name]; },
        getElectronProcess() { return { pid: 99, env: {} }; }
    }
};
const source = fs.readFileSync(path.join(__dirname, '../src/core/service-manager.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const serviceExports = {};
vm.runInNewContext(code, {
    exports: serviceExports,
    require(name) { return modules[name] || {}; },
    window: {
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); }
    },
    console,
    URL,
    Date: { now: () => now }
});

async function fireTimer(delay) {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `expected a ${delay}ms timer`);
    timers.delete(entry[0]);
    entry[1].callback();
    await new Promise(resolve => setImmediate(resolve));
}

(async () => {
    const engine = path.join(__dirname, '../engine');
    const plugin = {
        settings: { backendMode: 'local', autoStartServer: true, backendPath: engine,
            backendUrl: 'http://localhost:8000', pythonPath: 'uv' },
        apiClient: { async checkFullHealth() { return 'none'; } },
        resetStartupNotice() {}, updateAllViewStatus() {}, checkConnection() {}
    };
    const manager = new serviceExports.ServiceManager(plugin);
    await manager.start();
    assert.equal(spawned.command, path.join(engine, '.venv/Scripts/python.exe'));
    assert.deepEqual(Array.from(spawned.args.slice(0, 3)), ['-m', 'uvicorn', 'main:app']);
    assert.equal(spawned.options.shell, false);
    assert.equal(spawned.options.windowsHide, true);
    manager.stop();
    assert.deepEqual(commands, [{ file: 'taskkill', args: ['/F', '/T', '/PID', '12345'], options: { shell: false, windowsHide: true } }]);
    let finishHealth;
    plugin.apiClient.checkFullHealth = () => new Promise(resolve => { finishHealth = resolve; });
    spawned = null;
    const pending = manager.start();
    manager.stop();
    finishHealth('none');
    await pending;
    assert.equal(spawned, null, 'shutdown during health check must not spawn');
    modules.obsidian.Platform.isWin = false;
    plugin.apiClient.checkFullHealth = async () => 'none';
    await manager.start();
    assert.equal(spawned.options.detached, true);
    manager.stop();
    assert.equal(groupKill.pid, -12345);
    assert.equal(groupKill.signal, 'SIGTERM');
    modules.obsidian.Platform.isWin = true;
    netModule = net;
    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const occupiedPort = blocker.address().port;
    plugin.settings.backendUrl = `http://127.0.0.1:${occupiedPort}`;
    let savedUrl;
    plugin.saveSettings = async () => { savedUrl = plugin.settings.backendUrl; };
    await manager.start();
    assert.notEqual(new URL(savedUrl).port, String(occupiedPort));
    assert.deepEqual(Array.from(spawned.args.slice(-2)), ['--port', new URL(savedUrl).port]);
    manager.stop();
    await new Promise(resolve => blocker.close(resolve));

    // Only address-in-use errors may select another port or persist a new URL.
    for (const error of [Object.assign(new Error('port denied'), { code: 'EACCES' }), 'port probe failed']) {
        let onError;
        netModule = { createServer: () => ({
            once(event, listener) { onError = listener; },
            listen() { onError(error); }
        }) };
        spawned = null;
        savedUrl = undefined;
        const statuses = [];
        manager.setStatusConsumer(message => statuses.push(message));
        await manager.start({ force: true });
        assert.equal(spawned, null);
        assert.equal(savedUrl, undefined);
        assert.ok(statuses.some(message => message.includes('启动失败')));
    }
    spawned = null;
    const commandCount = commands.length;
    plugin.apiClient.checkFullHealth = async () => 'error';
    plugin.apiClient.lastHealthResponse = { status: 'error', message: 'Controlled model load failure' };
    await manager.start({ force: true });
    assert.equal(spawned, null, 'a failed live engine must not spawn a duplicate');
    assert.equal(commands.length, commandCount, 'an initialization failure must not kill an external process');
    assert.equal(manager.getLastStatus(), 'Controlled model load failure');
    assert.equal(manager.isActivating(), false);

    // Persistent failure must stay suspended even after the old two-minute reset window.
    timers.clear();
    notices.length = 0;
    netModule = undefined;
    plugin.apiClient.checkFullHealth = async () => 'none';
    const failing = new serviceExports.ServiceManager(plugin);
    let attempts = 0;
    failing.forceKillAndStart = async () => { attempts++; failing.triggerSelfHealing('controlled startup failure'); };
    failing.triggerSelfHealing('offline');
    for (const delay of [3000, 6000, 15000]) {
        now += 180_000;
        await fireTimer(delay);
    }
    assert.equal(attempts, 3);
    assert.equal(notices.length, 1, 'suspension should notify only once');
    for (let i = 0; i < 20; i++) {
        now += 180_000;
        failing.triggerSelfHealing('continued heartbeat failure');
    }
    assert.equal(timers.size, 0, 'elapsed time must not re-arm a failed engine');
    assert.equal(notices.length, 1, 'continued offline heartbeats must remain quiet');
    failing.resetHealing();
    failing.triggerSelfHealing('manual retry');
    assert.equal(timers.size, 1, 'manual reset allows a new bounded attempt');
    failing.onHealthyStable();
    assert.equal(timers.size, 0, 'recovery cancels a pending restart');
    failing.triggerSelfHealing('new outage');
    await fireTimer(3000);
    assert.equal(attempts, 4, 'a recovered engine can heal a later outage');
    failing.setUserIntentStopped(true);
    assert.equal(timers.size, 0);
    failing.triggerSelfHealing('stopped');
    assert.equal(timers.size, 0);

    // A stop while the retry health request is pending must not launch a process.
    const pendingHeal = new serviceExports.ServiceManager(plugin);
    let resolveHeal;
    plugin.apiClient.checkFullHealth = () => new Promise(resolve => { resolveHeal = resolve; });
    let restarted = false;
    pendingHeal.forceKillAndStart = async () => { restarted = true; };
    pendingHeal.triggerSelfHealing('offline');
    await fireTimer(3000);
    pendingHeal.stop();
    resolveHeal('none');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(restarted, false);

    // Shutdown during the release delay must invalidate the queued restart too.
    const delayed = new serviceExports.ServiceManager(plugin);
    delayed.start = async () => { restarted = true; };
    const restart = delayed.forceKillAndStart({ isHeal: true });
    delayed.stop();
    await fireTimer(1000);
    await restart;
    assert.equal(restarted, false);

    // Explicit restart overrides an earlier stop, but a new stop during its wait wins.
    delayed.setUserIntentStopped(true);
    const manualRestart = delayed.forceKillAndStart();
    await fireTimer(1000);
    await manualRestart;
    assert.equal(restarted, true, 'explicit restart after stop must remain available');
    assert.equal(delayed.isUserStopped(), false);
    restarted = false;
    const canceledManualRestart = delayed.forceKillAndStart();
    delayed.setUserIntentStopped(true);
    delayed.stop();
    await fireTimer(1000);
    await canceledManualRestart;
    assert.equal(restarted, false, 'a later stop must cancel an explicit restart in flight');
    console.log('service manager startup, failed-model state and owned-process stop passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
