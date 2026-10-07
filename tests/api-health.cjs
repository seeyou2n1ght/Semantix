const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

let body = { status: 'ok' };
const source = fs.readFileSync(path.join(__dirname, '../src/api/client.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const apiExports = {};
vm.runInNewContext(code, {
    exports: apiExports,
    require(name) {
        if (name === 'obsidian') return { requestUrl: async () => ({ status: 200, json: body }) };
        return {};
    },
    window: { setTimeout() {} }
});

(async () => {
    const client = new apiExports.ApiClient({ backendUrl: 'http://127.0.0.1:8000', apiToken: '' }, 'vault');
    assert.equal(await client.checkFullHealth(), apiExports.HealthStatus.CONFLICT);
    body = { status: 'ok', engine_version: '0.9.3', api_version: '1' };
    assert.equal(await client.checkFullHealth(), apiExports.HealthStatus.READY);
    body = { status: 'loading', engine_version: '0.11.2', api_version: '1' };
    assert.equal(await client.checkFullHealth(), apiExports.HealthStatus.LOADING);
    body = { status: 'error', engine_version: '0.11.2', api_version: '1', message: 'Model load failed' };
    assert.equal(await client.checkFullHealth(), apiExports.HealthStatus.ERROR);
    assert.equal(client.lastHealthResponse.message, 'Model load failed');
    assert.equal(await client.checkHealth(), false);
    console.log('health identity check passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
