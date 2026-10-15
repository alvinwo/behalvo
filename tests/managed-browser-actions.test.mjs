import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,createWork,message} from './helpers.mjs';
import {commandDigest} from '../dist/kernel/policy.js';
import {BrowserNoDispatchError,BrowserDiagnosticError,parseDispatchReceipt} from '../dist/browser/live-failure.js';
import {LiveWorld} from '../dist/browser/live-world.js';
import {EventEmitter} from 'node:events';
const command={kind:'browser.gesture',version:1,threadId:'im',sessionId:'session',generation:1,grantRevision:1,origin:'https://example.com',operation:'interact',documentId:'document',controlFingerprint:'a'.repeat(64),gesture:{kind:'click',observationId:'observation',ref:'ref'}};
async function setup(t){const f=await fixture(t);createWork(f);const owner=f.store.ingest('personal',message('owner',{text:'Explore the synthetic website.'}));const {BrowserActionBroker}=await import('../dist/runtime/browser-actions.js');return {...f,broker:new BrowserActionBroker(f.store),binding:{workspaceId:'personal',ownerId:'owner',workId:'w',ownerRecordId:owner.id,expectedWorkRevision:1}};}
const execution=()=>({deadline:Date.now()+30000,assertCurrent:()=>{}});
test('v2 binds trusted authority and exact navigation destination while rejecting authority laundering',()=>{
 const nav={...command,version:2,authority:'navigation_policy_v1',gesture:{...command.gesture,kind:'navigate'},destination:'https://other.test/path?q=one#section'};
 const digest=commandDigest('personal','w',1,nav);
 assert.notEqual(digest,commandDigest('personal','w',1,{...nav,destination:'https://other.test/path?q=two#section'}));
 const click={...command,version:2,authority:'owner_review'};assert.doesNotThrow(()=>commandDigest('personal','w',1,click));
 const open={kind:'browser.gesture',version:2,authority:'owner_open',threadId:'im',sessionId:'session',generation:1,grantRevision:1,origin:'https://example.com',operation:'open',url:'https://example.com/'};
 assert.doesNotThrow(()=>commandDigest('personal','w',1,open));
 assert.doesNotThrow(()=>commandDigest('personal','w',1,{...open,operation:'visit',authority:'navigation_policy_v1'}));
 const {destination,...missing}=nav;
 for(const invalid of [missing,{...nav,authority:'owner_review'},{...nav,destination:'http://other.test/'},{...nav,destination:'https://other.test'},
  {...nav,destination:'https://user:pass@other.test/'},{...nav,version:1},{...click,authority:'navigation_policy_v1'},{...click,destination},
  {...open,authority:'navigation_policy_v1'},{...open,operation:'visit'},{...click,authority:'made_up'},{...click,approved:true}])assert.throws(()=>commandDigest('personal','w',1,invalid));
});
test('explicit visit digests bind destination and remain distinct from legacy owner open',()=>{
 const open={kind:'browser.gesture',version:1,threadId:'im',sessionId:'session',generation:1,grantRevision:1,origin:'https://example.com',operation:'open',url:'https://example.com/path?q=one'};
 assert.equal(commandDigest('personal','w',1,open),'d1e65b9fa55a64b8afa18832e67a269f67a02715a535bf389e7ba89e8e86c609');
 const visit={...open,operation:'visit'};const digest=commandDigest('personal','w',1,visit);
 assert.notEqual(digest,commandDigest('personal','w',1,open));assert.notEqual(digest,commandDigest('personal','w',1,{...visit,url:'https://example.com/path?q=two'}));
 for(const invalid of [{...visit,url:'https://other.test/'},{...visit,url:'http://example.com/'},{...visit,approved:true},{...visit,script:'alert(1)'}])assert.throws(()=>commandDigest('personal','w',1,invalid));
});
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
 assert.equal(result.status,'unknown');assert.equal(dispatches,1);assert.deepEqual(result.diagnostic,{code:'dispatch_unconfirmed',phase:'dispatch'});
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
for(const code of ['control_missing','control_changed','control_covered','field_ambiguous','option_changed','deadline_expired'])test(`trusted ${code} receipt proves no effect even after the RPC marker`,async t=>{
 const f=await setup(t);const result=await f.broker.perform(f.binding,command,execution(),{review:async()=> 'approve',validate:async()=>{},dispatch:async mark=>{mark();throw new BrowserNoDispatchError({status:'not_dispatched',code});}});
 assert.equal(result.status,'failed');assert.equal(result.disposition,'not_dispatched');assert.deepEqual(result.diagnostic,{phase:'validation',code});
 const action=f.store.state('personal').actions[result.actionId];assert.equal(action.status,'failed');assert.deepEqual(JSON.parse(f.store.readArtifact('personal',action.evidenceRef)).diagnostic,result.diagnostic);
 assert.deepEqual(f.store.rebuild('personal'),f.store.state('personal'));
});
test('a late no-dispatch receipt cannot replace an earlier unknown timeout',async t=>{
 const f=await setup(t);let reject;const pending=new Promise((_,r)=>reject=r);
 const result=await f.broker.perform(f.binding,command,{deadline:Date.now()+25},{review:async()=> 'approve',validate:async()=>{},dispatch:async mark=>{mark();return pending;}});
 assert.equal(result.status,'unknown');reject(new BrowserNoDispatchError({status:'not_dispatched',code:'control_covered'}));await new Promise(r=>setTimeout(r,5));
 assert.equal(f.store.state('personal').actions[result.actionId].status,'unknown');
});
test('malformed receipts and lookalike errors cannot prove no dispatch or leak raw details',async t=>{
 const f=await setup(t);
 for(const value of [true,null,{status:'not_dispatched',code:'made_up'},{status:'not_dispatched',code:'control_covered',secret:'PRIVATE_CANARY'},{status:'dispatched',code:'control_covered'}])assert.throws(()=>parseDispatchReceipt(value));
 const error=Object.assign(new Error('PRIVATE_CANARY'),{name:'BrowserNoDispatchError',diagnostic:{phase:'validation',code:'control_covered'},disposition:'not_dispatched'});
 const result=await f.broker.perform(f.binding,command,execution(),{review:async()=> 'approve',validate:async()=>{},dispatch:async mark=>{mark();throw error;}});
 assert.equal(result.status,'unknown');assert.equal(result.disposition,undefined);assert.equal(result.diagnostic.code,'dispatch_unconfirmed');
 assert.doesNotMatch(JSON.stringify(result)+f.store.readArtifact('personal',f.store.state('personal').actions[result.actionId].evidenceRef),/PRIVATE_CANARY/);
});
test('a dispatched action without a fresh observation remains unknown with a fixed phase',async t=>{
 const f=await setup(t);const result=await f.broker.perform(f.binding,command,execution(),{review:async()=> 'approve',validate:async()=>{},dispatch:async mark=>{mark();throw new BrowserDiagnosticError({phase:'observation',code:'observation_unavailable'});}});
 assert.equal(result.status,'unknown');assert.deepEqual(result.diagnostic,{phase:'observation',code:'observation_unavailable'});
});
for(const response of [{exceptionDetails:{text:'PRIVATE_CANARY'},result:{}},{result:{value:{status:'not_dispatched',code:'control_covered',extra:true}}}])test('private helper exceptions or malformed replies remain unknown after the dispatch mark',async t=>{
 const f=await setup(t),session=new EventEmitter(),page=new EventEmitter();page.mainFrame=()=>({});
 session.send=async method=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'frame'}}}:method==='Page.createIsolatedWorld'?{executionContextId:1}:method==='Runtime.evaluate'?{result:{objectId:'private'}}:response;
 const world=new LiveWorld(session,page);const result=await f.broker.perform(f.binding,command,execution(),{review:async()=> 'approve',validate:async()=>{},dispatch:async mark=>{mark();await world.dispatch({deadline:Date.now()+5000});}});
 assert.equal(result.status,'unknown');assert.equal(result.diagnostic.code,'dispatch_unconfirmed');assert.doesNotMatch(JSON.stringify(result)+f.store.readArtifact('personal',f.store.state('personal').actions[result.actionId].evidenceRef),/PRIVATE_CANARY/);
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
