import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { SqliteStore } from '../dist/storage/sqlite-store.js';
import { Operator } from '../dist/runtime/operator.js';
import { AgentService } from '../dist/runtime/agent-service.js';
import { buildContext } from '../dist/memory/context.js';
const model={provider:'fake',model:'synthetic'};
test('encrypted teaching lifecycle survives restart, backup and restore with retired sources out of active recall',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'teach-life-'));const key=randomBytes(32);const path=join(dir,'db');let store;
 try{
 store=new SqliteStore(path,{encryptionKey:key});store.createWorkspace('w','o');new Operator(store).createWork('w','o',{id:'task',title:'Task',goal:'Synthetic',threadId:'t'});
 let response;const gateway={listModels:async()=>[],complete:async()=>({text:JSON.stringify(response)})};let i=0;
 const run=text=>new AgentService(store,gateway,undefined,undefined,{teachingMode:true}).runOwnerTurn({workspaceId:'w',ownerId:'o',workId:'task',threadId:'t',externalId:String(++i),text,model});
 response={outcome:'apply',changes:[{kind:'add',sourceQuote:'Prefer mornings.',interpretation:'Morning'}],resolutions:[]};await run('Prefer mornings.');
 const first=Object.values(store.state('w').teachingMemory.teachings)[0];store.close();store=new SqliteStore(path,{encryptionKey:key});
 assert.equal(store.state('w').teachingMemory.teachings[first.id].sourceQuote,'Prefer mornings.');
 response={outcome:'apply',changes:[{kind:'replace',teachingId:first.id,expectedRevision:1,sourceQuote:'Prefer afternoons.',interpretation:'Afternoon'}],resolutions:[]};await run('Prefer afternoons.');
 const second=Object.values(store.state('w').teachingMemory.teachings).find(t=>t.status==='active');
 response={outcome:'apply',changes:[{kind:'retract',teachingId:second.id,expectedRevision:1,sourceQuote:'Forget afternoons.'}],resolutions:[]};await run('Forget afternoons.');
 new Operator(store).linkThread('w','o','task','new');
 assert.doesNotMatch(buildContext(store,{workspaceId:'w',ownerId:'o',workId:'task',threadId:'new',windowTokens:64000,outputReserve:1000}).text,/Prefer afternoons|Prefer mornings/);
 const before=store.state('w');await store.backup(join(dir,'backup'));store.close();store=new SqliteStore(join(dir,'backup'),{encryptionKey:key});assert.deepEqual(store.rebuild('w'),before);
 }finally{store?.close();key.fill(0);rmSync(dir,{recursive:true,force:true});}
});
test('admitted owner teaching turn commits reply, teaching and inbox together',async()=>{
 const store=new SqliteStore(':memory:',{serviceQueue:{upgradeExisting:false}});try{
 store.createWorkspace('w','o');new Operator(store).createWork('w','o',{id:'task',title:'Task',goal:'Synthetic',threadId:'t'});
 const at=new Date().toISOString();const admitted=store.admitOwnerTurnJob({workspaceId:'w',ownerId:'o',source:'owner:service',requestId:'r',envelope:{kind:'owner_turn',threadId:'t',workId:'task',text:'Prefer mornings.'},accepted:{threadId:'t',workId:'task',model,windowTokens:16000,outputReserve:1000,capability:'prepare_only'},instanceId:'test',at});
 const job=store.claimServiceJob('w','worker',at);
 const agent=new AgentService(store,{listModels:async()=>[],complete:async()=>({text:JSON.stringify({outcome:'apply',changes:[{kind:'add',sourceQuote:'Prefer mornings.',interpretation:'Morning'}],resolutions:[]})})},undefined,undefined,{teachingMode:true});
 const r=await agent.processAdmittedOwnerTurn({workspaceId:'w',ownerId:'o',job,fence:{deadline:Date.now()+5000,signal:new AbortController().signal,assertCurrent:async()=>{}}});
 assert.equal(store.serviceJob('w',admitted.job.id).status,'finished');assert.equal(store.inbox('w').length,0);assert.equal(Object.keys(store.state('w').teachingMemory.teachings).length,1);assert.match(r.turn.reply,/updated/);
 }finally{store.close();}
});
test('admitted teaching commit cannot cross its shorter deadline while waiting for SQLite',async()=>{
 const {holdSqliteWriteLock}=await import('./sqlite-lock-helper.mjs');const {OperationRegistry}=await import('../dist/operations/registry.js');const {OperationService}=await import('../dist/operations/service.js');
 const dir=mkdtempSync(join(tmpdir(),'teach-lock-'));const path=join(dir,'db');const store=new SqliteStore(path,{serviceQueue:{upgradeExisting:false}});let lock;
 try{
 store.createWorkspace('w','o');new Operator(store).createWork('w','o',{id:'task',title:'Task',goal:'Synthetic',threadId:'t'});const at=new Date().toISOString();
 store.admitOwnerTurnJob({workspaceId:'w',ownerId:'o',source:'owner:service',requestId:'r',envelope:{kind:'owner_turn',threadId:'t',workId:'task',text:'Prefer mornings.'},accepted:{threadId:'t',workId:'task',model,windowTokens:16000,outputReserve:1000,capability:'prepare_only'},instanceId:'test',at});
 const job=store.claimServiceJob('w','worker',at);const registry=new OperationRegistry();
 const agent=new AgentService(store,{listModels:async()=>[],complete:async()=>{lock=holdSqliteWriteLock(path,220);return {text:JSON.stringify({outcome:'apply',changes:[{kind:'add',sourceQuote:'Prefer mornings.',interpretation:'Morning'}],resolutions:[]})};}},undefined,{registry,service:new OperationService(store,registry),timeoutMs:150},{teachingMode:true});
 await assert.rejects(()=>agent.processAdmittedOwnerTurn({workspaceId:'w',ownerId:'o',job,fence:{deadline:Date.now()+5000,signal:new AbortController().signal,assertCurrent:async()=>{}}}));
 assert.equal(Object.keys(store.state('w').teachingMemory.teachings).length,0);
 }finally{await lock;store.close();rmSync(dir,{recursive:true,force:true});}
});
test('admitted cancellation leaves teaching, reply and inbox settlement uncommitted',async()=>{
 const store=new SqliteStore(':memory:',{serviceQueue:{upgradeExisting:false}});
 try{
  store.createWorkspace('w','o');new Operator(store).createWork('w','o',{id:'task',title:'Task',goal:'Synthetic',threadId:'t'});
  const at=new Date().toISOString();store.admitOwnerTurnJob({workspaceId:'w',ownerId:'o',source:'owner:service',requestId:'r',envelope:{kind:'owner_turn',threadId:'t',workId:'task',text:'Prefer mornings.'},accepted:{threadId:'t',workId:'task',model,windowTokens:16000,outputReserve:1000,capability:'prepare_only'},instanceId:'test',at});
  const job=store.claimServiceJob('w','worker',at);const before=store.state('w');const inbox=store.inbox('w');const controller=new AbortController();
  const agent=new AgentService(store,{listModels:async()=>[],complete:async()=>{controller.abort();return {text:JSON.stringify({outcome:'apply',changes:[{kind:'add',sourceQuote:'Prefer mornings.',interpretation:'Morning'}],resolutions:[]})};}},undefined,undefined,{teachingMode:true});
  await assert.rejects(()=>agent.processAdmittedOwnerTurn({workspaceId:'w',ownerId:'o',job,fence:{deadline:Date.now()+5000,signal:controller.signal,assertCurrent:async()=>{}}}));
  assert.deepEqual(store.state('w'),before);assert.deepEqual(store.inbox('w'),inbox);assert.equal(store.serviceJob('w',job.id).status,'running');
 }finally{store.close();}
});
