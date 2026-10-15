import test from 'node:test';import assert from 'node:assert/strict';
import { fixture, createWork, message } from './helpers.mjs';
import { ManagedBrowserController } from '../dist/browser/managed-session.js';
import { AgentService } from '../dist/runtime/agent-service.js';
const execution=()=>({deadline:Date.now()+30000,signal:new AbortController().signal});
async function setup(t,config={}){const f=await fixture(t);createWork(f);const r=f.store.ingest('personal',message('open',{text:'Open synthetic browser'}));
 const binding={workspaceId:'personal',ownerId:'owner',workId:'w',ownerRecordId:r.id,expectedWorkRevision:1,threadId:'im'};
 let now=Date.now(),closed=0,invalidated=0,networks=0,networkClosed=0;const browsers=[];
 const controller=new ManagedBrowserController(f.store,config.review??(async()=> 'approve'),{
   clock:()=>now,network:check=>{networks++;return{revision:1,async start(){await config.start?.();check();},async close(){networkClosed++;return{confirmed:config.confirmed??true};}};},
   browser:options=>{const browser={human:false,location:'https://example.test/',async open(ctx){return this.observe(ctx);},async observe(ctx){ctx.assertCurrent();return{workspaceId:ctx.workspaceId,workId:ctx.workId,workRevision:ctx.workRevision,sessionId:ctx.sessionId,generation:ctx.generation,id:crypto.randomUUID(),documentId:'doc',origin:'https://example.test',location:'/',observedAt:new Date().toISOString(),text:'Synthetic page',controls:[]};},async visit(ctx,url){this.location=url;return this.observe(ctx);},async interact(ctx){return this.observe(ctx);},async retire(){},async close(){closed++;return{confirmed:true};},inputs(){return[];},inputPurpose(){throw new Error('No input');},invalidateInputs(){invalidated++;},async handoff(){this.human=true;},async resume(){this.human=false;}};browsers.push(browser);return browser;}
 });t.after(()=>controller.shutdown());return {...f,binding,controller,browsers,advance(ms){now+=ms;},closed:()=>closed,invalidated:()=>invalidated,networks:()=>networks,networkClosed:()=>networkClosed};}
function context(binding){return{workspaceId:binding.workspaceId,workId:binding.workId,workRevision:binding.expectedWorkRevision,sessionId:'new-run',generation:1,execution:execution(),assertCurrent(){},resolveInput(){throw new Error('unused');}};}
test('healthy lease retirement preserves session and access but revokes the old lease',async t=>{const f=await setup(t);await f.controller.open(f.binding,'https://example.test/',execution());
 const one=context(f.binding),port=await f.controller.borrow(one,f.binding);const first=await port.observe(one);assert.equal(f.closed(),0);
 assert.deepEqual(await port.retire(true),{leaseRetired:true,sessionDisposition:'retained'});await assert.rejects(port.observe(one));
 const two=context(f.binding),next=await f.controller.borrow(two,f.binding);const second=await next.observe(two);assert.equal(second.sessionId,first.sessionId);assert.ok(second.generation>first.generation);await next.retire(true);assert.equal(f.closed(),0);
 assert.equal((await f.controller.shutdown()).confirmed,true);assert.equal(f.closed(),1);
});
test('handoff prevents model calls and resume restores a fresh lease',async t=>{const f=await setup(t);await f.controller.open(f.binding,'https://example.test/',execution());await f.controller.handoff(f.binding);
 let calls=0;const service=new AgentService(f.store,{complete:async()=>{calls++;throw new Error('No model in manual mode');} },undefined,undefined,{taskContinuity:true,browser:f.controller.exploration()});
 await assert.rejects(service.runOwnerTurn({workspaceId:'personal',ownerId:'owner',threadId:'im',workId:'w',externalId:'manual',text:'Continue',model:{provider:'test',model:'test'}}),/manual|resume/i);assert.equal(calls,0);
 await f.controller.resume(f.binding);const ctx=context(f.binding),port=await f.controller.borrow(ctx,f.binding);await port.observe(ctx);await port.retire(true);
});
test('scope isolation, capacity, task correction and idle expiry enforce session custody',async t=>{const f=await setup(t);await f.controller.open(f.binding,'https://example.test/',execution());
 assert.equal(f.controller.available({...f.binding,threadId:'different'}),false);await assert.rejects(f.controller.borrow(context(f.binding),{...f.binding,threadId:'different'}));
 createWork(f,'second');const second=f.store.ingest('personal',message('second'));const b2={...f.binding,workId:'second',ownerRecordId:second.id};await f.controller.open(b2,'https://example.test/',execution());createWork(f,'third');const third=f.store.ingest('personal',message('third'));await assert.rejects(f.controller.open({...f.binding,workId:'third',ownerRecordId:third.id},'https://example.test/',execution()),/capacity/i);
 const ctx=context(f.binding),port=await f.controller.borrow(ctx,f.binding);f.operator.setWorkPhase('personal','owner','w','waiting_external');await assert.rejects(port.observe(ctx));await port.retire(false);assert.ok(f.invalidated()>0);
 f.advance(600001);assert.equal(f.controller.available(b2),false);await f.controller.shutdown();assert.equal(f.closed(),2);
});
test('an expired or cancelled lease closes instead of reporting a retained session',async t=>{const f=await setup(t);await f.controller.open(f.binding,'https://example.test/',execution());
 const ctx=context(f.binding),abort=new AbortController();ctx.execution.signal=abort.signal;const port=await f.controller.borrow(ctx,f.binding);abort.abort();await assert.rejects(port.observe(ctx));const retirement=await port.retire(true);assert.equal(retirement.sessionDisposition,'closed');assert.equal(retirement.cleanupConfirmed,true);
});
test('human mode blocks only the bound chat and never lends its session to another chat',async t=>{
 const f=await setup(t);await f.controller.open(f.binding,'https://example.test/',execution());await f.controller.handoff(f.binding);
 assert.throws(()=>f.controller.beforeTurn(f.binding));assert.doesNotThrow(()=>f.controller.beforeTurn({...f.binding,threadId:'unrelated'}));
 assert.equal(f.controller.available({...f.binding,threadId:'unrelated'}),false);await assert.rejects(f.controller.borrow(context(f.binding),{...f.binding,threadId:'unrelated'}));
 assert.equal(f.controller.status(f.binding).state,'human');assert.equal(f.controller.status(f.binding).location,undefined);
});

test('lazy exploration acquires no resources until visit and reuses the scoped session across turns',async t=>{
 const f=await setup(t),options=f.controller.exploration(),ctx=context(f.binding);
 assert.equal(options.sessionState(f.binding),'absent');assert.equal(options.available(f.binding),false);
 const unused=await options.open(ctx,f.binding);assert.equal(f.networks(),0);
 await assert.rejects(unused.observe(ctx));assert.equal(f.networks(),0);
 assert.deepEqual(await unused.retire(true),{leaseRetired:true,sessionDisposition:'closed',cleanupConfirmed:true});
 const port=await options.open(ctx,f.binding);await assert.rejects(port.visit(ctx,'http://localhost/'));assert.equal(f.networks(),0);
 const first=await port.visit(ctx,'https://example.test/');await port.visit(ctx,'https://example.test/next');
 assert.equal(f.networks(),1);assert.equal(f.browsers.length,1);await port.retire(true);
 assert.equal(options.sessionState(f.binding),'connected');assert.equal(options.available(f.binding),true);
 await assert.rejects(port.visit(ctx,'https://example.test/late'));
 const nextContext=context(f.binding),next=await options.open(nextContext,f.binding);const later=await next.visit(nextContext,'https://example.test/later');
 assert.equal(first.sessionId,later.sessionId);assert.ok(later.generation>first.generation);assert.equal(f.networks(),1);await next.retire(true);
});
for(const confirmed of [true,false])test(`lazy creation cancellation owns pending resources and reports cleanup ${confirmed}`,async t=>{
 let release,started;const ready=new Promise(r=>started=r),pending=new Promise(r=>release=r);
 const f=await setup(t,{confirmed,start:async()=>{started();await pending;}}),ctx=context(f.binding),abort=new AbortController();ctx.execution.signal=abort.signal;
 const port=await f.controller.exploration().open(ctx,f.binding);const visit=port.visit(ctx,'https://example.test/');const failed=assert.rejects(visit);
 await ready;abort.abort();const result=await port.retire(false);assert.equal(result.sessionDisposition,'closed');assert.equal(result.cleanupConfirmed,confirmed);
 release();await failed;assert.equal(f.browsers.length,0);assert.equal(f.networkClosed(),1);assert.equal(f.controller.available(f.binding),false);
 assert.equal((await f.controller.shutdown()).confirmed,confirmed);
});
test('lazy port cannot allocate after retirement or a scope correction',async t=>{
 const f=await setup(t),ctx=context(f.binding),port=await f.controller.exploration().open(ctx,f.binding);
 f.operator.setWorkPhase('personal','owner','w','waiting_external');await assert.rejects(port.visit(ctx,'https://example.test/'));assert.equal(f.networks(),0);await port.retire(false);
 await assert.rejects(port.visit(ctx,'https://example.test/'));assert.equal(f.networks(),0);
});
test('unknown action survives replay and reports actionable guidance without a live session or model call',async t=>{
 const f=await setup(t),{BrowserActionBroker}=await import('../dist/runtime/browser-actions.js');
 const command={kind:'browser.gesture',version:1,operation:'visit',url:'https://example.test/',origin:'https://example.test',threadId:'im',sessionId:'old',generation:1,grantRevision:1};
 const result=await new BrowserActionBroker(f.store).perform(f.binding,command,execution(),{review:async()=> 'approve',validate:async()=>{},dispatch:async mark=>{mark();throw new Error('unknown');}});
 assert.equal(result.status,'unknown');f.store.rebuild('personal');
 const status=f.controller.status(f.binding);assert.equal(status.state,'absent');assert.deepEqual(status.unresolvedActions,[{id:result.actionId,status:'unknown'}]);
 let calls=0;const service=new AgentService(f.store,{complete:async()=>{calls++;throw new Error('Must not call model');}},undefined,undefined,{taskContinuity:true,browser:f.controller.exploration()});
 await assert.rejects(service.runOwnerTurn({workspaceId:'personal',ownerId:'owner',threadId:'im',workId:'w',externalId:'retry',text:'Continue',model:{provider:'test',model:'test'}}),error=>error.message.includes(result.actionId)&&error.message.includes('/browser resolve')&&error.message.includes('/actions'));
 assert.equal(calls,0);assert.equal(f.networks(),0);createWork(f,'other');assert.doesNotThrow(()=>f.controller.beforeTurn({...f.binding,workId:'other'}));
});
