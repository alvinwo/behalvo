import test from 'node:test';import assert from 'node:assert/strict';
import { parseCliArgs } from '../dist/cli/main.js';
import { displayBrowserActions, handleBrowserCommand, reviewBrowserGesture } from '../dist/cli/browser-commands.js';
import { fixture, createWork, message } from './helpers.mjs';
test('legacy allow command explains public access without changing network authority',async t=>{
 const f=await fixture(t);createWork(f);const output=[];
 await handleBrowserCommand('/browser allow https://assets.test',{store:f.store,controller:{},scope:{workspaceId:'personal',ownerId:'owner',threadId:'im',workId:'w'},io:{interactive:true,write:line=>output.push(line)}});
 assert.match(output.join('\n'),/public HTTPS.*already|public HTTPS.*no longer/i);
 assert.equal(f.store.journal('personal').filter(r=>r.event.type==='message.received').length,0);
 for(const origin of ['http://example.test','https://127.0.0.1','https://assets.test/path','https://assets.test/','https://u:p@assets.test']){
  await handleBrowserCommand(`/browser allow ${origin}`,{store:f.store,controller:{},scope:{workspaceId:'personal',ownerId:'owner',threadId:'im',workId:'w'},io:{interactive:true,write:line=>output.push(line)}});
  assert.doesNotMatch(output.at(-1),/already load/i);
 }
});
test('live browser CLI is explicit and rejects fixtures, offline and public boundary overrides',()=>{
 assert.equal(parseCliArgs(['--browser','live']).liveBrowser,true);
 for(const args of [['--browser','remote'],['--browser','live','--offline'],['--browser','live','--synthetic-browser','classes'],['--browser','live','--synthetic-operations'],['--browser','live','--proxy','http://127.0.0.1:1'],['--browser','live','--ignore-https-errors'],['--browser','live','--browser','live']])assert.throws(()=>parseCliArgs(args));
});
test('trusted browser commands preserve exact text and scope; no command text becomes a model call',async t=>{
 const f=await fixture(t);createWork(f);const calls=[],output=[];const controller={async open(binding,url){calls.push(['open',binding,url]);},input(binding,ref,value){calls.push(['input',binding,ref,value]);return 'input-id';},status(){return{state:'idle'};},async handoff(){calls.push(['handoff']);},async resume(){calls.push(['resume']);},async close(){return{confirmed:true};}};
 const options={store:f.store,controller,scope:{workspaceId:'personal',ownerId:'owner',threadId:'im',workId:'w'},io:{interactive:true,discardSensitiveInput(){},readLine:async()=> 'resume',write:line=>output.push(line)}};
 for(const line of ['/browser open https://example.test/path','/browser input field-ref Cedar and Pine','/browser status','/browser allow https://assets.test','/browser handoff','/browser resume','/browser close'])assert.equal(await handleBrowserCommand(line,options),true);
 assert.equal(calls[0][2],'https://example.test/path');assert.equal(calls[1][3],'Cedar and Pine');assert.equal(calls[1][1].threadId,'im');assert.ok(calls.some(c=>c[0]==='resume'));
 const count=calls.length;await handleBrowserCommand('/browser open https://example.test/',{...options,io:{...options.io,interactive:false}});assert.equal(calls.length,count);assert.match(output.at(-1),/interactive/i);
 await handleBrowserCommand('/browser input missing value',{...options,scope:{...options.scope,workId:undefined}});assert.equal(calls.length,count);
});
test('gesture review requires a fresh interactive answer, exact display, and refuses cancellation',async()=>{
 const output=[];let drains=0;const io={interactive:true,discardSensitiveInput(){drains++;},readLine:async()=> 'approve',write:line=>output.push(line)};
 const action={id:'a',workId:'work',workRevision:2,digest:'digest'};const detail={operation:'fill',origin:'https://example.test',name:'Search',value:'Cedar'};
 assert.equal(await reviewBrowserGesture(io,action,detail),'approve');assert.equal(drains,2);assert.match(output.join('\n'),/Cedar/);assert.match(output.join('\n'),/example.test/);
 assert.equal(await reviewBrowserGesture({...io,interactive:false},action,detail),'reject');
 const abort=new AbortController();abort.abort();assert.equal(await reviewBrowserGesture(io,action,detail,abort.signal),'reject');
});
test('failed trusted commands settle their source once without leaving processable owner messages',async t=>{
 const f=await fixture(t);createWork(f);const output=[];const options={store:f.store,scope:{workspaceId:'personal',ownerId:'owner',threadId:'im',workId:'w'},io:{interactive:true,write:line=>output.push(line)},controller:{async open(){throw new Error('Invalid URL or unknown launch');},input(){throw new Error('Stale field');}}};
 for(const command of ['/browser open http://localhost/','/browser open https://example.test/','/browser input missing Cedar'])await handleBrowserCommand(command,options);
 const sources=f.store.journal('personal').filter(r=>r.event.type==='message.received'&&r.event.data.source==='owner:managed-browser');assert.equal(sources.length,3);
 assert.ok(sources.every(r=>!f.store.inbox('personal').some(i=>i.id===r.id)));
 const handled=f.store.journal('personal').filter(r=>r.event.type==='inbox.handled');for(const source of sources)assert.equal(handled.filter(r=>r.event.data.recordId===source.id).length,1);
});
test('action inspection displays fixed failure diagnostics alongside authority and evidence',async t=>{
 const f=await fixture(t);createWork(f);const owner=f.store.ingest('personal',message('trace'));
 const {BrowserActionBroker}=await import('../dist/runtime/browser-actions.js'),{BrowserNoDispatchError}=await import('../dist/browser/live-failure.js');
 const command={kind:'browser.gesture',version:2,authority:'navigation_policy_v1',operation:'interact',threadId:'im',sessionId:'s',generation:1,grantRevision:1,origin:'https://example.test',documentId:'doc',controlFingerprint:'a'.repeat(64),destination:'https://example.test/catalog',gesture:{kind:'navigate',observationId:'obs',ref:'ref'}};
 await new BrowserActionBroker(f.store).perform({workspaceId:'personal',ownerId:'owner',workId:'w',ownerRecordId:owner.id,expectedWorkRevision:1},command,{deadline:Date.now()+5000},{review:async()=> 'approve',validate:async()=>{},dispatch:async mark=>{mark();throw new BrowserNoDispatchError({status:'not_dispatched',code:'control_covered'});}});
 const output=[];displayBrowserActions(f.store,{workspaceId:'personal',ownerId:'owner',threadId:'im',workId:'w'},line=>output.push(JSON.parse(line)));
 assert.deepEqual(output[0].diagnostic,{phase:'validation',code:'control_covered'});assert.equal(output[0].command.authority,'navigation_policy_v1');assert.ok(output[0].evidenceRef);
});
