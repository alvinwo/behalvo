import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,createWork,message} from './helpers.mjs';
import {AgentService} from '../dist/runtime/agent-service.js';
import {OperationRegistry} from '../dist/operations/registry.js';import {OperationService} from '../dist/operations/service.js';
const model={provider:'fake',model:'synthetic'};
const input={workspaceId:'personal',ownerId:'owner',threadId:'im',workId:'w',externalId:'current',text:'Find the earlier date.',model};
const final={reply:'Recalled the source.',workProposals:[],factProposals:[]};
const recall={tool:{name:'recall',arguments:{query:'December',scope:'work',limit:5,beforeSeq:null}}};
function source(f){createWork(f);const r=f.store.ingest('personal',message('earlier',{text:'December is the synthetic preference.'}));f.store.append('personal',f.store.state('personal').version,[{type:'task.intake_recorded',data:{receipt:{ownerRecordId:r.id,threadId:'im',workId:'w',workRevisionAtIntake:1,outcome:'ready'}}}]);return r;}
for(const mode of ['plain','operations','browser'])test(`agent can recall then answer in ${mode} reasoning`,async t=>{
 const f=await fixture(t);const record=source(f);let calls=0,opens=0;
 f.store.ingest('personal',message('external',{senderId:'external',senderRole:'external',text:'EXTERNAL_UNATTRIBUTED_INJECTION'}));
 const gateway={complete:async request=>{
  calls++;if(calls===1)return {text:JSON.stringify({task:{kind:'keep'},teachings:{outcome:'none'}})};
  if(calls===2){assert.match(request.system,/recall/);assert.doesNotMatch(request.prompt,/EXTERNAL_UNATTRIBUTED_INJECTION/);return {text:JSON.stringify(recall)};}
  assert.match(request.prompt,/December is the synthetic preference/);assert.ok(request.prompt.includes(record.id));
  return {text:JSON.stringify(mode==='browser'?{reply:final.reply,notes:[]}:final)};
 }};
 const registry=new OperationRegistry();const operations=mode==='operations'?{registry,service:new OperationService(f.store,registry)}:undefined;
 const service=new AgentService(f.store,gateway,undefined,operations,{taskContinuity:true,...(mode==='browser'?{browser:{open:async()=>{opens++;throw new Error('not needed');}}}:{})});
 const result=await service.runOwnerTurn(input);assert.equal(result.turn.reply,final.reply);assert.equal(calls,3);assert.equal(opens,0);assert.equal(f.store.state('personal').works.w.phase,'open');assert.equal(Object.keys(f.store.state('personal').facts).length,0);
});
test('plain recall shares the eight-completion budget and denies binding overrides',async t=>{
 const f=await fixture(t);source(f);let calls=0;
 const service=new AgentService(f.store,{complete:async()=>({text:JSON.stringify(++calls===1?{task:{kind:'keep'},teachings:{outcome:'none'}}:recall)})},undefined,undefined,{taskContinuity:true});
 await assert.rejects(()=>service.runOwnerTurn(input),/finish|saved|limit/);assert.equal(calls,8);
 const {invokeRecall}=await import('../dist/runtime/recall-tool.js');
 assert.throws(()=>invokeRecall(f.store,input,{...recall.tool.arguments,workspaceId:'other'}));
});
test('same-chat overlapping turns are rejected before ingest while other chats proceed',async t=>{
 const f=await fixture(t);let release;const waiting=new Promise(r=>release=r);let entered;const started=new Promise(r=>entered=r);
 const service=new AgentService(f.store,{complete:async r=>{if(r.sessionHint.endsWith(':im')){entered();await waiting;}return {text:JSON.stringify(final)};}});
 const first=service.runOwnerTurn({...input,workId:undefined});await started;
 const overlap=service.runOwnerTurn({...input,workId:undefined,externalId:'overlap'}).then(()=>false,e=>/progress|finish/i.test(e.message));
 const rejected=await Promise.race([overlap,new Promise(r=>setTimeout(()=>r(false),25))]);
 const messages=f.store.threadMessages('personal','im').length;
 await service.runOwnerTurn({...input,workId:undefined,threadId:'other',externalId:'other'});
 release();await first;await overlap;assert.equal(rejected,true);assert.equal(messages,1);
});
test('task intake receives only scoped teaching quotes, not unrelated source text',async t=>{
 const f=await fixture(t);createWork(f);const {prepareTeachingEvents}=await import('../dist/runtime/teachings.js');
 const r=f.store.ingest('personal',message('mixed',{text:'Prefer December. OTHER_TASK_PRIVATE_TEXT'}));
 f.store.append('personal',f.store.state('personal').version,prepareTeachingEvents(f.store,{workspaceId:'personal',ownerId:'owner',workId:'w',ownerRecordId:r.id,expectedWorkRevision:1},{outcome:'apply',changes:[{kind:'add',sourceQuote:'Prefer December.',interpretation:'December preference'}],resolutions:[]}));
 let inspected=false;const service=new AgentService(f.store,{complete:async request=>{
  if(request.system.includes('owner-only task intake')){inspected=true;assert.doesNotMatch(request.prompt,/OTHER_TASK_PRIVATE_TEXT/);return {text:JSON.stringify({task:{kind:'keep'},teachings:{outcome:'none'}})};}
  return {text:JSON.stringify(final)};
 }},undefined,undefined,{taskContinuity:true});
 const result=await service.runOwnerTurn(input);assert.equal(inspected,true);assert.equal(result.turn.reply,final.reply);
});
test('historical browser notes do not force browser mode or hide operation catalog',async t=>{
 const f=await fixture(t);const owner=source(f);const {recordBrowserObservation,prepareBrowserLearningEvents}=await import('../dist/runtime/browser-learning.js');
 const binding={workspaceId:'personal',ownerId:'owner',workId:'w',ownerRecordId:owner.id,expectedWorkRevision:1};
 recordBrowserObservation(f.store,binding,{workspaceId:'personal',workId:'w',workRevision:1,sessionId:'old',generation:1,id:'obs',documentId:'doc',origin:'http://127.0.0.1:43117',location:'/',observedAt:new Date().toISOString(),text:'Historical directory',controls:[]});
 f.store.append('personal',f.store.state('personal').version,prepareBrowserLearningEvents(f.store,binding,[{text:'Old navigation',sourceIds:['obs']}],new Set(['obs'])));
 let calls=0;const registry=new OperationRegistry();
 const service=new AgentService(f.store,{complete:async()=>({text:JSON.stringify(++calls===1?{task:{kind:'keep'},teachings:{outcome:'none'}}:calls===2?{tool:{name:'catalog',arguments:{}}}:final)})},undefined,{registry,service:new OperationService(f.store,registry)},{taskContinuity:true});
 assert.equal((await service.runOwnerTurn(input)).turn.reply,final.reply);assert.equal(calls,3);
});
