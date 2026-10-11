import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,createWork,message} from './helpers.mjs';
import {buildContext} from '../dist/memory/context.js';
import {prepareTeachingEvents} from '../dist/runtime/teachings.js';

export function attributed(f,id,workId,text,threadId='im') {
 const r=f.store.ingest('personal',message(id,{text,threadId}));
 f.store.append('personal',f.store.state('personal').version,[{type:'task.intake_recorded',data:{receipt:{ownerRecordId:r.id,threadId,workId,workRevisionAtIntake:workId===null?null:f.store.state('personal').works[workId].revision,outcome:'ready'}}}]);
 return r;
}
const context=(f,workId)=>buildContext(f.store,{workspaceId:'personal',ownerId:'owner',threadId:'im',workId,windowTokens:64000,outputReserve:1000});
const binding={workspaceId:'personal',ownerId:'owner',threadId:'im',workId:'w'};
test('task switches exclude unrelated owner and agent history and mixed summaries after restart',async t=>{
 const f=await fixture(t);createWork(f);createWork(f,'b');
 const a=attributed(f,'a','w','A_ONLY appointment morning');
 const b=attributed(f,'b','b','B_ONLY unrelated shopping');
 const reply=f.store.putArtifact('personal','B_REPLY purchased nothing');
 f.store.completeInbox('personal',b.id,f.store.state('personal').version,[{type:'message.received',data:{source:'agent:model',externalId:'reply-b',threadId:'im',senderId:'agent',senderRole:'agent',artifactId:reply}}]);
 f.store.ingest('personal',message('legacy',{text:'LEGACY_UNCLASSIFIED'}));
 const mixed=f.store.saveSummary('personal',{threadId:'im',sourceIds:[a.id,b.id],text:'MIXED_SUMMARY'});
 f.restart();const packet=context(f,'w');
 assert.match(packet.text,/A_ONLY/);assert.doesNotMatch(packet.text,/B_ONLY|B_REPLY|LEGACY_UNCLASSIFIED|MIXED_SUMMARY/);
 assert.ok(!packet.includedSummaryIds.includes(mixed.id));
 const other=context(f,'b');assert.match(other.text,/B_REPLY/);assert.doesNotMatch(other.text,/A_ONLY/);
});
test('teaching memory exposes exact quotes without unrelated parts of the owner source',async t=>{
 const f=await fixture(t);createWork(f);
 const r=f.store.ingest('personal',message('mixed',{text:'Task A: prefer morning. Task B: OTHER_PRIVATE_CONTENT.'}));
 f.store.append('personal',f.store.state('personal').version,prepareTeachingEvents(f.store,{...binding,ownerRecordId:r.id,expectedWorkRevision:1},{outcome:'apply',changes:[{kind:'add',sourceQuote:'prefer morning',interpretation:'Morning preference'}],resolutions:[]}));
 const packet=context(f,'w');assert.match(packet.text,/prefer morning/);assert.doesNotMatch(packet.text,/OTHER_PRIVATE_CONTENT/);
});
test('recall is task attributed, workspace bound, paginated and keeps causation provenance',async t=>{
 const f=await fixture(t);createWork(f);createWork(f,'b');f.operator.linkThread('personal','owner','w','second');
 const first=attributed(f,'first','w','Meeting café Alpha');
 const second=attributed(f,'second','w','Meeting CAFÉ Beta','second');
 attributed(f,'foreign','b','Meeting café foreign');
 f.store.ingest('personal',message('unclassified',{text:'Meeting café legacy'}));
 const {recallHistory}=await import('../dist/memory/session-history.js');
 const version=f.store.state('personal').version;
 const result=recallHistory(f.store,binding,{query:'café',scope:'work',limit:1,beforeSeq:null});
 assert.equal(result.records.length,1);assert.equal(result.records[0].recordId,second.id);assert.equal(result.records[0].threadId,'second');
 const page=recallHistory(f.store,binding,{query:'café',scope:'work',limit:1,beforeSeq:result.nextBeforeSeq});assert.equal(page.records[0].recordId,first.id);
 assert.equal(recallHistory(f.store,binding,{query:'café',scope:'thread',limit:20,beforeSeq:null}).records.length,1);
 assert.equal(f.store.state('personal').version,version);
 for(const bad of [{...binding,ownerId:'intruder'},{...binding,audience:'external'},{...binding,threadId:'unlinked'}])assert.throws(()=>recallHistory(f.store,bad,{query:'café',scope:'work',limit:20,beforeSeq:null}));
 for(const bad of [{query:'',scope:'work',limit:20,beforeSeq:null},{query:'café',scope:'global',limit:20,beforeSeq:null},{query:'café',scope:'work',limit:21,beforeSeq:null},{query:'café',scope:'work',limit:20,beforeSeq:null,workspaceId:'other'}])assert.throws(()=>recallHistory(f.store,binding,bad));
});
test('recall excerpts include a distant literal match and bound multibyte output',async t=>{
 const f=await fixture(t);createWork(f);
 for(let i=0;i<20;i++)attributed(f,'long-'+i,'w','前'.repeat(2500)+'needle'+'後'.repeat(2500));
 const {recallHistory}=await import('../dist/memory/session-history.js');
 const result=recallHistory(f.store,binding,{query:'needle',scope:'work',limit:20,beforeSeq:null});
 assert.ok(result.records.length>0);assert.ok(result.records.every(r=>r.text.includes('needle')));assert.ok(Buffer.byteLength(JSON.stringify(result))<=16384);assert.ok(result.nextBeforeSeq);
});
