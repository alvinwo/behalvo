import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, createWork, message, propose, approve} from './helpers.mjs';

const api = () => import('../dist/runtime/task-continuity.js');
const append = (f, event) => f.store.append('personal', f.store.state('personal').version, [event]);
test('focus survives restart, is workspace scoped, and requires the owner and an open task', async t => {
 const f = await fixture(t); createWork(f); const {selectTaskThread, restoreTaskThread} = await api();
 selectTaskThread(f.store, 'personal', 'owner', 'im', 'w', true);
 f.restart(); assert.deepEqual(restoreTaskThread(f.store, 'personal'), {threadId:'im', workId:'w'});
 selectTaskThread(f.store, 'personal', 'owner', 'fresh', null, true);
 f.restart(); assert.deepEqual(restoreTaskThread(f.store, 'personal'), {threadId:'fresh'});
 assert.deepEqual(restoreTaskThread(f.store, 'personal','im'), {threadId:'im',workId:'w'});
 f.store.createWorkspace('other','owner'); assert.equal(restoreTaskThread(f.store,'other'), undefined);
 assert.throws(()=>selectTaskThread(f.store,'personal','intruder','im','w',true), /owner/i);
 append(f,{type:'work.phase_changed',data:{id:'w',phase:'cancelled'}});
 assert.throws(()=>selectTaskThread(f.store,'personal','owner','im','w',true), /closed|stale/i);
 assert.deepEqual(restoreTaskThread(f.store,'personal','im'),{threadId:'im'});
});
test('progress is source scoped, revisioned and cannot invalidate an approval or complete work', async t => {
 const f=await fixture(t); createWork(f); const {prepareProgressEvent}=await api();
 const owner=f.store.ingest('personal',message('p'));
 const action=propose(f); approve(f,action); const before=f.store.state('personal');
 const binding={workspaceId:'personal',ownerId:'owner',workId:'w',ownerRecordId:owner.id,expectedWorkRevision:before.works.w.revision};
 const report={summary:'Done according to the model',nextStep:'Verify the actual result',blocker:null,references:[{kind:'action',id:action.id}]};
 const event=prepareProgressEvent(f.store,binding,report,'final');append(f,event);
 const after=f.store.state('personal');assert.equal(after.works.w.phase,'open');assert.equal(after.works.w.revision,before.works.w.revision);assert.deepEqual(after.actions,before.actions);
 assert.throws(()=>append(f,event),/revision|stale/i);
 f.restart();assert.deepEqual(f.store.rebuild('personal'),f.store.state('personal'));
 assert.equal(f.store.state('personal').taskContinuity.progress.w.summary,report.summary);
 createWork(f,'other'); const foreign=f.operator.propose('personal',{workId:'other',key:'foreign',command:action.command});
 assert.throws(()=>append(f,prepareProgressEvent(f.store,binding,{...report,references:[{kind:'action',id:foreign.id}]},'final')),/scope/i);
 const ext=f.store.ingest('personal',message('external',{senderRole:'external',senderId:'stranger'}));
 assert.throws(()=>append(f,prepareProgressEvent(f.store,binding,{...report,references:[{kind:'owner_message',id:ext.id}]},'final')),/owner|source/i);
 assert.throws(()=>prepareProgressEvent(f.store,binding,{...report,summary:'x'.repeat(2049)},'final'));
});
test('intake receipts require exact owner provenance and cannot be overwritten', async t=>{
 const f=await fixture(t);createWork(f); const owner=f.store.ingest('personal',message('intake',{text:'Check synthetic slots'}));
 const receipt={ownerRecordId:owner.id,threadId:'im',workId:'w',workRevisionAtIntake:1,outcome:'ready',goalSourceQuote:'Check synthetic slots'};
 append(f,{type:'task.intake_recorded',data:{receipt}});
 assert.throws(()=>append(f,{type:'task.intake_recorded',data:{receipt}}),/duplicate/i);
 const other=f.store.ingest('personal',message('bad'));
 assert.throws(()=>append(f,{type:'task.intake_recorded',data:{receipt:{...receipt,ownerRecordId:other.id}}}),/quote|source/i);
 assert.deepEqual(f.store.rebuild('personal'),f.store.state('personal'));
});
