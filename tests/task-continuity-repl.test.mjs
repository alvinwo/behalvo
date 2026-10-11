import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {openLocalAgent} from '../dist/cli/local-app.js';import {runRepl} from '../dist/cli/repl.js';
const model={provider:'fake',model:'synthetic'};
const reply={reply:'Directory still needs observation.',workProposals:[],factProposals:[],progress:{summary:'Instructions recorded',nextStep:'Observe fresh synthetic availability',blocker:'Browser needed',references:[]}};
const run=async(app,lines,extra={})=>{const output=[];await app.registry.select(model.provider,model.model);const result=await runRepl({store:app.store,registry:app.registry,service:app.service,operations:app.operations,workspaceId:'w',ownerId:'o',io:{readLine:async()=>lines.shift()??null,write:x=>output.push(x)},...extra});return {result,output};};
test('two local app instances resume goal, corrected instructions and progress without work commands',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'task-repl-'));let app;let intakeCalls=0;let reasoningCalls=0;
 const gateway={listModels:async()=>[model],complete:async request=>{
  if(request.system.includes('owner-only task intake')){
   const parsed=JSON.parse(request.prompt);intakeCalls++;
   if(parsed.currentOwnerText==='Check synthetic slots. Use December dates.')return {text:JSON.stringify({task:{kind:'create',title:'Slots',goal:'Check slots',sourceQuote:'Check synthetic slots.'},teachings:{outcome:'apply',changes:[{kind:'add',sourceQuote:'Use December dates.',interpretation:'December only'}],resolutions:[]}})};
   if(parsed.currentOwnerText==='Use January instead.')return {text:JSON.stringify({task:{kind:'keep'},teachings:{outcome:'apply',changes:[{kind:'replace',teachingId:parsed.candidates[0].teachings[0].id,expectedRevision:1,sourceQuote:'Use January instead.',interpretation:'January only'}],resolutions:[]}})};
   return {text:JSON.stringify({task:{kind:'keep'},teachings:{outcome:'none'}})};
  }
  reasoningCalls++;if(reasoningCalls===3){assert.match(request.prompt,/Use January instead/);assert.match(request.prompt,/Observe fresh synthetic availability/);}
  return {text:JSON.stringify(reply)};
 }};
 const options={dbPath:join(dir,'db'),workspaceId:'w',ownerId:'o',taskContinuity:true,gateways:[gateway]};
 try{
  app=openLocalAgent(options);const first=await run(app,['Check synthetic slots. Use December dates.','Use January instead.','/quit']);assert.ok(first.result.workId);const id=first.result.workId;app.close();
  app=openLocalAgent(options);const second=await run(app,['continue','/work','/quit']);assert.equal(second.result.threadId,first.result.threadId);assert.equal(second.result.workId,id);assert.ok(second.output.some(x=>x.includes('Observe fresh synthetic availability')));assert.ok(second.output.some(x=>x.includes('Browser needed')));assert.equal(intakeCalls,3);assert.equal(reasoningCalls,3);
  await run(app,['/new fresh','/quit']);app.close();app=openLocalAgent(options);assert.deepEqual((await run(app,['/quit'])).result,{reason:'quit',threadId:'fresh'});
  await run(app,[`/work ${id}`,'/work clear','/quit']);app.close();app=openLocalAgent(options);assert.equal((await run(app,['/quit'])).result.workId,undefined);
  assert.equal((await run(app,['/quit'],{initialThreadId:'explicit'})).result.threadId,'explicit');
 }finally{app?.close();rmSync(dir,{recursive:true,force:true});}
});
test('explicit focus resumes the prepared-action thread without invalidating its approval',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'continuity-approval-'));let app;
 const options={dbPath:join(dir,'db'),workspaceId:'w',ownerId:'o',syntheticOperations:true,taskContinuity:true,gateways:[{listModels:async()=>[model],complete:async()=>assert.fail('no model needed')}]};
 try{
 app=openLocalAgent(options);app.operator.createWork('w','o',{id:'task',title:'Synthetic contact',goal:'Update synthetic contact',threadId:'original'});
 const action=await app.operations.prepare({workspaceId:'w',ownerId:'o',workId:'task',key:'update',connectionId:'synthetic-account',operationId:'contact.update',operationVersion:'1',resourceId:'contact-profile',arguments:{email:'new@example.test'}});
 app.operations.approveBatch({workspaceId:'w',ownerId:'o',expiresAt:new Date(Date.now()+600000).toISOString(),approvals:[{actionId:action.id,digest:action.digest}]});const before=app.store.state('w');app.close();app=openLocalAgent(options);
 const result=await run(app,['/work task','/quit'],{initialThreadId:'new'});assert.equal(result.result.threadId,'original');assert.equal(app.store.state('w').works.task.revision,before.works.task.revision);assert.deepEqual(app.store.state('w').actions[action.id],before.actions[action.id]);
 }finally{app?.close();rmSync(dir,{recursive:true,force:true});}
});
