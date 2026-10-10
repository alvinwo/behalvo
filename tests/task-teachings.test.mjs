import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../dist/storage/sqlite-store.js';
import { Operator } from '../dist/runtime/operator.js';

async function api() { return import('../dist/runtime/teachings.js'); }
function setup() {
 const store = new SqliteStore(':memory:'); store.createWorkspace('w','o');
 const op = new Operator(store); op.createWork('w','o',{id:'task',title:'Task',goal:'Synthetic task',threadId:'t'});
 return {store,op};
}
function source(store,text,threadId='t',senderRole='owner') {
 return store.ingest('w',{source:'local',externalId:crypto.randomUUID(),threadId,senderId:'o',senderRole,text});
}
async function apply(store,text,result) {
 const {prepareTeachingEvents}=await api(); const record=source(store,text);
 const binding={workspaceId:'w',ownerId:'o',workId:'task',ownerRecordId:record.id,expectedWorkRevision:store.state('w').works.task.revision};
 const events=prepareTeachingEvents(store,binding,result);
 store.append('w',store.state('w').version,events,{actorId:'o',causationId:record.id});
 return store.state('w');
}
test('teachings preserve exact Unicode source, replace by new identity, retract without losing original evidence',async()=>{
 const {store}=setup(); try {
 let s=await apply(store,'🌱 Remember: prefer morning sessions.',{outcome:'apply',changes:[{kind:'add',sourceQuote:'prefer morning sessions',interpretation:'Morning preference'}],resolutions:[]});
 let a=Object.values(s.teachingMemory.teachings)[0]; assert.equal(a.sourceStart,13); assert.equal(a.sourceQuote,'prefer morning sessions'); assert.equal(a.status,'active');
 const oldRevision=s.works.task.revision;
 s=await apply(store,'Change to afternoon sessions.',{outcome:'apply',changes:[{kind:'replace',teachingId:a.id,expectedRevision:1,sourceQuote:'afternoon sessions',interpretation:'Afternoon preference'}],resolutions:[]});
 const b=Object.values(s.teachingMemory.teachings).find(x=>x.status==='active');
 assert.notEqual(a.id,b.id); assert.equal(b.supersedes,a.id); assert.equal(s.teachingMemory.teachings[a.id].sourceQuote,a.sourceQuote); assert.ok(s.works.task.revision>oldRevision);
 s=await apply(store,'Forget the afternoon preference.',{outcome:'apply',changes:[{kind:'retract',teachingId:b.id,expectedRevision:1,sourceQuote:'Forget the afternoon preference.'}],resolutions:[]});
 assert.equal(s.teachingMemory.teachings[b.id].status,'retracted'); assert.equal(s.teachingMemory.teachings[b.id].sourceQuote,'afternoon sessions'); assert.equal(s.teachingMemory.teachings[b.id].retractionSource.sourceQuote,'Forget the afternoon preference.');
 assert.deepEqual(store.rebuild('w'),s);
 } finally {store.close();}
});
test('invalid, ambiguous, forged, duplicate and cross-scope teaching changes append nothing',async()=>{
 const {store}=setup(); try {
 const {prepareTeachingEvents}=await api(); const record=source(store,'same same');
 const binding={workspaceId:'w',ownerId:'o',workId:'task',ownerRecordId:record.id,expectedWorkRevision:1};
 for(const quote of ['same','absent','']) assert.throws(()=>prepareTeachingEvents(store,binding,{outcome:'apply',changes:[{kind:'add',sourceQuote:quote,interpretation:'hint'}],resolutions:[]}));
 const valid={outcome:'apply',changes:[{kind:'add',sourceQuote:'same same',interpretation:'hint'}],resolutions:[]};
 for(const override of [{ownerId:'intruder'},{expectedWorkRevision:99},{workId:'missing'},{ownerRecordId:source(store,'same same','other').id},{ownerRecordId:source(store,'same same','t','external').id}]) assert.throws(()=>prepareTeachingEvents(store,{...binding,...override},valid));
 assert.throws(()=>prepareTeachingEvents(store,binding,{...valid,changes:[{...valid.changes[0],sourceRecordId:'invented'}]}));
 assert.equal(Object.keys(store.state('w').teachingMemory.teachings).length,0);
 } finally {store.close();}
});
test('ambiguous correction holds work, survives replay, and only sourced resolution releases it',async()=>{
 const {store,op}=setup(); try {
 let s=await apply(store,'Change that preference.',{outcome:'clarify',sourceQuote:'Change that preference.',targets:[],question:'Which preference?'});
 const hold=Object.values(s.teachingMemory.clarifications)[0]; assert.equal(hold.status,'open');
 assert.throws(()=>op.propose('w',{workId:'task',key:'x',command:{kind:'message.send',channel:'mock-email',to:'synthetic@example.test',body:'hi'}}),/clarif/i);
 assert.deepEqual(store.rebuild('w'),s);
 s=await apply(store,'Keep the existing preferences.',{outcome:'apply',changes:[],resolutions:[{clarificationId:hold.id,sourceQuote:'Keep the existing preferences.'}]});
 assert.equal(s.teachingMemory.clarifications[hold.id].status,'resolved');
 assert.ok(op.propose('w',{workId:'task',key:'y',command:{kind:'message.send',channel:'mock-email',to:'synthetic@example.test',body:'hi'}}));
 } finally {store.close();}
});
test('teaching changes invalidate previous approvals and forged source cannot enter journal',async()=>{
 const {store,op}=setup(); try {
 const a=op.propose('w',{workId:'task',key:'x',command:{kind:'message.send',channel:'mock-email',to:'synthetic@example.test',body:'hi'}});
 op.approve('w','o',a.id,a.digest,new Date(Date.now()+60000).toISOString());
 await apply(store,'Prefer morning.',{outcome:'apply',changes:[{kind:'add',sourceQuote:'Prefer morning.',interpretation:'Morning'}],resolutions:[]});
 assert.throws(()=>op.startEffect('w',a.id,'mock-email'),/stale/i);
 const {prepareTeachingEvents}=await api(); const r=source(store,'Keep mornings.');
 const events=prepareTeachingEvents(store,{workspaceId:'w',ownerId:'o',workId:'task',ownerRecordId:r.id,expectedWorkRevision:store.state('w').works.task.revision},{outcome:'apply',changes:[{kind:'add',sourceQuote:'Keep mornings.',interpretation:'Morning'}],resolutions:[]});
 events[0].data.teaching.sourceQuote='Fabricated'; const before=store.state('w');
 assert.throws(()=>store.append('w',before.version,events)); assert.deepEqual(store.state('w'),before);
 } finally {store.close();}
});
test('a batch with duplicate or stale target never commits a valid prefix',async()=>{
 const {store}=setup(); try {
 const s=await apply(store,'Remember mornings.',{outcome:'apply',changes:[{kind:'add',sourceQuote:'mornings',interpretation:'morning'}],resolutions:[]});
 const a=Object.values(s.teachingMemory.teachings)[0]; const before=store.state('w');
 await assert.rejects(()=>apply(store,'Replace mornings with evenings.',{outcome:'apply',changes:[{kind:'replace',teachingId:a.id,expectedRevision:1,sourceQuote:'evenings',interpretation:'evening'},{kind:'retract',teachingId:a.id,expectedRevision:1,sourceQuote:'mornings'}],resolutions:[]}));
 assert.deepEqual(store.state('w').teachingMemory,before.teachingMemory);
 await assert.rejects(()=>apply(store,'Forget mornings.',{outcome:'apply',changes:[{kind:'retract',teachingId:a.id,expectedRevision:99,sourceQuote:'Forget mornings.'}],resolutions:[]}));
 assert.deepEqual(store.state('w').teachingMemory,before.teachingMemory);
 } finally {store.close();}
});
