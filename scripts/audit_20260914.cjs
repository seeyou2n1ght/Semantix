/* Acceptance test suite validating ResultStabilizer lifecycle & exclusivity, Sync queue, API scoping, Context tags, Whisperer race protection, Service probe, and Truthful indexing status.
 * Run: node scripts/audit_20260914.cjs
 * Real TS is transpiled in memory; Obsidian, network, timers and processes are mocked.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('../node_modules/typescript');
const root = path.resolve(__dirname, '../src');
const notices = [];
class TFile { constructor(p) { this.path = p; this.extension = 'md'; this.basename = 'a'; } }
const obsidian = { TFile, Plugin: class {}, MarkdownView: class {}, Platform: { isDesktop: true },
  Notice: class { constructor(message) { notices.push(message); } hide() {} setMessage() {} },
  debounce: fn => fn };
const context = { window: { setTimeout: () => 1, clearTimeout() {}, requestIdleCallback: fn => fn() },
  setTimeout: () => 1, console: { log() {}, debug() {}, warn() {}, error() {} } };
function load(relative, mocks = {}) {
  const filename = path.resolve(root, relative);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true
  }}).outputText;
  const exports = {};
  const localRequire = name => {
    if (name in mocks) return mocks[name];
    if (name === 'obsidian') return obsidian;
    if (name === 'picomatch') return require('../node_modules/picomatch');
    if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), name + '.ts')), mocks);
    throw Error('Unexpected runtime dependency: ' + name);
  };
  vm.runInNewContext('(function(require,exports){' + js + '\n})', context)(localRequire, exports);
  return exports;
}
(async () => {
  const results = {};
  const { ResultStabilizer } = load('core/result-stabilizer.ts');
  const card = (id, score) => ({ id, path: id, title: id, snippet: 'text', score, labels: [] });
  const stable = new ResultStabilizer();
  stable.stabilize([card('A', .9)], [card('B', .8)], 'NEW_FILE');
  stable.stabilize([card('B', .9)], [card('C', .8)], 'SAME_PARAGRAPH');
  // Young Related A is retained; force its age to test that expired card is replaced.
  stable.relatedCards[0].enteredAt = 0;
  stable.discoverCards[0].enteredAt = 0;
  const old = stable.stabilize([card('C', .7)], [card('D', .6)], 'SAME_PARAGRAPH');
  assert.equal(old.related[0].id, 'C');
  results.expired_card_replaced_by_incoming = old.related[0].id;
  const cross = new ResultStabilizer();
  cross.stabilize([card('A', .5)], [card('B', .8)], 'NEW_FILE');
  cross.relatedCards[0].enteredAt = 0;
  const dup = cross.stabilize([card('B', .9)], [card('C', .7)], 'SAME_PARAGRAPH');
  assert.notEqual(dup.related[0].id, dup.discover[0].id);
  results.streams_are_mutually_exclusive = { related: dup.related.map(r => r.id), discover: dup.discover.map(d => d.id) };

  const { SyncManager } = load('core/sync.ts');
  const file = new TFile('a.md');
  let sync;
  const plugin = { settings: { syncBatchInterval: 60 }, vaultId: 'v', app: { vault: {
    getAbstractFileByPath: () => file, cachedRead: async () => 'old content'
  }}, getFileContext: () => ({tags: [], links: []}), getIndexingState: () => ({ active: false }),
  updateIndexingProgress() {}, clearIndexingProgress() {}, checkConnection() {}, apiClient: {
    indexBatch: async () => { sync.queueUpdate(file); return {status: 'success'}; }
  }};
  sync = new SyncManager(plugin);
  sync.queueUpdate(file);
  await sync.flushQueue();
  assert.equal(sync.pendingUpdates.size, 1);
  results.edit_during_request_safely_retained = true;

  const urls = [];
  obsidian.requestUrl = async req => { urls.push(req.url); return {status: 200, json: {confirmation_token: 'mock'}}; };
  const { ApiClient } = load('api/client.ts');
  await new ApiClient({backendUrl: 'http://mock'}, 'current-vault').clearIndex();
  assert(urls[0].includes('vault_id=current-vault'));
  results.clear_client_properly_scoped = urls[0];

  const { ContextEngine } = load('core/context.ts');
  const snapshot = new ContextEngine().captureNoteSnapshot({file, editor: {getValue: () => 'some text'}, app: {
    metadataCache: {getFileCache: () => ({ tags: [{tag: '#ai'}], frontmatter: {tags: ['yaml-tag']} }), resolvedLinks: {}}
  }});
  assert.equal(snapshot.context.tags.join(','), 'ai,yaml-tag');
  results.query_tags_normalize_hash_and_include_frontmatter = snapshot.context.tags;

  const { Whisperer } = load('core/whisperer.ts', {
    '@codemirror/view': {}, '../ui/whisperer-view': {}
  });
  let resolveResponse;
  const whisperer = new Whisperer({settings: {}, vaultId: 'v',
    getConnectionStatus: () => 'connected', apiClient: {
      radarSearch: () => new Promise(resolve => { resolveResponse = resolve; })
    }});
  whisperer.showLoading = () => {};
  whisperer.clearLoading = () => {};
  let renderCount = 0;
  whisperer.renderResults = () => { renderCount++; };
  const pending = whisperer.executeRadarSearch(snapshot);
  whisperer.onFileOpen(new TFile('empty-new-file.md'));
  resolveResponse({context_id: 'wrong-context', related: [], discover: []});
  await pending;
  assert.equal(renderCount, 0);
  results.stale_request_discarded_after_file_switch = true;

  const { default: Plugin } = load('main.ts', {
    './settings': {}, './api/client': {}, './ui/whisperer-view': {}, './core/sync': {},
    './core/whisperer': {}, './core/service-manager': {}, './i18n/helpers': {t: key => key}
  });
  const main = new Plugin();
  let healthCalls = 0;
  main.settings = {backendMode: 'local', autoStartServer: false};
  main.serviceManager = {isActivating: () => false, isUserStopped: () => false, onHealthyStable: () => {}};
  main.updateAllViewStatus = status => { main.status = status; };
  main.app = { workspace: { getLeavesOfType: () => [] } };
  main.apiClient = {
    checkHealth: async () => { healthCalls++; return true; },
    ping: () => {},
    getIndexStatus: async () => ({total_notes: 1, last_updated: 'now'})
  };
  await main.checkConnection();
  assert.equal(main.status, 'connected');
  assert.equal(healthCalls, 1);
  results.externally_started_local_engine_successfully_probed = true;

  const commands = [];
  obsidian.Platform.isWin = true;
  const { ServiceManager } = load('core/service-manager.ts', {
    '../utils/node-adapter': {getElectronNodeModule: name => ({
      child_process: {execSync: command => {
        commands.push(command);
        if (command.includes('wmic')) return 'python.exe -m uvicorn main:app --app-dir engine';
        return '';
      }, exec: (_command, callback) => callback(null, '', '')},
      fs: {existsSync: () => true, readFileSync: () => '{"pid":4242,"parent_pid":111,"started_at":"old"}', unlinkSync() {}},
      path: {join: (...parts) => parts.join('/')}
    })[name]}
  });
  await new ServiceManager({settings: {backendPath: '/mock', backendUrl: 'http://localhost:8000'}}).killPortConflict();
  assert(commands.some(cmd => cmd.includes('wmic process where processid=4242')));
  assert(commands.some(cmd => cmd.includes('taskkill') && cmd.includes('4242')));
  results.pid_ownership_verified_before_kill = true;

  main.app = {
    workspace: { getLeavesOfType: () => [] },
    vault: { getMarkdownFiles: () => [file], cachedRead: async () => 'some text' }
  };
  main.syncManager = {isExcludedPath: () => false, pause: async () => {}, resume: () => {}};
  main.getFileContext = () => ({tags: [], links: []});
  main.updateIndexingProgress = () => {};
  main.clearIndexingProgress = () => {};
  main.checkConnection = async () => {};
  main.apiClient.indexBatch = async () => ({status: 'success', indexed: 0, failed_paths: ['a.md']});
  main.apiClient.rebuildFtsIndex = async () => false;
  await main.startFullIndexing({skipConfirm: true});
  assert(notices.some(message => message.includes('部分完成') && message.includes('失败 1 篇')));
  assert(!notices.some(message => message.includes('全量索引完成 ✅ (共 1 篇笔记，全文索引已就绪)')));
  results.truthful_indexing_failure_reported = true;
  console.log(JSON.stringify(results, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
