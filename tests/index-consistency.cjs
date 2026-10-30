const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
class TFile { constructor(path, mtime = 1) { this.path = path; this.extension = 'md'; this.stat = {mtime, size:10}; } }
class TFolder {}
class RadarView { filterExcludedCards(predicate) { this.deleted = ['a.md', 'keep.md'].filter(predicate); } }
const notices = [];
const diagnostics = [];
const timers = new Map(); let nextTimer = 0;
const fakeWindow = {setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout(id) {timers.delete(id);}, requestIdleCallback(fn) {fn();}};
const obsidian = {Plugin:class {}, Modal:class {}, TFile,TFolder, Notice:class {constructor(text){notices.push(text);}}, Platform:{isDesktop:true}};
function load(file, modules = {}) {
 const exports = {};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,
 {exports,require:n=>modules[n]||{},window:fakeWindow,console:{...console,error(...args){diagnostics.push(args);},warn(...args){diagnostics.push(args);}}});
 return exports;
}
const exclusion = load('src/core/exclusion.ts', {picomatch:require('picomatch')});
const batch = load('src/core/index-batch.ts', {'../utils/markdown':load('src/utils/markdown.ts')});
const defaults = {backendMode:'local',backendUrl:'http://localhost:8000',apiToken:'',dbRetentionDays:7,exclusionRules:'',syncBatchInterval:60,autoTrigger:true};
const Semantix = load('src/main.ts', {obsidian,'./settings':{DEFAULT_SETTINGS:defaults},'./core/index-batch':batch,'./core/exclusion':exclusion,'./i18n/helpers':{t:key=>key},'./ui/radar-view':{RadarView,RADAR_VIEW_TYPE:'radar'}}).default;
const Sync = load('src/core/sync.ts', {obsidian,'./index-batch':batch,'./exclusion':exclusion}).SyncManager;
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture(paths=['a.md']) {
 const p = new Semantix();
 let data = null;
 p.settings = {...defaults}; p.vaultId='v';
 const files = paths.map(path=>new TFile(path));
 const indexed = new Map(paths.map(path=>[path,'old']));
 p.app = {vault:{getMarkdownFiles:()=>files,getAbstractFileByPath:path=>files.find(file=>file.path===path),cachedRead:async file=>'new '+file.path},workspace:{getLeavesOfType:()=>[]}};
 p.loadData=async()=>data; p.saveData=async value=>{data=JSON.parse(JSON.stringify(value));};
 p.getFileContext=()=>({tags:[],links:[]});
 p.checkConnection=async()=>{}; p.getConnectionStatus=()=> 'connected';
 p.updateIndexingProgress=()=>{};p.clearIndexingProgress=()=>{};
 p.radar={onFileOpen(){},invalidateForSettingsChange(){},cancelDebounceTimers(){},refreshCurrentScope:async()=>{}};
 p.apiClient={supportsIndexedPaths:()=>true,getIndexedPaths:async()=>[...indexed.keys()],checkHealth:async()=>true,
 indexBatch:async ({documents})=>{for(const doc of documents){if(doc.text)indexed.set(doc.path,doc.text);else indexed.delete(doc.path);}return {status:'success'};},
 indexDelete:async ({paths})=>{paths.forEach(path=>indexed.delete(path));return {status:'success'};},clearIndex:async()=>{indexed.clear();return true;},rebuildFtsIndex:async()=>true};
 p.syncManager=new Sync(p);p.syncManager.setConnectionReady(true);
 p.selectSignatureSnapshot();p.syncManager.setConnectionReady(true);
 return {p,files,indexed,getData:()=>data};
}
(async()=>{
 // Real picomatch semantics, including legacy directory prefixes.
 const matcher = new exclusion.ExclusionMatcher('Private/**\nArchive\none.md');
 assert(matcher.isExcluded('Private/a.md'));assert(matcher.isExcluded('Archive/nested/a.md'));assert(matcher.isExcluded('one.md'));
 assert.deepEqual(Array.from(matcher.expandToPaths(['Private/a.md','ok.md'])),['Private/a.md']);
 // Persisted records reload under their endpoint, and never leak to a second endpoint.
 const f=fixture();
 f.p.onPathsIndexed([{path:'a.md',text:'old',sourceSignature:{mtime:1,size:10}}]);await f.p.dataSave;
 const reloaded=fixture();reloaded.p.loadData=async()=>f.getData();await reloaded.p.loadSettings();
 assert.equal(reloaded.p.fileSignatures['a.md'].mtime,1);
 reloaded.p.settings.backendUrl='http://localhost:9000';reloaded.p.selectSignatureSnapshot();assert.equal(Object.keys(reloaded.p.fileSignatures).length,0);
 reloaded.p.settings.backendUrl=defaults.backendUrl;reloaded.p.selectSignatureSnapshot();assert.equal(reloaded.p.fileSignatures['a.md'].mtime,1);
 // Concurrent persistence commits stay ordered, and a rejected save remains visible.
 const saving=fixture();const firstSave=deferred();const committed=[];
 saving.p.saveData=async value=>{if(!committed.length)await firstSave.promise;committed.push(value);};
 saving.p.onPathsIndexed([{path:'a.md',text:'first',sourceSignature:{mtime:1,size:10}}]);
 await Promise.resolve();saving.p.onPathsIndexed([{path:'a.md',text:'second',sourceSignature:{mtime:2,size:20}}]);
 assert.equal(committed.length,0);firstSave.resolve();await saving.p.dataSave;
 assert.equal(committed.length,2);assert.equal(Object.values(committed.at(-1).indexSignatures)[0]['a.md'].mtime,2);
 saving.p.saveData=async()=>{throw new Error('controlled persistence failure');};
 saving.p.onPathsIndexed([{path:'a.md',text:'third',sourceSignature:{mtime:3,size:30}}]);
 await saving.p.dataSave.catch(()=>{});await Promise.resolve();assert.equal(saving.p.reconciliationStatus,'failed');
 // Ordinary offline edit, addition, deletion, and excluded stale path reconciliation.
 const r=fixture(['a.md','new.md']);r.indexed.delete('new.md');r.indexed.set('deleted.md','old');r.indexed.set('Private/old.md','old');
 r.p.fileSignatures['a.md']={mtime:0,size:10};r.p.settings.exclusionRules='Private/**';
 await r.p.reconcileVaultIndex();
 assert.equal(r.p.reconciliationStatus,'checked');assert.equal(r.p.syncManager.getPendingCount(),4);
 await r.p.syncManager.flushQueue();assert.equal(r.indexed.size,2);assert.equal(r.indexed.get('a.md'),'new a.md');
 // Inventory unavailable or stale response never authorizes deletions or writes.
 const unavailable=fixture();unavailable.p.apiClient.getIndexedPaths=async()=>null;await unavailable.p.reconcileVaultIndex();assert.equal(unavailable.p.reconciliationStatus,'failed');assert.equal(unavailable.p.syncManager.getPendingCount(),0);
 const old=fixture();const inventory=deferred();old.p.apiClient.getIndexedPaths=()=>inventory.promise;const recon=old.p.reconcileVaultIndex();await Promise.resolve();old.p.settings.backendUrl='http://new:9000';old.p.selectSignatureSnapshot();inventory.resolve(['old-only.md']);await recon;assert.equal(old.p.syncManager.getPendingCount(),0);assert.equal(old.p.reconciliationStatus,'unknown');
 const legacy=fixture();legacy.p.apiClient.supportsIndexedPaths=()=>false;await legacy.p.reconcileVaultIndex();assert.equal(legacy.p.reconciliationStatus,'unavailable');
 const deletedUI=fixture();const deletedView=new RadarView();deletedUI.p.app.workspace.getLeavesOfType=()=>[{view:deletedView}];deletedUI.p.onPathsDeleted(['a.md']);await deletedUI.p.dataSave;assert.deepEqual(deletedView.deleted,['a.md']);
 // Failed clear preserves queue; successful clear drops old work and preserves later edits.
 const clear=fixture();clear.p.syncManager.queueUpdate(clear.files[0]);clear.p.apiClient.clearIndex=async()=>false;assert.equal(await clear.p.clearVaultIndex(),false);assert.equal(clear.p.syncManager.getPendingCount(),1);
 clear.p.apiClient.clearIndex=async()=>{clear.p.syncManager.queueUpdate(clear.files[0]);return true;};assert.equal(await clear.p.clearVaultIndex(),true);assert.equal(clear.p.syncManager.getPendingCount(),1);
 // Clear waits for a live write and rejects concurrent rebuild/clear operations.
 const inflight=fixture();const write=deferred();let clearCalls=0;inflight.p.apiClient.indexBatch=()=>write.promise;inflight.p.apiClient.clearIndex=async()=>{clearCalls++;return true;};
 inflight.p.syncManager.queueUpdate(inflight.files[0]);const flushing=inflight.p.syncManager.flushQueue();await Promise.resolve();await Promise.resolve();
 const clearing=inflight.p.clearVaultIndex();assert.equal(clearCalls,0);assert.equal(await inflight.p.clearVaultIndex(),false);write.resolve({status:'success'});await flushing;assert.equal(await clearing,true);assert.equal(clearCalls,1);
 // Successful acknowledgment records the submitted signature, not an intervening edit.
 const edit=fixture();edit.p.apiClient.indexBatch=async()=>{edit.files[0].stat={mtime:2,size:20};edit.p.syncManager.queueUpdate(edit.files[0]);return {status:'success'};};
 edit.p.syncManager.queueUpdate(edit.files[0]);await edit.p.syncManager.flushQueue();assert.equal(edit.p.fileSignatures['a.md'].mtime,1);assert.equal(edit.p.syncManager.getPendingCount(),1);
 // Old endpoint success cannot acknowledge work pending on the current connection.
 const change=fixture();change.p.apiClient.indexBatch=async()=>{change.p.settings.backendUrl='http://other:9000';change.p.selectSignatureSnapshot();return {status:'success'};};change.p.syncManager.queueUpdate(change.files[0]);await change.p.syncManager.flushQueue();assert.equal(change.p.syncManager.getPendingCount(),1);assert.equal(Object.keys(change.p.fileSignatures).length,0);
 // A queued note excluded before submission is not read; rename into exclusions schedules old deletion.
 const excluded=fixture();let reads=0;excluded.p.app.vault.cachedRead=async()=>{reads++;return 'data';};excluded.p.syncManager.queueUpdate(excluded.files[0]);excluded.p.settings.exclusionRules='a.md';await excluded.p.syncManager.flushQueue();assert.equal(reads,0);
 excluded.p.settings.exclusionRules='Private/**';excluded.p.syncManager.queueRename(new TFile('Private/a.md'),'a.md');assert(excluded.p.syncManager.syncTimer!==null);
 // Full rebuild cleans even when every local note is excluded.
 const empty=fixture();empty.p.settings.exclusionRules='**/*.md';await empty.p.startFullIndexing({skipConfirm:true});assert.equal(empty.indexed.size,0);assert.equal(empty.p.reconciliationStatus,'checked');
 const partial=fixture(['a.md','bad.md']);partial.indexed.set('removed.md','old');partial.p.apiClient.indexBatch=async ({documents})=>{for(const d of documents)if(d.path!=='bad.md')partial.indexed.set(d.path,d.text);return {status:'success',failed_paths:['bad.md']};};await partial.p.startFullIndexing({skipConfirm:true});assert.equal(partial.indexed.get('bad.md'),'old');assert(!partial.indexed.has('removed.md'));assert.equal(partial.p.syncManager.getPendingCount(),1);
 const deletionFailure=fixture([]);deletionFailure.indexed.set('removed.md','old');deletionFailure.p.apiClient.indexDelete=async()=>null;await deletionFailure.p.startFullIndexing({skipConfirm:true});assert.equal(deletionFailure.p.reconciliationStatus,'failed');assert(deletionFailure.indexed.has('removed.md'));assert(diagnostics.some(args=>String(args[1]).includes('旧索引路径清理失败')));
 const cancelled=fixture();cancelled.indexed.set('removed.md','old');cancelled.p.app.vault.cachedRead=async()=>{cancelled.p.fullIndexCancelRequested=true;return 'new';};await cancelled.p.startFullIndexing({skipConfirm:true});assert(cancelled.indexed.has('removed.md'));assert.notEqual(cancelled.p.reconciliationStatus,'checked');
 // Coalesced settings input invalidates now but applies/refreshes once after the final timer.
 const settings=fixture();let invalidations=0,saves=0,refreshes=0;settings.p.radar.invalidateForSettingsChange=()=>invalidations++;settings.p.radar.refreshCurrentScope=async()=>refreshes++;settings.p.saveSettings=async()=>{saves++;};
 await settings.p.onSearchSettingChanged('topNResults');const timer1=settings.p.searchSettingsTimer;await settings.p.onSearchSettingChanged('mmrLambda');assert(!timers.has(timer1));assert.equal(invalidations,2);assert.equal(saves,0);timers.get(settings.p.searchSettingsTimer)();await Promise.resolve();await Promise.resolve();assert.equal(saves,1);assert.equal(refreshes,1);
 await Promise.all([f.p.dataSave,r.p.dataSave,clear.p.dataSave,inflight.p.dataSave,edit.p.dataSave,partial.p.dataSave,empty.p.dataSave]);
 console.log('index consistency: persisted endpoint scope, reconciliation, exclusions, clear/write races, signature revisions, rebuild failure/cancel and settings coalescing passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
