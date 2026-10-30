const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

let body = { status: 'ok' };
let delayedRequest = null;
const source = fs.readFileSync(path.join(__dirname, '../src/api/client.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const apiExports = {};
vm.runInNewContext(code, {
    exports: apiExports,
    require(name) {
        if (name === 'obsidian') return { requestUrl: async () => delayedRequest || ({ status: 200, json: body }) };
        return {};
    },
    window: { setTimeout() {} }
});

(async () => {
    const client = new apiExports.ApiClient({ backendUrl: 'http://127.0.0.1:8000', apiToken: '' }, 'vault');
    assert.equal(await client.checkFullHealth(), apiExports.HealthStatus.CONFLICT);
    body = { status: 'ok', engine_version: '0.9.3', api_version: '1' };
    assert.equal(await client.checkFullHealth(), apiExports.HealthStatus.READY);
    body = { status: 'ok', engine_version: '0.11.4', api_version: '1', reranker_model: 'BAAI/bge-reranker-v2-m3', reranker_status: 'error', message: 'Semantic retrieval is ready; reranker is error.' };
    assert.equal(await client.checkFullHealth(), apiExports.HealthStatus.READY);
    assert.equal(client.lastHealthResponse.reranker_status, 'error');
    body = { status: 'loading', engine_version: '0.11.2', api_version: '1' };
    assert.equal(await client.checkFullHealth(), apiExports.HealthStatus.LOADING);
    body = { status: 'error', engine_version: '0.11.2', api_version: '1', message: 'Model load failed' };
    assert.equal(await client.checkFullHealth(), apiExports.HealthStatus.ERROR);
    assert.equal(client.lastHealthResponse.message, 'Model load failed');
    assert.equal(await client.checkHealth(), false);
    let resolveOld;
    delayedRequest = new Promise(resolve => { resolveOld = resolve; });
    const oldHealth = client.checkFullHealth();
    client.updateSettings({ backendUrl: 'http://127.0.0.1:8001', apiToken: '' }, 'vault');
    delayedRequest = null;
    body = { status: 'ok', engine_version: 'new', api_version: '1', capabilities: [] };
    assert.equal(await client.checkFullHealth(), apiExports.HealthStatus.READY);
    resolveOld({ status: 200, json: { status: 'ok', engine_version: 'old', api_version: '1', capabilities: ['adaptive_lexical_soft_discount'] } });
    assert.equal(await oldHealth, apiExports.HealthStatus.NONE);
    assert.equal(client.lastHealthResponse.engine_version, 'new');
    assert.equal(client.supportsAdaptiveSoftFiltering(), false);
    let rejectOld;
    delayedRequest = new Promise((_resolve, reject) => { rejectOld = reject; });
    const oldFailure = client.checkFullHealth();
    client.updateSettings({ backendUrl: 'http://127.0.0.1:8002', apiToken: '' }, 'vault');
    delayedRequest = null;
    body = { status: 'ok', engine_version: 'newer', api_version: '1', capabilities: ['adaptive_lexical_soft_discount'] };
    assert.equal(await client.checkFullHealth(), apiExports.HealthStatus.READY);
    rejectOld(new Error('old endpoint failed late'));
    assert.equal(await oldFailure, apiExports.HealthStatus.NONE);
    assert.equal(client.lastHealthResponse.engine_version, 'newer');
    assert.equal(client.supportsAdaptiveSoftFiltering(), true, 'old rejection cannot clear the current capability');
    let resolveSameEndpoint;
    delayedRequest = new Promise(resolve => { resolveSameEndpoint = resolve; });
    const olderHealth = client.checkFullHealth();
    delayedRequest = null;
    body = { status: 'ok', engine_version: 'current', api_version: '1', capabilities: ['adaptive_lexical_soft_discount'] };
    assert.equal(await client.checkFullHealth(), apiExports.HealthStatus.READY);
    resolveSameEndpoint({ status: 200, json: { status: 'loading', engine_version: 'stale', api_version: '1' } });
    assert.equal(await olderHealth, apiExports.HealthStatus.NONE);
    assert.equal(client.lastHealthResponse.engine_version, 'current', 'older health cannot overwrite same-endpoint capability');
    body = { vault_id: 'other', paths: ['private.md'] };
    assert.equal(await client.getIndexedPaths(), null, 'wrong Vault inventory is rejected');
    body = { vault_id: 'vault', paths: [17] };
    assert.equal(await client.getIndexedPaths(), null, 'non-string paths are rejected');
    body = { vault_id: 'vault', paths: ['a.md', 'a.md'] };
    assert.deepEqual(Array.from(await client.getIndexedPaths()), ['a.md']);
    let resolveInventory;
    delayedRequest = new Promise(resolve => { resolveInventory = resolve; });
    const oldInventory = client.getIndexedPaths();
    client.updateSettings({ backendUrl: 'http://new-engine:9000', apiToken: '' }, 'vault');
    delayedRequest = null;
    resolveInventory({status: 200, json: {vault_id: 'vault', paths: ['stale.md']}});
    assert.equal(await oldInventory, null, 'late previous endpoint inventory is rejected');
    console.log('health identity check passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
