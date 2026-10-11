import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,createWork,message} from './helpers.mjs';
const model={provider:'fake',model:'synthetic'};
const none={outcome:'none'};
const intake = async(f,text,result,externalId='one',extra={})=>{
 const {processTaskIntake}=await import('../dist/runtime/task-intake.js');
 const owner=f.store.ingest('personal',message(externalId,{text}));
 let request;const gateway={complete:async r=>{request=r;return {text:JSON.stringify(result)}}};
 const output=await processTaskIntake(f.store,gateway,model,{workspaceId:'personal',ownerId:'owner',threadId:'im',ownerRecordId:owner.id,...extra},{deadline:Date.now()+10000},56000);
 return {output,request,owner};
};
test('ordinary goal and preference create focused work and committed owner teachings atomically',async t=>{
 const f=await fixture(t);const text='Check synthetic appointments. Only use December dates.';
 const {output}=await intake(f,text,{task:{kind:'create',title:'Synthetic appointments',goal:'Check appointments',sourceQuote:'Check synthetic appointments.'},teachings:{outcome:'apply',changes:[{kind:'add',sourceQuote:'Only use December dates.',interpretation:'Use December dates'}],resolutions:[]}});
 const state=f.store.state('personal');const id=output.receipt.workId;
 assert.equal(Object.keys(state.works).length,1);assert.equal(state.taskContinuity.focus.im.workId,id);
 assert.equal(state.works[id].revision,2);assert.equal(Object.values(state.teachingMemory.teachings)[0].sourceQuote,'Only use December dates.');
 assert.equal(f.store.inbox('personal').length,1);assert.deepEqual(f.store.rebuild('personal'),state);
});
test('explicit retry reuses receipt without inference, duplication, or restoring old focus',async t=>{
 const f=await fixture(t);const text='Check appointments';const result={task:{kind:'create',title:'Appointments',goal:text,sourceQuote:text},teachings:none};
 const {output,owner}=await intake(f,text,result);createWork(f,'newer');
 const {selectTaskThread}=await import('../dist/runtime/task-continuity.js');selectTaskThread(f.store,'personal','owner','im','newer',true);
 const before=f.store.state('personal');const {processTaskIntake}=await import('../dist/runtime/task-intake.js');
 const reused=await processTaskIntake(f.store,{complete:()=>assert.fail('retry re-extracted')},model,{workspaceId:'personal',ownerId:'owner',threadId:'im',ownerRecordId:owner.id},{deadline:Date.now()+10000},56000);
 assert.equal(reused.completionsUsed,0);assert.deepEqual(reused.receipt,output.receipt);assert.deepEqual(f.store.state('personal'),before);
 await assert.rejects(()=>processTaskIntake(f.store,{complete:()=>assert.fail()},model,{workspaceId:'personal',ownerId:'owner',threadId:'im',ownerRecordId:owner.id,workId:'newer'},{deadline:Date.now()+10000},56000),/binding|retarget/i);
});
test('A to B correction receives owner sources for B and cannot replace an A teaching',async t=>{
 const f=await fixture(t);createWork(f,'a');createWork(f,'b');createWork(f,'unrelated');
 const {prepareTeachingEvents}=await import('../dist/runtime/teachings.js');const {selectTaskThread}=await import('../dist/runtime/task-continuity.js');
 for(const id of ['a','b','unrelated']){const r=f.store.ingest('personal',message(id,{text:`Use ${id} December dates`}));const s=f.store.state('personal');f.store.append('personal',s.version,prepareTeachingEvents(f.store,{workspaceId:'personal',ownerId:'owner',workId:id,ownerRecordId:r.id,expectedWorkRevision:1},{outcome:'apply',changes:[{kind:'add',sourceQuote:`Use ${id} December dates`,interpretation:'Model interpretation must not enter intake'}],resolutions:[]}));}
 selectTaskThread(f.store,'personal','owner','im','a',true);const teachings=Object.values(f.store.state('personal').teachingMemory.teachings);const b=teachings.find(x=>x.workId==='b');const a=teachings.find(x=>x.workId==='a');
 const result={task:{kind:'select',workId:'b',sourceQuote:'For b'},teachings:{outcome:'apply',changes:[{kind:'replace',teachingId:b.id,expectedRevision:1,sourceQuote:'use January dates',interpretation:'Use January'}],resolutions:[]}};
 const {request}=await intake(f,'For b use January dates',result);
 assert.ok(request.prompt.includes(b.id));assert.ok(!request.prompt.includes('Use unrelated'));assert.ok(!request.prompt.includes('Model interpretation'));assert.ok(!request.prompt.includes('synthetic refund'));
 assert.equal(f.store.state('personal').teachingMemory.teachings[a.id].status,'active');assert.equal(f.store.state('personal').teachingMemory.teachings[b.id].status,'superseded');
 const before=f.store.state('personal');await assert.rejects(()=>intake(f,'For b use February dates',{task:{kind:'select',workId:'b',sourceQuote:'For b'},teachings:{outcome:'apply',changes:[{kind:'replace',teachingId:a.id,expectedRevision:1,sourceQuote:'use February dates',interpretation:'Use February'}],resolutions:[]}},'bad'),/target/i);
 assert.deepEqual(f.store.state('personal').teachingMemory,before.teachingMemory);
});
test('invented sources, ambiguous task naming and cancelled intake cannot silently proceed',async t=>{
 const f=await fixture(t);
 await assert.rejects(()=>intake(f,'Check slots',{task:{kind:'create',title:'T',goal:'T',sourceQuote:'invented'},teachings:none}),/quote/i);assert.equal(Object.keys(f.store.state('personal').works).length,0);
 createWork(f,'a');createWork(f,'b');
 await assert.rejects(()=>intake(f,'A synthetic refund follow-up',{task:{kind:'select',workId:'a',sourceQuote:'A synthetic refund follow-up'},teachings:none},'ambiguous'),/ambiguous/i);
 const {processTaskIntake}=await import('../dist/runtime/task-intake.js');const r=f.store.ingest('personal',message('cancel',{text:'Check slots'}));const controller=new AbortController();
 await assert.rejects(()=>processTaskIntake(f.store,{complete:async()=>{controller.abort();return {text:JSON.stringify({task:{kind:'keep'},teachings:none})}}},model,{workspaceId:'personal',ownerId:'owner',threadId:'im',ownerRecordId:r.id},{deadline:Date.now()+10000,signal:controller.signal},56000));
 assert.equal(f.store.state('personal').taskContinuity.intakes[r.id],undefined);
});
test('intake cannot commit after a SQLite writer wait exceeds its deadline',async t=>{
 const f=await fixture(t);const {processTaskIntake}=await import('../dist/runtime/task-intake.js');const {holdSqliteWriteLock}=await import('./sqlite-lock-helper.mjs');
 const r=f.store.ingest('personal',message('lock',{text:'Check slots'}));let lock;
 try{
  await assert.rejects(()=>processTaskIntake(f.store,{complete:async()=>{lock=holdSqliteWriteLock(f.path,220);return {text:JSON.stringify({task:{kind:'create',title:'Slots',goal:'Check slots',sourceQuote:'Check slots'},teachings:none})}}},model,{workspaceId:'personal',ownerId:'owner',threadId:'im',ownerRecordId:r.id},{deadline:Date.now()+150},56000));
  assert.equal(Object.keys(f.store.state('personal').works).length,0);assert.equal(f.store.state('personal').taskContinuity.intakes[r.id],undefined);
 }finally{await lock;}
});
test('intake enforces request and response budgets and commit fence without changing state',async t=>{
 const f=await fixture(t);const {processTaskIntake}=await import('../dist/runtime/task-intake.js');const r=f.store.ingest('personal',message('limits'));
 const binding={workspaceId:'personal',ownerId:'owner',threadId:'im',ownerRecordId:r.id};let calls=0;
 await assert.rejects(()=>processTaskIntake(f.store,{complete:()=>{calls++;assert.fail()}},model,binding,{deadline:Date.now()+5000},10),/budget/);assert.equal(calls,0);
 for(const response of [{text:'x'.repeat(65537)},{text:'{}',diagnosticText:'x'.repeat(65537)}])await assert.rejects(()=>processTaskIntake(f.store,{complete:async()=>response},model,binding,{deadline:Date.now()+5000},56000),/budget/);
 await assert.rejects(()=>processTaskIntake(f.store,{complete:async()=>({text:JSON.stringify({task:{kind:'keep'},teachings:none})})},model,{...binding,assertCommitCurrent:()=>{throw new Error('fence changed')}},{deadline:Date.now()+5000},56000),/fence/);
 assert.equal(f.store.state('personal').taskContinuity.intakes[r.id],undefined);
});
