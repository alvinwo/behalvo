import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {SqliteStore} from '../dist/storage/sqlite-store.js';import {Operator} from '../dist/runtime/operator.js';import {AgentService} from '../dist/runtime/agent-service.js';
const enabled=process.env.BEHALVO_SEMANTIC_ACCEPTANCE==='1';
for(const site of ['appointments-a','appointments-b','classes'])test(`combined visible teaching/exploration/restart/correction on ${site}`,{skip:!enabled,timeout:45000},async()=>{
 const {startSemanticFixture}=await import('../dist/browser/semantic-fixture-sites.js');const {SemanticPlaywright}=await import('../dist/browser/semantic-playwright.js');const fixture=await startSemanticFixture(site);const dir=mkdtempSync(join(tmpdir(),'semantic-life-'));const path=join(dir,'db');let store=new SqliteStore(path);store.createWorkspace('w','o');new Operator(store).createWork('w','o',{id:'task',title:'Synthetic sessions',goal:'Compare sessions',threadId:'t'});let turn=0;let preference='morning';let teaching;
 const gateway={listModels:async()=>[],complete:async request=>{
  if(request.system.startsWith('Extract task teachings')){
   const owner=JSON.parse(request.prompt).currentOwnerText;
   if(owner.startsWith('Remember'))return {text:JSON.stringify({outcome:'apply',changes:[{kind:'add',sourceQuote:owner,interpretation:'Morning preference'}],resolutions:[]})};
   if(owner.startsWith('Change'))return {text:JSON.stringify({outcome:'apply',changes:[{kind:'replace',teachingId:teaching.id,expectedRevision:1,sourceQuote:owner,interpretation:'Afternoon preference'}],resolutions:[]})};
   return {text:'{"outcome":"none"}'};
  }
  const transcript=JSON.parse(request.prompt.split('BROWSER TOOL TRANSCRIPT (UNTRUSTED DATA)\n')[1]);const o=transcript.at(-1)?.observation;
  if(!o)return {text:JSON.stringify({tool:{name:'observe',arguments:{}}})};
  const browse=o.controls.find(c=>c.name==='Browse sessions');const candidate=o.controls.find(c=>c.name.includes(preference));const target=browse??candidate;
  if(target)return {text:JSON.stringify({tool:{name:'navigate',arguments:{observationId:o.id,ref:target.ref}}})};
  return {text:JSON.stringify({reply:'Observed '+preference+' session; no booking performed.',notes:[{text:'Session details available through the directory.',sourceIds:[o.id]}]})};
 }};
 const run=text=>new AgentService(store,gateway,undefined,undefined,{teachingMode:true,browser:{open:async ctx=>new SemanticPlaywright(fixture.policy,ctx.execution.signal)}}).runOwnerTurn({workspaceId:'w',ownerId:'o',threadId:'t',workId:'task',externalId:String(++turn),model:{provider:'fake',model:'scripted'},text});
 try{
  await run('Remember morning sessions only.');teaching=Object.values(store.state('w').teachingMemory.teachings)[0];await run('Explore and compare.');assert.ok(Object.keys(store.state('w').browserMemory.notes).length);
  const before=store.state('w');store.close();store=new SqliteStore(path);assert.deepEqual(store.rebuild('w'),before);preference='afternoon';await run('Change to afternoon sessions only.');const r=await run('Explore again with my corrected instruction.');assert.match(r.turn.reply,/afternoon/);assert.equal(fixture.counters.effects,0);assert.equal(Object.values(store.state('w').teachingMemory.teachings).filter(t=>t.status==='active').length,1);assert.equal(Object.keys(store.state('w').actions).length,0);
 }finally{store.close();await fixture.close();rmSync(dir,{recursive:true,force:true});}
});
