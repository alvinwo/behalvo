import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';import {AgentService} from '../dist/runtime/agent-service.js';
const input={workspaceId:'personal',ownerId:'owner',threadId:'im',externalId:'first',text:'Check synthetic slots. Use December dates.',model:{provider:'fake',model:'synthetic'}};
const intake={task:{kind:'create',title:'Synthetic slots',goal:'Check slots',sourceQuote:'Check synthetic slots.'},teachings:{outcome:'apply',changes:[{kind:'add',sourceQuote:'Use December dates.',interpretation:'December only'}],resolutions:[]}};
test('teaching commit continues reasoning in the same turn with current sources',async t=>{
 const f=await fixture(t);let calls=0;const gateway={complete:async request=>{
  if(calls++===0)return {text:JSON.stringify(intake)};
  assert.ok(request.prompt.includes('Use December dates.'));assert.equal(Object.values(f.store.state('personal').teachingMemory.teachings).length,1);
  return {text:JSON.stringify({reply:'Ready to inspect synthetic slots',workProposals:[],factProposals:[]})};
 }};
 const service=new AgentService(f.store,gateway,undefined,undefined,{taskContinuity:true});
 const result=await service.runOwnerTurn(input);assert.equal(calls,2);assert.equal(result.turn.reply,'Ready to inspect synthetic slots');assert.ok(result.workId);assert.equal(f.store.inbox('personal').length,0);
 await assert.rejects(()=>service.runOwnerTurn(input),/already handled/i);assert.equal(calls,2);
});
test('failure after intake and explicit retry retain one task and the newest correction',async t=>{
 const f=await fixture(t);let calls=0;const service=new AgentService(f.store,{complete:async()=>{if(calls++===0)return{text:JSON.stringify(intake)};throw new Error('synthetic provider failure');}},undefined,undefined,{taskContinuity:true});
 await assert.rejects(()=>service.runOwnerTurn(input),/provider|finish|saved/i);const state=f.store.state('personal');const work=Object.values(state.works)[0];assert.ok(work);
 const newer=new AgentService(f.store,{complete:async request=>{
  if(request.system.includes('owner-only task intake'))return {text:JSON.stringify({task:{kind:'keep'},teachings:{outcome:'apply',changes:[{kind:'replace',teachingId:Object.keys(state.teachingMemory.teachings)[0],expectedRevision:1,sourceQuote:'Use January instead.',interpretation:'January only'}],resolutions:[]}})};
  return {text:JSON.stringify({reply:'Updated',workProposals:[],factProposals:[]})};
 }},undefined,undefined,{taskContinuity:true});await newer.runOwnerTurn({...input,externalId:'correction',text:'Use January instead.'});
 const revision=f.store.state('personal').works[work.id].revision;let resumedCalls=0;
 const retry=new AgentService(f.store,{complete:async request=>{resumedCalls++;assert.ok(request.prompt.includes('Use January instead.'));return {text:JSON.stringify({reply:'Continuing January search',workProposals:[],factProposals:[]})};}},undefined,undefined,{taskContinuity:true});
 await retry.runOwnerTurn(input);assert.equal(resumedCalls,1);assert.equal(f.store.state('personal').works[work.id].revision,revision);assert.equal(Object.keys(f.store.state('personal').works).length,1);
});
test('final progress settles with the reply and persists as advisory state after restart',async t=>{
 const f=await fixture(t);let calls=0;const report={summary:'Owner preferences saved; slots still unverified',nextStep:'Observe the synthetic directory',blocker:null,references:[]};
 const service=new AgentService(f.store,{complete:async()=>({text:JSON.stringify(calls++===0?intake:{reply:'Ready to observe',workProposals:[],factProposals:[],progress:report})})},undefined,undefined,{taskContinuity:true});
 const result=await service.runOwnerTurn(input);assert.equal(result.turn.reply,'Ready to observe');
 const progress=f.store.state('personal').taskContinuity.progress[result.workId];assert.equal(progress.nextStep,report.nextStep);assert.equal(progress.ownerRecordId,result.ownerRecordId);assert.equal(progress.workRevision,2);
 const events=f.store.journal('personal').map(r=>r.event.type);assert.deepEqual(events.slice(-3),['task.progress_recorded','message.received','inbox.handled']);
 f.restart();assert.deepEqual(f.store.rebuild('personal'),f.store.state('personal'));assert.equal(f.store.state('personal').works[result.workId].phase,'open');
});
test('intake and reasoning share eight completions; a bounded stop retains a useful checkpoint',async t=>{
 const f=await fixture(t);const {OperationRegistry}=await import('../dist/operations/registry.js');const {OperationService}=await import('../dist/operations/service.js');const registry=new OperationRegistry();let calls=0;
 const service=new AgentService(f.store,{complete:async()=>({text:JSON.stringify(calls++===0?intake:{tool:{name:'catalog',arguments:{}}})})},undefined,{registry,service:new OperationService(f.store,registry)},{taskContinuity:true});
 const result=await service.runOwnerTurn(input);assert.equal(calls,8);assert.match(result.turn.reply,/limit/);
 assert.equal(f.store.state('personal').taskContinuity.progress[result.workId].stopReason,'invalid_model_result');
});
test('late progress and reply cannot overwrite newer task state',async t=>{
 const f=await fixture(t);let calls=0;
 const service=new AgentService(f.store,{complete:async()=>{
  if(calls++===0)return {text:JSON.stringify(intake)};
  const state=f.store.state('personal');const id=Object.keys(state.works)[0];f.store.append('personal',state.version,[{type:'work.phase_changed',data:{id,phase:'waiting_external'}}]);
  return {text:JSON.stringify({reply:'STALE_RESULT',workProposals:[],factProposals:[],progress:{summary:'STALE_RESULT',nextStep:'Old advice',blocker:null,references:[]}})};
 }},undefined,undefined,{taskContinuity:true});const result=await service.runOwnerTurn(input);
 assert.doesNotMatch(result.turn.reply,/STALE_RESULT/);assert.equal(f.store.state('personal').taskContinuity.progress[result.workId],undefined);
});
test('progress cannot settle after the final artifact write crosses the deadline',async t=>{
 const f=await fixture(t);const originalNow=Date.now;let now=originalNow();let calls=0;const put=f.store.putArtifact.bind(f.store);
 try{Date.now=()=>now;const service=new AgentService(f.store,{complete:async()=>{
  if(calls++===0)return {text:JSON.stringify(intake)};
  f.store.putArtifact=(...args)=>{const result=put(...args);now+=120001;f.store.putArtifact=put;return result;};
  return {text:JSON.stringify({reply:'LATE_PROGRESS',workProposals:[],factProposals:[],progress:{summary:'Late',nextStep:'Late step',blocker:null,references:[]}})};
 }},undefined,undefined,{taskContinuity:true});const result=await service.runOwnerTurn(input);assert.doesNotMatch(result.turn.reply,/LATE_PROGRESS/);assert.equal(f.store.state('personal').taskContinuity.progress[result.workId],undefined);assert.equal(f.store.inbox('personal').length,0);
 }finally{Date.now=originalNow;}
});
test('unconfirmed browser cleanup cannot record progress or a stop checkpoint',async t=>{
 const f=await fixture(t);let calls=0;
 const service=new AgentService(f.store,{complete:async()=>({text:JSON.stringify(calls++===0?intake:calls===2?{tool:{name:'observe',arguments:{}}}:{reply:'UNCONFIRMED',notes:[],progress:{summary:'Observed',nextStep:'Compare',blocker:null,references:[]}})})},undefined,undefined,{taskContinuity:true,browser:{open:async ctx=>({observe:async()=>({workspaceId:ctx.workspaceId,workId:ctx.workId,workRevision:ctx.workRevision,sessionId:ctx.sessionId,generation:1,id:'obs',documentId:'doc',origin:'http://127.0.0.1:43117',location:'/',observedAt:new Date().toISOString(),text:'Synthetic',controls:[]}),close:async()=>({confirmed:false})})}});
 const result=await service.runOwnerTurn(input);assert.doesNotMatch(result.turn.reply,/UNCONFIRMED/);assert.deepEqual(f.store.state('personal').taskContinuity.progress,{});assert.deepEqual(f.store.state('personal').browserMemory.checkpoints,{});
 await assert.rejects(()=>service.runOwnerTurn({...input,externalId:'next',text:'continue'}),/cleanup/);assert.equal(calls,3);
});
test('admitted continuity settles progress and reply atomically under the current service fence',async()=>{
 const {SqliteStore}=await import('../dist/storage/sqlite-store.js');const store=new SqliteStore(':memory:',{serviceQueue:{upgradeExisting:false}});let calls=0;let checks=0;
 try{
 store.createWorkspace('personal','owner');const at=new Date().toISOString();store.admitOwnerTurnJob({workspaceId:'personal',ownerId:'owner',source:'owner:service',requestId:'r',envelope:{kind:'owner_turn',threadId:'im',text:input.text},accepted:{threadId:'im',model:input.model,windowTokens:64000,outputReserve:8000,capability:'prepare_only'},instanceId:'test',at});
 const job=store.claimServiceJob('personal','worker',at);
 const service=new AgentService(store,{complete:async()=>({text:JSON.stringify(calls++===0?intake:{reply:'Ready to inspect',workProposals:[],factProposals:[],progress:{summary:'Owner criteria saved',nextStep:'Inspect synthetic slots',blocker:null,references:[]}})})},undefined,undefined,{taskContinuity:true});
 const result=await service.processAdmittedOwnerTurn({workspaceId:'personal',ownerId:'owner',job,fence:{serviceGeneration:'synthetic',deadline:Date.now()+5000,signal:new AbortController().signal,assertCurrent:async()=>{},assertDispatchCurrent:()=>{checks++;},assertSettlementCurrent:()=>{checks++;}}});
 assert.equal(store.serviceJob('personal',job.id).status,'finished');assert.equal(store.inbox('personal').length,0);assert.equal(store.state('personal').taskContinuity.progress[result.workId].nextStep,'Inspect synthetic slots');assert.ok(checks>=2);
 }finally{store.close();}
});
test('application stop checkpoint cannot cross the deadline during its final artifact write',async t=>{
 const f=await fixture(t);const {OperationRegistry}=await import('../dist/operations/registry.js');const {OperationService}=await import('../dist/operations/service.js');const registry=new OperationRegistry();
 const originalNow=Date.now;let now=originalNow();let calls=0;const put=f.store.putArtifact.bind(f.store);
 try{Date.now=()=>now;const service=new AgentService(f.store,{complete:async()=>{
  calls++;if(calls===8)f.store.putArtifact=(...args)=>{const result=put(...args);now+=120001;f.store.putArtifact=put;return result;};
  return {text:JSON.stringify(calls===1?intake:{tool:{name:'catalog',arguments:{}}})};
 }},undefined,{registry,service:new OperationService(f.store,registry)},{taskContinuity:true});
 const result=await service.runOwnerTurn(input);assert.equal(calls,8);assert.match(result.turn.reply,/deadline/);assert.equal(f.store.state('personal').taskContinuity.progress[result.workId],undefined);assert.equal(f.store.inbox('personal').length,0);
 }finally{Date.now=originalNow;}
});
for(const oversized of ['reply','diagnostic'])test(`admitted continuity rejects oversized ${oversized} before final settlement`,async()=>{
 const {SqliteStore}=await import('../dist/storage/sqlite-store.js');const store=new SqliteStore(':memory:',{serviceQueue:{upgradeExisting:false}});let calls=0;
 try{
 store.createWorkspace('personal','owner');const at=new Date().toISOString();store.admitOwnerTurnJob({workspaceId:'personal',ownerId:'owner',source:'owner:service',requestId:'r',envelope:{kind:'owner_turn',threadId:'im',text:input.text},accepted:{threadId:'im',model:input.model,windowTokens:64000,outputReserve:8000,capability:'prepare_only'},instanceId:'test',at});
 const job=store.claimServiceJob('personal','worker',at);
 const service=new AgentService(store,{complete:async()=>++calls===1?{text:JSON.stringify(intake)}:{text:JSON.stringify({reply:oversized==='reply'?'界'.repeat(30000):'Bounded reply',workProposals:[],factProposals:[]}),...(oversized==='diagnostic'?{diagnosticText:'x'.repeat(65537)}:{})}},undefined,undefined,{taskContinuity:true});
 await assert.rejects(()=>service.processAdmittedOwnerTurn({workspaceId:'personal',ownerId:'owner',job,fence:{serviceGeneration:'synthetic',deadline:Date.now()+5000,signal:new AbortController().signal,assertCurrent:async()=>{},assertDispatchCurrent:()=>{},assertSettlementCurrent:()=>{}}}),/budget|finish|saved/i);
 assert.equal(calls,2);assert.equal(store.inbox('personal').length,1);assert.equal(store.serviceJob('personal',job.id).status,'running');assert.equal(Object.keys(store.state('personal').taskContinuity.intakes).length,1);assert.equal(store.threadMessages('personal','im').filter(r=>r.event.data.senderRole==='agent').length,0);
 }finally{store.close();}
});
test('admitted reasoning budgets the complete request envelope, not only context text',async()=>{
 const {SqliteStore}=await import('../dist/storage/sqlite-store.js');const {buildContext}=await import('../dist/memory/context.js');const store=new SqliteStore(':memory:',{serviceQueue:{upgradeExisting:false}});let calls=0;
 try{
 store.createWorkspace('personal','owner');const at=new Date().toISOString();const text=input.text+' '+ 'x'.repeat(10000);const budget=23000;
 store.admitOwnerTurnJob({workspaceId:'personal',ownerId:'owner',source:'owner:service',requestId:'r',envelope:{kind:'owner_turn',threadId:'im',text},accepted:{threadId:'im',model:input.model,windowTokens:budget+8000,outputReserve:8000,capability:'prepare_only'},instanceId:'test',at});
 const job=store.claimServiceJob('personal','worker',at);const service=new AgentService(store,{complete:async()=>{calls++;return {text:JSON.stringify(calls===1?intake:{reply:'UNEXPECTED_SECOND_INFERENCE',workProposals:[],factProposals:[]})};}},undefined,undefined,{taskContinuity:true});
 await assert.rejects(()=>service.processAdmittedOwnerTurn({workspaceId:'personal',ownerId:'owner',job,fence:{serviceGeneration:'synthetic',deadline:Date.now()+5000,signal:new AbortController().signal,assertCurrent:async()=>{},assertDispatchCurrent:()=>{},assertSettlementCurrent:()=>{}}}));
 const receipt=Object.values(store.state('personal').taskContinuity.intakes)[0];assert.ok(receipt);const context=buildContext(store,{workspaceId:'personal',ownerId:'owner',workId:receipt.workId,threadId:'im',currentRecordId:receipt.ownerRecordId,windowTokens:budget+8000,outputReserve:8000});assert.ok(context.estimatedTokens<=budget);assert.equal(calls,1);assert.equal(store.inbox('personal').length,1);
 }finally{store.close();}
});
