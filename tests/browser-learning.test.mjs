import test from 'node:test';import assert from 'node:assert/strict';import {SqliteStore} from '../dist/storage/sqlite-store.js';import {Operator} from '../dist/runtime/operator.js';
const observation={workspaceId:'w',workId:'task',workRevision:1,sessionId:'s',generation:1,id:'obs',documentId:'doc',origin:'http://127.0.0.1:43117',location:'/',observedAt:'2026-10-10T00:00:00.000Z',text:'Synthetic morning session',controls:[]};
function setup(){const store=new SqliteStore(':memory:');store.createWorkspace('w','o');new Operator(store).createWork('w','o',{id:'task',title:'Task',goal:'Synthetic',threadId:'t'});const record=store.ingest('w',{source:'owner',externalId:'1',threadId:'t',senderId:'o',senderRole:'owner',text:'Use morning for the session search.'});return{store,record,binding:{workspaceId:'w',ownerId:'o',workId:'task',ownerRecordId:record.id,expectedWorkRevision:1}};}
test('browser observation notes retain immutable evidence and replay without browser calls',async()=>{
 const {recordBrowserObservation,prepareBrowserLearningEvents,retireBrowserNote}=await import('../dist/runtime/browser-learning.js');const {store,binding}=setup();try{
 const source=recordBrowserObservation(store,binding,observation);
 const events=prepareBrowserLearningEvents(store,binding,[{text:'Morning sessions are listed here.',sourceIds:[source.id]}]);store.append('w',store.state('w').version,events);
 const before=store.state('w');assert.equal(Object.keys(before.browserMemory.notes).length,1);assert.deepEqual(store.rebuild('w'),before);
 for(const proposal of [[{text:'forged',sourceIds:['missing']}],[{text:'forged',sourceIds:[source.id],workId:'other'}]])assert.throws(()=>prepareBrowserLearningEvents(store,binding,proposal));
 assert.throws(()=>prepareBrowserLearningEvents(store,{...binding,workId:'other'},[{text:'foreign',sourceIds:[source.id]}]));
 const id=Object.keys(before.browserMemory.notes)[0];retireBrowserNote(store,binding,id,'Navigation changed.');assert.equal(store.state('w').browserMemory.notes[id].status,'invalidated');
 }finally{store.close();}
});
test('only sourced owner admission creates input bindings; revision changes and revocation deny reuse',async()=>{
 const {authorizeTaskInput,revokeTaskInput,resolveStoredTaskInput}=await import('../dist/runtime/browser-learning.js');const {store,binding}=setup();try{
 const input=authorizeTaskInput(store,binding,{quote:'morning',origin:observation.origin,purpose:'session-period'});assert.equal(resolveStoredTaskInput(store,binding,input.id,observation.origin,'session-period'),'morning');
 assert.throws(()=>authorizeTaskInput(store,binding,{quote:'CANARY',origin:observation.origin,purpose:'session-period'}));
 assert.throws(()=>resolveStoredTaskInput(store,binding,input.id,observation.origin,'password'));
 revokeTaskInput(store,binding,input.id);assert.throws(()=>resolveStoredTaskInput(store,binding,input.id,observation.origin,'session-period'));
 assert.deepEqual(store.rebuild('w'),store.state('w'));
 }finally{store.close();}
});
test('historical note groups fit remaining context without exposing reusable controls or other work',async()=>{
 const {recordBrowserObservation,prepareBrowserLearningEvents}=await import('../dist/runtime/browser-learning.js');const {buildContext}=await import('../dist/memory/context.js');const {store,binding}=setup();try{
 const source=recordBrowserObservation(store,binding,observation);store.append('w',store.state('w').version,prepareBrowserLearningEvents(store,binding,[{text:'Use the session directory.',sourceIds:[source.id]}]));
 const context=buildContext(store,{workspaceId:'w',ownerId:'o',workId:'task',threadId:'t',windowTokens:12000,outputReserve:1000});assert.equal(context.includedBrowserNoteIds.length,1);assert.match(context.text,/HISTORICAL BROWSER NOTES/);assert.doesNotMatch(context.text,/"documentId"|"controls"/);
 for(let i=0;i<12;i++)store.append('w',store.state('w').version,prepareBrowserLearningEvents(store,binding,[{text:'Optional note '+i+'x'.repeat(1800),sourceIds:[source.id]}]));
 const bounded=buildContext(store,{workspaceId:'w',ownerId:'o',workId:'task',threadId:'t',windowTokens:5000,outputReserve:1000});assert.ok(bounded.includedBrowserNoteIds.length<13);
 assert.throws(()=>buildContext(store,{workspaceId:'w',ownerId:'o',workId:'task',threadId:'unlinked',windowTokens:12000,outputReserve:1000}));
 }finally{store.close();}
});
