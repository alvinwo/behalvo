import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {SqliteStore} from '../dist/storage/sqlite-store.js';import {AgentService} from '../dist/runtime/agent-service.js';import {selectTaskThread,restoreTaskThread} from '../dist/runtime/task-continuity.js';
test('visible synthetic task intake, browser stop, restart and correction use fresh observations',{skip:process.env.BEHALVO_SEMANTIC_ACCEPTANCE!=='1',timeout:45000},async()=>{
 const {startSemanticFixture}=await import('../dist/browser/semantic-fixture-sites.js');const {SemanticPlaywright}=await import('../dist/browser/semantic-playwright.js');
 const site=await startSemanticFixture('appointments-a');const dir=mkdtempSync(join(tmpdir(),'continuity-browser-'));const path=join(dir,'db');let store=new SqliteStore(path);let phase=0;let serial=0;let seenCheckpoint=false;const sessionIds=new Set();let firstObservation;
 const gateway={listModels:async()=>[],complete:async request=>{
  if(request.system.includes('owner-only task intake')){
   const p=JSON.parse(request.prompt);
   if(phase===0)return {text:JSON.stringify({task:{kind:'create',title:'Synthetic sessions',goal:'Compare sessions',sourceQuote:'Compare synthetic sessions.'},teachings:{outcome:'apply',changes:[{kind:'add',sourceQuote:'Prefer mornings.',interpretation:'Morning preference'}],resolutions:[]}})};
   const t=p.candidates[0].teachings[0];return {text:JSON.stringify({task:{kind:'keep'},teachings:{outcome:'apply',changes:[{kind:'replace',teachingId:t.id,expectedRevision:t.revision,sourceQuote:'Prefer afternoons instead.',interpretation:'Afternoon preference'}],resolutions:[]}})};
  }
  const transcript=JSON.parse(request.prompt.split('BROWSER TOOL TRANSCRIPT (UNTRUSTED DATA)\n')[1]);const o=transcript.at(-1)?.observation;
  if(!o){if(phase===1){seenCheckpoint=request.prompt.includes('HISTORICAL BROWSER STOP');assert.match(request.prompt,/Prefer afternoons instead/);}return {text:JSON.stringify({tool:{name:'observe',arguments:{}}})};}
  sessionIds.add(o.sessionId);firstObservation??=o.id;
  if(phase===0)return {text:'invalid-json'}; // Deliberate stop after real observation, no final notes.
  assert.notEqual(o.id,firstObservation);
  const target=o.controls.find(c=>c.name==='Browse sessions')??o.controls.find(c=>c.name.includes('afternoon'));
  if(target)return {text:JSON.stringify({tool:{name:'navigate',arguments:{observationId:o.id,ref:target.ref}}})};
  return {text:JSON.stringify({reply:'Observed afternoon session; no booking performed.',notes:[],progress:{summary:'Reached afternoon session details',nextStep:'Compare the observed details with the owner criteria',blocker:null,references:[{kind:'browser_observation',id:o.id}]}})};
 }};
 const run=text=>new AgentService(store,gateway,undefined,undefined,{taskContinuity:true,browser:{open:async ctx=>new SemanticPlaywright(site.policy,ctx.execution.signal)}}).runOwnerTurn({workspaceId:'w',ownerId:'o',threadId:'t',externalId:String(++serial),model:{provider:'fake',model:'scripted'},text});
 try{
  store.createWorkspace('w','o');selectTaskThread(store,'w','o','t',null,true);const first=await run('Compare synthetic sessions. Prefer mornings.');assert.ok(store.state('w').browserMemory.checkpoints[first.workId]);assert.equal(Object.keys(store.state('w').browserMemory.notes).length,0);const before=store.state('w');store.close();
  store=new SqliteStore(path);assert.deepEqual(store.rebuild('w'),before);assert.equal(restoreTaskThread(store,'w').workId,first.workId);phase=1;
  const resumed=await run('Prefer afternoons instead.');assert.match(resumed.turn.reply,/afternoon/);assert.ok(seenCheckpoint);assert.equal(sessionIds.size,2);assert.ok(store.state('w').taskContinuity.progress[first.workId].summary.includes('afternoon'));
  assert.equal(Object.values(store.state('w').teachingMemory.teachings).filter(t=>t.status==='active').length,1);assert.equal(Object.keys(store.state('w').works).length,1);assert.equal(Object.keys(store.state('w').actions).length,0);assert.equal(site.counters.effects,0);
 }finally{store.close();await site.close();rmSync(dir,{recursive:true,force:true});}
});
