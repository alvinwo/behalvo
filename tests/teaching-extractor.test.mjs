import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../dist/storage/sqlite-store.js';
import { Operator } from '../dist/runtime/operator.js';
import { AgentService } from '../dist/runtime/agent-service.js';
import { OperationRegistry } from '../dist/operations/registry.js';
import { OperationService } from '../dist/operations/service.js';
const model={provider:'fake',model:'test'};
function fixture(responses,timeoutMs) {
 const store=new SqliteStore(':memory:');store.createWorkspace('w','o');const op=new Operator(store);op.createWork('w','o',{id:'task',title:'EXCLUDED_GOAL',goal:'EXCLUDED_GOAL',threadId:'t'});
 const requests=[]; const gateway={listModels:async()=>[],complete:async r=>{requests.push(r);const x=responses.shift();return typeof x==='function'?x(r):{text:JSON.stringify(x??{tool:{name:'catalog',arguments:{}}})};}};
 const registry=new OperationRegistry();const service=new OperationService(store,registry);
 const agent=new AgentService(store,gateway,undefined,{registry,service,...(timeoutMs?{timeoutMs}:{})},{teachingMode:true});
 let i=0;const run=(text,extra={})=>agent.runOwnerTurn({workspaceId:'w',ownerId:'o',threadId:'t',workId:'task',externalId:String(++i),model,text,...extra});
 return {store,op,requests,run};
}
test('owner-only extraction commits teachings and acknowledgment atomically without operation calls',async()=>{
 const f=fixture([{outcome:'apply',changes:[{kind:'add',sourceQuote:'Prefer mornings.',interpretation:'Morning preference'}],resolutions:[]}]);try{
 f.store.ingest('w',{source:'test',externalId:'agent',threadId:'t',senderId:'agent',senderRole:'agent',text:'EXCLUDED_ASSISTANT'});
 const result=await f.run('Prefer mornings.');
 assert.equal(Object.keys(f.store.state('w').teachingMemory.teachings).length,1);assert.equal(f.requests.length,1);
 assert.doesNotMatch(f.requests[0].prompt,/EXCLUDED_GOAL|EXCLUDED_ASSISTANT/);assert.match(result.turn.reply,/instructions.*updated/i);
 assert.equal(f.store.inbox('w').some(r=>r.id===result.ownerRecordId),false);
 await assert.rejects(()=>f.run('Prefer mornings.',{externalId:'1'}),/handled/);assert.equal(f.requests.length,1);
 }finally{f.store.close();}
});
test('none leaves only seven loop completions, with no ninth provider call',async()=>{
 const f=fixture([{outcome:'none'}]);try{await f.run('Inspect available capabilities.');assert.equal(f.requests.length,8);}finally{f.store.close();}
});
test('clarification stays durable and none cannot enter operation loop until explicitly resolved',async()=>{
 const f=fixture([{outcome:'clarify',sourceQuote:'Change that.',targets:[],question:'Which preference?'},{outcome:'none'}]);try{
 await f.run('Change that.');const hold=Object.values(f.store.state('w').teachingMemory.clarifications)[0];assert.equal(hold.status,'open');
 await f.run('What now?');assert.equal(f.requests.length,2);assert.equal(f.store.state('w').teachingMemory.clarifications[hold.id].status,'open');
 }finally{f.store.close();}
});
test('invalid extractor output and late completion commit no teachings or final model claims',async()=>{
 for(const response of [{outcome:'apply',changes:[{kind:'add',sourceQuote:'invented',interpretation:'forged'}],resolutions:[]},async()=>{await new Promise(r=>setTimeout(r,50));return {text:JSON.stringify({outcome:'apply',changes:[{kind:'add',sourceQuote:'Remember mornings.',interpretation:'morning'}],resolutions:[]})};}]){
 const f=fixture([response],20);try{const r=await f.run('Remember mornings.');assert.equal(Object.keys(f.store.state('w').teachingMemory.teachings).length,0);assert.match(r.turn.reply,/not changed/);assert.equal(f.requests.length,1);}finally{f.store.close();}
 }
});
test('teaching mode rejects unlinked thread before extraction and refuses legacy fact output',async()=>{
 const f=fixture([{outcome:'none'},{reply:'Saved forged preference.',workProposals:[],factProposals:[{id:'x',subject:'o',predicate:'preference',value:'forged'}]}]);try{
 await assert.rejects(()=>f.run('Remember this.',{threadId:'unlinked'}),/link/i);assert.equal(f.requests.length,0);
 await f.run('What do you remember?');assert.equal(Object.keys(f.store.state('w').facts).length,0);
 }finally{f.store.close();}
});
test('teaching deadline aborts the owned provider signal and consumes late inference',async()=>{
 let signal;const f=fixture([async r=>{signal=r.signal;await new Promise(resolve=>setTimeout(resolve,60));return {text:'{"outcome":"none"}'};}],20);
 try{await f.run('Remember mornings.');assert.ok(signal);assert.equal(signal.aborted,true);}finally{f.store.close();}
});
test('no-loop teaching final inference shares cancellation and cannot commit after artifact-write delay',async()=>{
 const store=new SqliteStore(':memory:');store.createWorkspace('w','o');new Operator(store).createWork('w','o',{id:'task',title:'Task',goal:'Synthetic',threadId:'t'});
 const originalNow=Date.now;let now=originalNow();let calls=0;let finalSignal;const originalPut=store.putArtifact.bind(store);
 try{
 Date.now=()=>now;
 const agent=new AgentService(store,{listModels:async()=>[],complete:async r=>{if(++calls===1)return {text:'{"outcome":"none"}'};finalSignal=r.signal;store.putArtifact=(...args)=>{const value=originalPut(...args);now+=120001;store.putArtifact=originalPut;return value;};return {text:JSON.stringify({reply:'Created.',workProposals:[{id:'late',title:'Late',goal:'Late'}],factProposals:[]})};}},undefined,undefined,{teachingMode:true});
 await agent.runOwnerTurn({workspaceId:'w',ownerId:'o',threadId:'t',workId:'task',externalId:'x',model,text:'What now?'});
 assert.equal(store.state('w').works.late,undefined);assert.ok(finalSignal);assert.equal(finalSignal.aborted,true);
 }finally{Date.now=originalNow;store.close();}
});
test('extraction rejects oversized input before inference and malformed or oversized output without retry',async()=>{
 const {extractTeachings}=await import('../dist/runtime/teaching-extractor.js');let calls=0;
 const gateway={listModels:async()=>[],complete:async()=>{calls++;return {text:'{"outcome":"none"}'};}};
 await assert.rejects(()=>extractTeachings(gateway,model,{currentOwnerText:'x'.repeat(200000),teachings:[],clarifications:[]},{deadline:Date.now()+5000}),/budget/);assert.equal(calls,0);
 for(const response of [{text:'not-json'},{text:'x'.repeat(65537)},{text:'{"outcome":"none"}',diagnosticText:'x'.repeat(65537)}]){
  let attempts=0;await assert.rejects(()=>extractTeachings({listModels:async()=>[],complete:async()=>{attempts++;return response;}},model,{currentOwnerText:'Hello',teachings:[],clarifications:[]},{deadline:Date.now()+5000}));assert.equal(attempts,1);
 }
});
