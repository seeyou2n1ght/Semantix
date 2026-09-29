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
    obsidian: { Platform: { isDesktop: true, isWin: true }, Notice: class {} },
    '../api/client': { HealthStatus: { READY: 'ready', LOADING: 'loading', NONE: 'none' } },
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
    window: { setTimeout() { return 1; }, clearTimeout() {} },
    console,
    URL,
    Date
});

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
    console.log('service manager startup and owned-process stop passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
