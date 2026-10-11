import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,createWork,message} from './helpers.mjs';
import {commandDigest} from '../dist/kernel/policy.js';
const command={kind:'browser.gesture',version:1,threadId:'im',sessionId:'session',generation:1,grantRevision:1,origin:'https://example.com',operation:'interact',documentId:'document',controlFingerprint:'a'.repeat(64),gesture:{kind:'click',observationId:'observation',ref:'ref'}};
async function setup(t){const f=await fixture(t);createWork(f);const owner=f.store.ingest('personal',message('owner',{text:'Explore the synthetic website.'}));const {BrowserActionBroker}=await import('../dist/runtime/browser-actions.js');return {...f,broker:new BrowserActionBroker(f.store),binding:{workspaceId:'personal',ownerId:'owner',workId:'w',ownerRecordId:owner.id,expectedWorkRevision:1}};}
const execution=()=>({deadline:Date.now()+30000,assertCurrent:()=>{}});
test('browser action digests bind every control and reject unsupported payload fields',()=>{
 const first=commandDigest('personal','w',1,command);
 assert.notEqual(commandDigest('personal','w',1,{...command,gesture:{...command.gesture,ref:'other'}}),first);
 assert.notEqual(commandDigest('personal','w',1,{...command,grantRevision:2}),first);
 assert.throws(()=>commandDigest('personal','w',1,{...command,script:'alert(1)'}));
});
test('approved gesture journals started before dispatch and acceptance does not finish work',async t=>{
 const f=await setup(t);let reviews=0,dispatches=0;
 const result=await f.broker.perform(f.binding,command,execution(),{review:async action=>{reviews++;assert.equal(action.status,'proposed');return 'approve';},validate:async()=>{},dispatch:async mark=>{mark();dispatches++;assert.equal(Object.values(f.store.state('personal').actions)[0].status,'running');return {id:'fresh'};}});
 assert.equal(reviews,1);assert.equal(dispatches,1);assert.equal(result.status,'accepted');assert.equal(f.store.state('personal').works.w.phase,'open');
 assert.deepEqual(f.store.rebuild('personal'),f.store.state('personal'));
});
for(const decision of ['reject','handoff'])test(`owner ${decision} does not dispatch a gesture`,async t=>{
 const f=await setup(t);const result=await f.broker.perform(f.binding,command,execution(),{review:async()=>decision,validate:async()=>{},dispatch:async()=>assert.fail('must not dispatch')});assert.equal(result.status,decision);assert.equal(Object.values(f.store.state('personal').actions)[0].status,'cancelled');
});
test('post-dispatch uncertainty blocks replacement sessions until explicit reconciliation',async t=>{
 const f=await setup(t);let dispatches=0;
 const result=await f.broker.perform(f.binding,command,execution(),{review:async()=> 'approve',validate:async()=>{},dispatch:async mark=>{mark();dispatches++;throw new Error('PRIVATE_PROVIDER_EXCEPTION');}});
 assert.equal(result.status,'unknown');assert.equal(dispatches,1);
 assert.doesNotMatch(f.store.readArtifact('personal',f.store.state('personal').actions[result.actionId].evidenceRef),/PRIVATE_PROVIDER_EXCEPTION/);
 await assert.rejects(()=>f.broker.perform(f.binding,{...command,sessionId:'replacement'},execution(),{review:async()=> 'approve',validate:async()=>{},dispatch:async()=>assert.fail('must not retry')}),/unknown|unresolved/i);
 f.operator.reconcile('personal','owner',result.actionId,'failed','Synthetic owner confirmed no remote effect.');
 assert.equal(f.store.state('personal').actions[result.actionId].status,'failed');assert.equal(dispatches,1);
});
test('late dispatch completion cannot overwrite an unknown settlement',async t=>{
 const f=await setup(t);let finish;const pending=new Promise(resolve=>finish=resolve);
 const result=await f.broker.perform(f.binding,command,{deadline:Date.now()+25},{review:async()=> 'approve',validate:async()=>{},dispatch:async mark=>{mark();return pending;}});
 assert.equal(result.status,'unknown');finish({id:'late'});await new Promise(r=>setTimeout(r,5));assert.equal(f.store.state('personal').actions[result.actionId].status,'unknown');
});
test('changed task during review cancels without dispatch',async t=>{
 const f=await setup(t);const result=await f.broker.perform(f.binding,command,execution(),{review:async()=>{f.operator.setWorkPhase('personal','owner','w','waiting_external');return 'approve';},validate:async()=>{},dispatch:async()=>assert.fail('stale')});assert.equal(result.status,'rejected');assert.equal(Object.values(f.store.state('personal').actions)[0].status,'cancelled');
});
test('deterministic browser action validation rejects a forged digest and enforces unknown barrier',async t=>{
 const f=await setup(t);const append=e=>f.store.append('personal',f.store.state('personal').version,[e]);
 const action={id:'forged',workId:'w',workRevision:1,key:'forged',command,digest:'0'.repeat(64),status:'proposed'};
 assert.throws(()=>append({type:'action.proposed',data:{action}}),/digest/i);
 const first=await f.broker.perform(f.binding,command,execution(),{review:async()=> 'approve',validate:async()=>{},dispatch:async mark=>{mark();throw new Error('unknown');}});
 const replacement={...action,id:'replacement',key:'replacement',digest:commandDigest('personal','w',1,command)};
 append({type:'action.proposed',data:{action:replacement}});append({type:'action.approved',data:{id:'replacement',approval:{ownerId:'owner',digest:replacement.digest,expiresAt:new Date(Date.now()+10000).toISOString()}}});
 assert.throws(()=>append({type:'action.started',data:{id:'replacement',attemptId:'attempt'}}),/unknown|unresolved/i);assert.equal(f.store.state('personal').actions[first.actionId].status,'unknown');
});
