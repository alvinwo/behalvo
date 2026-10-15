import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteStore} from '../dist/storage/sqlite-store.js';
import {Operator} from '../dist/runtime/operator.js';
import {AgentService} from '../dist/runtime/agent-service.js';
import {runBrowserExploration} from '../dist/runtime/browser-exploration.js';

const tool=(name,args={})=>({text:JSON.stringify({tool:{name,arguments:args}})});
function fixture(t,options={}) {
 const store=new SqliteStore(':memory:');store.createWorkspace('w','owner');
 const op=new Operator(store);op.createWork('w','owner',{id:'task',title:'Synthetic catalog',goal:'Inspect catalog',threadId:'thread'});
 const owner=store.ingest('w',{source:'test',externalId:'one',threadId:'thread',senderId:'owner',senderRole:'owner',text:'Inspect the synthetic catalog.'});
 const binding={workspaceId:'w',ownerId:'owner',workId:'task',ownerRecordId:owner.id,expectedWorkRevision:1};
 const abort=new AbortController(),execution={deadline:Date.now()+10000,signal:abort.signal};
 const stats={calls:0,observes:0,interacts:0,retired:undefined};
 const port={observe:async ctx=>{stats.observes++;return {workspaceId:'w',workId:'task',workRevision:1,sessionId:ctx.sessionId,generation:1,id:'obs-'+stats.observes,documentId:'doc',origin:'https://example.test',location:'/',observedAt:new Date().toISOString(),text:options.large?'x'.repeat(20000):'Synthetic catalog',controls:[{ref:'link-'+stats.observes,role:'link',name:'Catalog',actions:['navigate'],options:[]},{ref:'select-'+stats.observes,role:'combobox',name:'Category',actions:['select'],options:[{ref:'option-'+stats.observes,name:'Alpha'}]}]};},
  interact:async()=>{stats.interacts++;throw new Error('PRIVATE_PORT_CANARY');},
  handoff:async()=>{throw new Error('PRIVATE_HANDOFF_CANARY');},
  retire:async healthy=>{stats.retired=healthy;return {leaseRetired:true,...(healthy?{sessionDisposition:'retained'}:{sessionDisposition:'closed',cleanupConfirmed:true})};},close:async()=>({confirmed:true})};
 t.after(()=>store.close());
 const run=async second=>runBrowserExploration(store,{complete:async request=>{stats.calls++;if(stats.calls===1)return tool('observe');return typeof second==='function'?second(request):second;}},
  {model:{provider:'fake',model:'synthetic'},system:'',prompt:''},binding,execution,{mode:'live',open:async()=>port},options.maximum??8,options.budget??56000,[]);
 return {store,op,abort,execution,stats,port,run};
}

// A model-only failure must not retire the healthy browser as a browser fault.
for(const [name,response,code] of [
 ['invalid JSON',{text:'PRIVATE_MODEL_CANARY {'},'response/invalid_json'],
 ['invalid envelope',{text:JSON.stringify({tool:{name:'observe',arguments:{}},extra:'PRIVATE_MODEL_CANARY'})},'response/invalid_envelope'],
 ['invalid arguments',tool('observe',{extra:'PRIVATE_MODEL_CANARY'}),'tool/invalid_arguments'],
 ['oversized response',{text:'PRIVATE_MODEL_CANARY'.repeat(4000)},'budget/response_limit'],
 ['invalid notes',{text:JSON.stringify({reply:'Ready',notes:[{text:'PRIVATE_MODEL_CANARY',sourceIds:['invented']}]})},'final/invalid_notes'],
 ['invalid progress',{text:JSON.stringify({reply:'Ready',notes:[],progress:{summary:'PRIVATE_MODEL_CANARY'}})},'final/invalid_progress']
])test(`${name} records a fixed stop reason and retains the healthy browser`,async t=>{
 const f=fixture(t),result=await f.run(response);
 assert.ok(result.turn.reply.includes(code),result.turn.reply);assert.equal(result.sessionDisposition,'retained');assert.equal(f.stats.retired,true);assert.equal(f.stats.interacts,0);assert.equal(f.stats.calls,2);
 assert.match(result.turn.reply,/remains open/);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_MODEL_CANARY/);
 assert.equal(Object.values(f.store.state('w').actions).length,0);assert.ok(result.events.every(e=>e.type==='browser.checkpoint'));
});
test('provider failure after an observation retains the browser and never echoes the provider error',async t=>{
 const f=fixture(t),result=await f.run(()=>{throw new Error('PRIVATE_PROVIDER_CANARY');});
 assert.match(result.turn.reply,/model\/invocation_failed/);assert.equal(result.stopReason,'model_unavailable');assert.equal(f.stats.retired,true);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PROVIDER_CANARY/);
});
for(const [name,args,kind] of [
 ['old observation',{observationId:'old',ref:'link-1'},'navigate'],
 ['old ref',{observationId:'obs-1',ref:'old'},'navigate'],
 ['wrong action',{observationId:'obs-1',ref:'link-1'},'click'],
 ['old option',{observationId:'obs-1',ref:'select-1',optionRef:'old'},'select']
])test(`${name} is rejected against the latest observation before invoking the adapter`,async t=>{
 const f=fixture(t),result=await f.run(tool(kind,args));
 assert.match(result.turn.reply,/tool\/reference_rejected/);assert.equal(f.stats.interacts,0);assert.equal(f.stats.retired,true);assert.equal(result.sessionDisposition,'retained');
});
test('an accumulated request budget stop retains the last observed page without another inference',async t=>{
 const f=fixture(t,{large:true,budget:18000}),result=await f.run(()=>assert.fail('No further model call'));
 assert.match(result.turn.reply,/budget\/input_limit/);assert.equal(f.stats.calls,1);assert.equal(f.stats.retired,true);
});
test('completion exhaustion reports its limit and retires a healthy lease without more inference',async t=>{
 const f=fixture(t,{maximum:1}),result=await f.run(()=>assert.fail());
 assert.match(result.turn.reply,/budget\/completion_limit/);assert.equal(f.stats.calls,1);assert.equal(f.stats.retired,true);
});
test('an untyped adapter failure remains terminal and cannot be mistaken for a rejected model response',async t=>{
 const f=fixture(t),result=await f.run(tool('navigate',{observationId:'obs-1',ref:'link-1'}));
 assert.match(result.turn.reply,/browser\/operation_failed/);assert.equal(f.stats.interacts,1);assert.equal(f.stats.retired,false);assert.equal(result.sessionDisposition,'closed');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PORT_CANARY|remains open/);
});
test('a failed handoff remains terminal without falsely reporting manual control',async t=>{
 const f=fixture(t),result=await f.run(tool('handoff'));
 assert.match(result.turn.reply,/browser\/handoff_failed/);assert.equal(f.stats.retired,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_HANDOFF_CANARY|Browser paused|remains open/);
});
for(const reason of ['cancelled','deadline','changed'])test(`${reason} overrides an otherwise local protocol stop and closes the session`,async t=>{
 const f=fixture(t),result=await f.run(()=>{if(reason==='cancelled')f.abort.abort();else if(reason==='deadline')f.execution.deadline=Date.now()-1;else f.op.setWorkPhase('w','owner','task','waiting_external');return {text:'invalid'};});
 assert.match(result.turn.reply,reason==='changed'?/lifecycle\/authority_unavailable/:new RegExp('lifecycle/'+reason));assert.equal(f.stats.retired,false);assert.doesNotMatch(result.turn.reply,/remains open/);
});
test('a revoked asynchronous execution fence overrides a local stop before retirement',async t=>{
 const f=fixture(t);let revoked=false;f.execution.assertCurrent=async()=>{if(revoked)throw new Error('PRIVATE_FENCE_CANARY');};
 const result=await f.run(()=>{revoked=true;return {text:'invalid'};});
 assert.match(result.turn.reply,/lifecycle\/authority_unavailable/);assert.equal(f.stats.retired,false);assert.doesNotMatch(result.turn.reply,/PRIVATE_FENCE_CANARY|remains open/);
});
test('cleanup uncertainty supplements the original stop and forbids a retained-session claim',async t=>{
 const f=fixture(t);f.port.retire=async()=>({leaseRetired:false,cleanupConfirmed:false});
 const result=await f.run({text:'invalid'});
 assert.match(result.turn.reply,/response\/invalid_json/);assert.match(result.turn.reply,/cleanup\/cleanup_unconfirmed/);assert.doesNotMatch(result.turn.reply,/remains open/);
});
test('cleanup failure after a valid final answer is not mislabeled as budget exhaustion',async t=>{
 const f=fixture(t);f.port.retire=async()=>{throw new Error('PRIVATE_CLEANUP_CANARY');};
 const result=await f.run({text:JSON.stringify({reply:'PRIVATE_UNCOMMITTED_REPLY',notes:[]})});
 assert.match(result.turn.reply,/cleanup\/retirement_failed/);assert.match(result.turn.reply,/cleanup\/cleanup_unconfirmed/);assert.doesNotMatch(result.turn.reply,/budget\/completion_limit|PRIVATE_|remains open/);
});
test('handoff that changed state and then threw cannot become manual success',async t=>{
 const f=fixture(t);let closed=0;f.port.retire=async()=>({leaseRetired:true,sessionDisposition:'human'});f.port.close=async()=>{closed++;return {confirmed:true};};
 const result=await f.run(tool('handoff'));
 assert.match(result.turn.reply,/browser\/handoff_failed/);assert.doesNotMatch(result.turn.reply,/Browser paused/);assert.equal(closed,1);assert.equal(result.sessionDisposition,'closed');
});
for(const failure of ['syntax','settlement'])test(`the product journals a coded ${failure} stop without discarding the safe retained state`,async t=>{
 const f=fixture(t);let calls=0;
 const agent=new AgentService(f.store,{complete:async()=>{calls++;if(calls===1)return {text:JSON.stringify({task:{kind:'keep'},teachings:{outcome:'none'}})};
  if(calls===2)return tool('observe');
  return failure==='syntax'?{text:'PRIVATE_RESPONSE_CANARY'}:{text:JSON.stringify({reply:'PRIVATE_REJECTED_REPLY',notes:[],progress:{summary:'Observed catalog',nextStep:'Inspect dates',blocker:null,references:[{kind:'browser_observation',id:'invented'}]}})};
 }},undefined,undefined,{taskContinuity:true,browser:{mode:'live',open:async()=>f.port}});
 const result=await agent.runOwnerTurn({workspaceId:'w',ownerId:'owner',workId:'task',threadId:'thread',externalId:'product',text:'Inspect catalog.',model:{provider:'fake',model:'test'}});
 assert.match(result.turn.reply,failure==='syntax'?/response\/invalid_json/:/final\/settlement_rejected/);assert.match(result.turn.reply,/remains open/);assert.doesNotMatch(result.turn.reply,/PRIVATE_/);assert.equal(f.stats.retired,true);
 const record=f.store.record('w',result.assistantRecordId);assert.equal(f.store.readArtifact('w',record.event.data.artifactId),result.turn.reply);
 assert.equal(Object.keys(f.store.state('w').browserMemory.notes).length,0);
});
