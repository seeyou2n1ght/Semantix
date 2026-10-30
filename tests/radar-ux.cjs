const assert = require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const timers=new Map();let timerId=0;
class MarkdownView {}
class TFile {}
class RadarView {constructor(){this.rendered=[];this.insufficient=0;}showLoading(){}clearLoading(){}resetForContext(){}showInsufficientContext(){this.insufficient++;}renderRadarResults(...args){this.rendered.push(args);}showScanCancelled(){} }
function load(file,modules={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,require:n=>modules[n]||{},console,window:{setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);}}});return exports;}
const obsidian={MarkdownView,TFile,debounce:fn=>{const callback=()=>fn();callback.cancel=()=>{};return callback;}};
const ContextEngine=load('src/core/context.ts',{'../utils/markdown':load('src/utils/markdown.ts')}).ContextEngine;
const Radar=load('src/core/radar.ts',{obsidian,'@codemirror/view':{},'../ui/radar-view':{RadarView,RADAR_VIEW_TYPE:'radar'},'./context':{ContextEngine},'./query-gate':load('src/core/query-gate.ts'),'./result-stabilizer':load('src/core/result-stabilizer.ts'),'./note-scan':load('src/core/note-scan.ts')}).RadarEngine;
(async()=>{
 const sidebar=new RadarView(),view=new MarkdownView();view.file={path:'current.md',extension:'md',basename:'current'};
 let line=0,text='First meaningful sentence';
 view.app={metadataCache:{getFileCache:()=>null,resolvedLinks:{}}};
 view.editor={getSelection:()=>'',getCursor:()=>({line,ch:0}),getLine:l=>l===line?text:'',lineCount:()=>line+1,getValue:()=>text};
 const requests=[];
 const plugin={settings:{autoTrigger:false,debounceDelay:400,topNResults:4,rankingMode:'fast'},vaultId:'v',getConnectionStatus:()=> 'connected',getExcludedPathsForQuery:()=>[],getExclusionMatcher:()=>({isExcluded:path=>path.startsWith('Private/')}),isAdaptiveFilteringEffective:()=>false,app:{vault:{getAbstractFileByPath:path=>path==='deleted.md'?null:new TFile()},workspace:{getActiveViewOfType:()=>view,getLeavesOfType:type=>type==='radar'?[{view:sidebar}]:[{view}]}},apiClient:{radarSearch:async request=>{requests.push(request);return {context_id:request.context_id,related:[{path:'Private/old.md'},{path:'public.md'},{path:'deleted.md'}],discover:[]};}}};
 const radar=new Radar(plugin);
 await radar.handleFocusTrigger(true);assert.equal(requests.length,1,'file switch remains automatic');
 assert.deepEqual(Array.from(sidebar.rendered.at(-1)[0],item=>item.path),['public.md'],'excluded and physically missing paths are filtered at render');
 line=1;text='A different paragraph';radar.onCursorActivity();radar.onEditorChange(view.editor,view);await radar.handleFocusTrigger();assert.equal(requests.length,1,'auto off blocks cursor, selection and edit regardless of context jump');
 await radar.triggerFocusScan();assert.equal(requests.length,2,'explicit focus scan remains available');
 plugin.settings.autoTrigger=true;text='';await radar.handleFocusTrigger(true);assert.equal(sidebar.insufficient,1);assert.equal(requests.length,2,'insufficient text never reaches engine');
 text='Captured excerpt for the current line';const snapshot=radar.contextEngine.captureFocusSnapshot(view.editor,view);assert.equal(snapshot.rawExcerpt,text);assert.equal(snapshot.isTooShort,false);
 radar.activeSearch={scope:'note',id:10};radar.lastRenderedScope='focus';radar.invalidateForSettingsChange();radar.invalidateForSettingsChange();assert.equal(radar.refreshScopeAfterSettingsChange,'note','repeated changes retain interrupted whole-note scope');
 // DOM-level source excerpt and subset exclusion cache invalidation use the real view implementation.
 const ActualView=load('src/ui/radar-view.ts',{obsidian:{ItemView:class{}},'./popover-preview':{PopoverPreview:class{}},'../i18n/helpers':{t:key=>key}}).RadarView;
 const actual=Object.create(ActualView.prototype);const attrs={};actual.contextSourceEl={setAttribute(k,v){attrs[k]=v;},removeAttribute(k){delete attrs[k];},setText(){},toggleClass(){}};
 actual.updateContextBreadcrumb('current.md','Heading','line',text);assert(attrs.title.includes(text));assert(attrs['aria-label'].includes(text));
 console.log('radar UX: auto-off semantics, explicit/file scans, empty context, captured excerpt, render exclusions and repeated settings scope passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
