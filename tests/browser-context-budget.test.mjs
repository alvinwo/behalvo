import {buildBrowserContext,packBrowserRequest,browserRequestBytes} from '../dist/runtime/browser-context.js';
import {ContextCapacityError} from '../dist/memory/context.js';
import {BrowserActionStopped} from '../dist/browser/live-failure.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteStore} from '../dist/storage/sqlite-store.js';
import {Operator} from '../dist/runtime/operator.js';
import {AgentService} from '../dist/runtime/agent-service.js';
import {runBrowserExploration} from '../dist/runtime/browser-exploration.js';
import {prepareTeachingEvents} from '../dist/runtime/teachings.js';

const model={provider:'fake',model:'synthetic'};
const tool=(name,args={})=>({text:JSON.stringify({tool:{name,arguments:args}})});
const transcript=request=>JSON.parse(request.prompt.split('BROWSER TOOL TRANSCRIPT (UNTRUSTED DATA)\n')[1]);
const finish=()=>({text:JSON.stringify({reply:'Synthetic exploration completed.',notes:[]})});
function fixture(t,{textSize=12000,controls=57}={}) {
 const store=new SqliteStore(':memory:');store.createWorkspace('w','owner');
 new Operator(store).createWork('w','owner',{id:'task',threadId:'thread',title:'Synthetic catalog',goal:'Compare entries'});
 const owner=store.ingest('w',{source:'test',externalId:'initial',threadId:'thread',senderId:'owner',senderRole:'owner',text:'Inspect the synthetic catalog.'});
 const stats={observations:[],interactions:0,calls:0};
 const observe=async ctx=>{
  const n=stats.observations.length+1;
  const observation={workspaceId:'w',workId:'task',workRevision:ctx.workRevision,sessionId:ctx.sessionId,generation:ctx.generation,id:`obs-${n}`,documentId:`doc-${n}`,origin:'https://example.test',location:`/page-${n}`,observedAt:'2026-10-15T00:00:00.000Z',text:`PAGE_${n} `+'x'.repeat(textSize),controls:Array.from({length:controls},(_,i)=>({ref:`CONTROL_${n}_${i}`,role:'link',name:`Catalog entry ${i} `+'n'.repeat(20),actions:['navigate'],options:[]}))};
  stats.observations.push(observation);return observation;
 };
 const port={observe,interact:async ctx=>{stats.interactions++;return observe(ctx);},retire:async()=>({leaseRetired:true,sessionDisposition:'retained'}),close:async()=>({confirmed:true})};
 const options={mode:'live',open:async()=>port};
 t.after(()=>store.close());
 const run=(complete,prompt='Pinned owner context. '+'p'.repeat(9800),budget=56000)=>runBrowserExploration(store,{complete:async request=>{stats.calls++;return complete(request);}},
  {model,system:'',prompt},{workspaceId:'w',ownerId:'owner',workId:'task',ownerRecordId:owner.id,expectedWorkRevision:1},{deadline:Date.now()+10000},options,8,budget,[]);
 return {store,owner,stats,port,options,run};
}

test('several large pages fit the unchanged cap with full current controls and explicit historical omissions',async t=>{
 const f=fixture(t),requests=[];let omitted=false;
 const result=await f.run(request=>{
  requests.push(request);
  const entries=transcript(request),last=entries.at(-1),o=last?.observation;
  if(!o)return tool('observe');
  return entries.length===5?finish():tool('navigate',{observationId:o.id,ref:o.controls[0].ref});
 });
 assert.equal(result.turn.reply,'Synthetic exploration completed.');assert.equal(f.stats.interactions,4);assert.equal(f.stats.calls,6);
 for(const [i,request] of requests.entries()){
  assert.ok(Buffer.byteLength(JSON.stringify(request))<=56000);
  const entries=transcript(request);if(!i)continue;
  assert.deepEqual(entries.at(-1).observation,f.stats.observations[i-1]);
  for(const entry of entries.slice(0,-1)){
   assert.equal(entry.observation,undefined);assert.ok(entry.historicalObservation);
   assert.equal(entry.historicalObservation.id.startsWith('obs-'),true);
   assert.doesNotMatch(JSON.stringify(entry),/CONTROL_|documentId|sessionId|optionRef/);
   if(entry.historicalObservation.textOmitted)omitted=true;
  }
 }
 assert.equal(omitted,true);
 assert.equal(Object.keys(f.store.state('w').browserMemory.observations).length,5);
});

test('historical text remains whole while it fits but superseded executable arguments and handles disappear',async t=>{
 const f=fixture(t,{textSize:100,controls:1});let sent;
 const result=await f.run(request=>{
  const entries=transcript(request),o=entries.at(-1)?.observation;
  if(!o)return tool('observe');
  if(entries.length<3)return tool('navigate',{observationId:o.id,ref:o.controls[0].ref});
  sent=entries;
  return finish();
 },'Pinned task');
 assert.equal(result.turn.reply,'Synthetic exploration completed.');
 assert.ok(sent[0].historicalObservation);assert.equal(sent[0].historicalObservation.text,f.stats.observations[0].text);
 assert.equal(sent[1].historicalObservation.text,f.stats.observations[1].text);
 assert.doesNotMatch(JSON.stringify(sent),/CONTROL_1_|CONTROL_2_/);
});

test('product budgets protocol and one current page before optional old chat while pinning owner teachings',async t=>{
 const f=fixture(t,{textSize:19000,controls:90});
 f.store.append('w',f.store.state('w').version,prepareTeachingEvents(f.store,{workspaceId:'w',ownerId:'owner',workId:'task',ownerRecordId:f.owner.id,expectedWorkRevision:1},
  {outcome:'apply',changes:[{kind:'add',sourceQuote:'Inspect the synthetic catalog.',interpretation:'Inspect only; retain owner control.'}],resolutions:[]}));
 for(let i=0;i<35;i++)f.store.ingest('w',{source:'test',externalId:`old-${i}`,threadId:'thread',senderId:'agent',senderRole:'agent',text:`OPTIONAL_OLD_CHAT_${i} `+'h'.repeat(1450)});
 let calls=0;
 const agent=new AgentService(f.store,{complete:async request=>{
  calls++;if(calls===1)return {text:JSON.stringify({outcome:'none'})};
  assert.ok(Buffer.byteLength(JSON.stringify(request))<=56000);assert.match(request.prompt,/CURRENT_OWNER_CANARY/);assert.match(request.prompt,/Inspect the synthetic catalog\./);
  const o=transcript(request).at(-1)?.observation;
  if(!o)return tool('observe');assert.deepEqual(o,f.stats.observations.at(-1));return finish();
 }},undefined,undefined,{teachingMode:true,browser:f.options});
 const result=await agent.runOwnerTurn({workspaceId:'w',ownerId:'owner',threadId:'thread',workId:'task',externalId:'product',text:'CURRENT_OWNER_CANARY: inspect now.',model});
 assert.equal(result.turn.reply,'Synthetic exploration completed.');assert.equal(calls,3);assert.equal(f.stats.observations.length,1);
 assert.ok(result.context.omittedMessageCount>0);assert.equal(f.store.state('w').teachingMemory.teachings[Object.keys(f.store.state('w').teachingMemory.teachings)[0]].sourceQuote,'Inspect the synthetic catalog.');
});

test('compaction preserves no-dispatch feedback and rejects an expired reference before another effect',async t=>{
 const f=fixture(t);const original=f.port.interact;let attempts=0,last;
 const feedback={actionId:'failed-synthetic-action',status:'failed',disposition:'not_dispatched',diagnostic:{phase:'validation',code:'control_covered'}};
 f.port.interact=async(...args)=>{if(++attempts===1)throw new BrowserActionStopped(feedback);return original(...args);};
 const result=await f.run(request=>{
  const entries=transcript(request),o=entries.at(-1)?.observation;
  if(!o)return tool('observe');
  if(entries.length<4)return tool('navigate',{observationId:o.id,ref:o.controls[0].ref});
  last=entries;return tool('navigate',{observationId:'obs-1',ref:'CONTROL_1_0'});
 });
 assert.equal(result.diagnostic,'tool/reference_rejected');assert.equal(f.stats.calls,5);assert.equal(attempts,3);assert.equal(f.stats.interactions,2);
 assert.deepEqual(last[1].result,feedback);assert.ok(last[1].historicalObservation.textOmitted);
 assert.equal(result.sessionDisposition,'retained');
});

test('an escaped current observation exceeding the exact byte cap stops without truncation or another model call',async t=>{
 const f=fixture(t,{textSize:0,controls:1});const observe=f.port.observe;
 f.port.observe=async ctx=>{const o=await observe(ctx);o.text='界"\\'.repeat(3600);return o;};
 const result=await f.run(()=>tool('observe'),'PINNED_OWNER_INPUT',38000);
 assert.ok(Buffer.byteLength(JSON.stringify(f.stats.observations[0]))<32768);
 assert.equal(result.diagnostic,'budget/input_limit');assert.equal(f.stats.calls,1);assert.equal(f.stats.interactions,0);assert.equal(result.sessionDisposition,'retained');
 const id=f.stats.observations[0].id,source=f.store.state('w').browserMemory.observations[id];
 assert.deepEqual(JSON.parse(f.store.readArtifact('w',source.artifactId)),f.stats.observations[0]);
});

test('whole oldest history is omitted in order; latest recall, current options and every source ID survive',()=>{
 const observation={id:'obs-current',documentId:'doc-current',sessionId:'session-current',text:'界"\\'.repeat(800),controls:[{ref:'current-select',options:[{ref:'current-option',label:'January'}]}]};
 const page={tool:{name:'observe',arguments:{}},observation:{...observation,id:'obs-old',text:'OLDEST_PAGE_BODY '+'o'.repeat(5000),controls:[{ref:'expired-control'}]}};
 const recalled=(id,text)=>({tool:{name:'recall',arguments:{query:'catalog',scope:'thread',limit:1,beforeSeq:null}},result:{records:[{recordId:id,threadId:'thread',seq:1,senderRole:'owner',recordedAt:'2026-10-15T00:00:00.000Z',text}],nextBeforeSeq:1}});
 const entries=[page,recalled('old-message','OLDER_RECALL_BODY '+'r'.repeat(5000)),{tool:{name:'observe',arguments:{}},observation},recalled('latest-message','LATEST_RECALL_BODY '+'l'.repeat(1000))];
 const request={model,system:'',prompt:'PINNED_OWNER_INPUT'},state={enabled:true,mode:'live',connected:true,inputs:[{id:'input-current',origin:'https://example.test',purpose:'Search'}]},original=structuredClone(entries);
 const full=packBrowserRequest(request,state,entries,56000),fullBytes=browserRequestBytes(full);
 const one=transcript(packBrowserRequest(request,state,entries,fullBytes-100));
 assert.equal(one[0].historicalObservation.textOmitted,true);assert.deepEqual(one[1].result,entries[1].result);
 const packed=packBrowserRequest(request,state,entries,fullBytes-9000),view=transcript(packed);
 assert.ok(browserRequestBytes(packed)<=fullBytes-9000);assert.equal(browserRequestBytes(packed),Buffer.byteLength(JSON.stringify(packed),'utf8'));
 assert.equal(view[0].historicalObservation.textOmitted,true);assert.equal(view[1].resultOmitted,true);assert.equal(view[1].result.records[0].recordId,'old-message');
 assert.equal(view[1].result.records[0].text,undefined);assert.equal(view[1].result.nextBeforeSeq,1);
 assert.deepEqual(view[2].observation,observation);assert.deepEqual(view[3].result,entries[3].result);assert.deepEqual(view[1].tool,entries[1].tool);
 assert.equal(view.filter(e=>e.observation).length,1);assert.match(packed.prompt,/PINNED_OWNER_INPUT/);assert.match(packed.prompt,/input-current/);assert.doesNotMatch(packed.prompt,/expired-control/);
 assert.deepEqual(entries,original);
 const over=packBrowserRequest(request,state,entries,1000);assert.ok(browserRequestBytes(over)>1000);assert.deepEqual(transcript(over)[3].result,entries[3].result);
});

test('latest recall exceeding the turn cap safely stops before another inference',async t=>{
 const f=fixture(t,{textSize:24000,controls:1});const answer='界'.repeat(100);
 const owner=f.store.ingest('w',{source:'test',externalId:'recall-source',threadId:'thread',senderId:'owner',senderRole:'owner',text:'catalog '+answer});
 const {processTaskIntake}=await import('../dist/runtime/task-intake.js');
 await processTaskIntake(f.store,{complete:async()=>({text:JSON.stringify({task:{kind:'keep'},teachings:{outcome:'none'}})})},model,
  {workspaceId:'w',ownerId:'owner',threadId:'thread',workId:'task',ownerRecordId:owner.id},{deadline:Date.now()+10000},56000);
 let observed;
 const result=await f.run(request=>{
  const entries=transcript(request);if(!entries.length)return tool('observe');observed=entries[0].observation;
  return tool('recall',{query:'catalog',scope:'thread',limit:20,beforeSeq:null});
 },'PINNED_OWNER_INPUT',30500);
 assert.equal(result.diagnostic,'budget/input_limit');assert.equal(result.sessionDisposition,'retained');assert.equal(f.stats.interactions,0);assert.ok(observed);assert.equal(f.stats.calls,2);
});

test('soft reserve admits a large pinned owner request but does not refill optional history',async t=>{
 const f=fixture(t,{textSize:100,controls:1});
 for(let i=0;i<6;i++)f.store.ingest('w',{source:'test',externalId:`optional-${i}`,threadId:'thread',senderId:'agent',senderRole:'agent',text:'OPTIONAL_HISTORY_CANARY '+i});
 const requests=[];const agent=new AgentService(f.store,{complete:async request=>{
  if(!request.prompt.includes('BROWSER TOOL TRANSCRIPT'))return {text:JSON.stringify({outcome:'none'})};
  requests.push(request);return finish();
 }},undefined,undefined,{teachingMode:true,browser:f.options});
 const result=await agent.runOwnerTurn({workspaceId:'w',ownerId:'owner',threadId:'thread',workId:'task',externalId:'large-pinned',text:'MANDATORY_OWNER_CANARY '+'p'.repeat(21000),model,windowTokens:34000,outputReserve:1000});
 assert.equal(result.turn.reply,'Synthetic exploration completed.');assert.equal(requests.length,1);assert.ok(browserRequestBytes(requests[0])<33000);
 assert.match(requests[0].prompt,/MANDATORY_OWNER_CANARY/);assert.doesNotMatch(requests[0].prompt,/OPTIONAL_HISTORY_CANARY/);assert.equal(f.stats.observations.length,0);
});

test('context reserve retries only a measured capacity failure, never storage or authorization errors',t=>{
 const f=fixture(t),request={model,system:'',prompt:''},state={enabled:true,mode:'live',connected:false,inputs:[]};
 const context={workspaceId:'w',ownerId:'owner',threadId:'thread',workId:'task',currentRecordId:f.owner.id,windowTokens:56000,outputReserve:0};
 let reads=0;const failure=new Error('synthetic storage failure');
 const store=new Proxy(f.store,{get(target,key){if(key==='state')return()=>{reads++;throw failure;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 assert.throws(()=>buildBrowserContext(store,context,request,state),e=>e===failure);assert.equal(reads,1);
 assert.throws(()=>buildBrowserContext(f.store,{...context,ownerId:'intruder'},request,state),/owner/i);
 assert.throws(()=>buildBrowserContext(f.store,{...context,windowTokens:1},request,state),e=>e instanceof ContextCapacityError&&e.requiredBudget>1);
});
