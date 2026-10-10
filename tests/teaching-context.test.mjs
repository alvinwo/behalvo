import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../dist/storage/sqlite-store.js';
import { Operator } from '../dist/runtime/operator.js';
import { prepareTeachingEvents } from '../dist/runtime/teachings.js';
import { buildContext } from '../dist/memory/context.js';
test('linked-thread recall pins exact active teaching sources without relying on a recent transcript',()=>{
 const store=new SqliteStore(':memory:');try{
 store.createWorkspace('w','o');const op=new Operator(store);op.createWork('w','o',{id:'task',title:'Task',goal:'Goal',threadId:'first'});op.linkThread('w','o','task','second');
 const r=store.ingest('w',{source:'owner:local',externalId:'1',threadId:'first',senderId:'o',senderRole:'owner',text:'For this task, prefer morning sessions. Do not book anything.'});
 store.append('w',store.state('w').version,prepareTeachingEvents(store,{workspaceId:'w',ownerId:'o',workId:'task',ownerRecordId:r.id,expectedWorkRevision:2},{outcome:'apply',changes:[{kind:'add',sourceQuote:'prefer morning sessions',interpretation:'Advisory morning preference'}],resolutions:[]}));
 const request={workspaceId:'w',ownerId:'o',workId:'task',threadId:'second',windowTokens:64000,outputReserve:1000};
 const context=buildContext(store,request);
 assert.match(context.text,/prefer morning sessions/);assert.match(context.text,/Do not book anything/);assert.ok(context.includedRecordIds.includes(r.id));
 assert.match(context.text,/advisory/i);assert.throws(()=>buildContext(store,{...request,threadId:'unlinked'}),/link/i);
 assert.throws(()=>buildContext(store,{...request,windowTokens:1200}),/budget/i);
 assert.doesNotMatch(buildContext(store,{...request,workId:undefined}).text,/prefer morning sessions/);
 }finally{store.close();}
});
test('focused task always exposes an explicit empty active teaching view',()=>{
 const store=new SqliteStore(':memory:');try{
 store.createWorkspace('w','o');new Operator(store).createWork('w','o',{id:'task',title:'Task',goal:'Goal',threadId:'t'});
 const context=buildContext(store,{workspaceId:'w',ownerId:'o',workId:'task',threadId:'t',windowTokens:64000,outputReserve:1000});
 assert.match(context.text,/TASK TEACHINGS/);assert.match(context.text,/"teachings":\[\]/);
 }finally{store.close();}
});
