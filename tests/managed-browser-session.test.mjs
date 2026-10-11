import test from 'node:test';import assert from 'node:assert/strict';
import { fixture, createWork, message } from './helpers.mjs';
import { ManagedBrowserController } from '../dist/browser/managed-session.js';
import { AgentService } from '../dist/runtime/agent-service.js';
const execution=()=>({deadline:Date.now()+30000,signal:new AbortController().signal});
async function setup(t){const f=await fixture(t);createWork(f);const r=f.store.ingest('personal',message('open',{text:'Open synthetic browser'}));
 const binding={workspaceId:'personal',ownerId:'owner',workId:'w',ownerRecordId:r.id,expectedWorkRevision:1,threadId:'im'};
 let now=Date.now(),closed=0,invalidated=0;const browsers=[];
 const controller=new ManagedBrowserController(f.store,async()=> 'approve',{
   clock:()=>now,network:(origins,check)=>({origins,revision:1,blockedOrigins:[],async start(){check();},async close(){return{confirmed:true};},allow(o){this.origins.push(o);this.revision++;}}),
   browser:options=>{const browser={human:false,location:'https://example.test/',async open(ctx){return this.observe(ctx);},async observe(ctx){ctx.assertCurrent();return{workspaceId:ctx.workspaceId,workId:ctx.workId,workRevision:ctx.workRevision,sessionId:ctx.sessionId,generation:ctx.generation,id:crypto.randomUUID(),documentId:'doc',origin:'https://example.test',location:'/',observedAt:new Date().toISOString(),text:'Synthetic page',controls:[]};},async interact(ctx){return this.observe(ctx);},async retire(){},async close(){closed++;return{confirmed:true};},inputs(){return[];},inputPurpose(){throw new Error('No input');},invalidateInputs(){invalidated++;},async handoff(){this.human=true;},async resume(){this.human=false;}};browsers.push(browser);return browser;}
 });t.after(()=>controller.shutdown());return {...f,binding,controller,browsers,advance(ms){now+=ms;},closed:()=>closed,invalidated:()=>invalidated};}
function context(binding){return{workspaceId:binding.workspaceId,workId:binding.workId,workRevision:binding.expectedWorkRevision,sessionId:'new-run',generation:1,execution:execution(),assertCurrent(){},resolveInput(){throw new Error('unused');}};}
test('healthy lease retirement preserves session and grants but revokes the old lease',async t=>{const f=await setup(t);await f.controller.open(f.binding,'https://example.test/',execution());
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
