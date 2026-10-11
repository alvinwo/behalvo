import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,createWork,message} from './helpers.mjs';
import {runRepl} from '../dist/cli/repl.js';
import {selectTaskThread} from '../dist/runtime/task-continuity.js';

async function run(f,lines,initialThreadId='im') {
 const output=[];
 const result=await runRepl({store:f.store,registry:{},service:{continuityEnabled:true},workspaceId:'personal',ownerId:'owner',initialThreadId,
  io:{readLine:async()=>lines.shift()??null,write:line=>output.push(line)}});
 return {output:output.join('\n'),result};
}
test('session list/resume preserve focus and reject /new with an existing ID',async t=>{
 const f=await fixture(t);createWork(f);selectTaskThread(f.store,'personal','owner','im','w',true);
 f.store.ingest('personal',message('legacy',{text:'Session preview'}));
 const revision=f.store.state('personal').works.w.revision;
 const first=await run(f,['/new im','/sessions','/quit']);
 assert.match(first.output,/already exists/);assert.equal(first.result.workId,'w');
 assert.match(first.output,/Session preview/);
 f.restart();const second=await run(f,['/resume im','/resume im','/quit'],'other');
 assert.equal(second.result.threadId,'im');assert.equal(second.result.workId,'w');assert.equal(f.store.state('personal').works.w.revision,revision);
 const missing=await run(f,['/resume absent','/quit']);assert.match(missing.output,/Session not found/);assert.equal(missing.result.threadId,'im');
});
test('history is current-session text, journal remains diagnostic, and memory excludes other tasks',async t=>{
 const f=await fixture(t);createWork(f);createWork(f,'other');selectTaskThread(f.store,'personal','owner','im','w',true);
 const source=f.store.ingest('personal',message('a',{text:'VISIBLE_LEGACY_HISTORY'}));
 f.store.ingest('personal',message('b',{threadId:'elsewhere',text:'OTHER_SESSION_HISTORY'}));
 f.store.append('personal',f.store.state('personal').version,[{type:'fact.recorded',data:{fact:{id:'other-fact',subject:'other',predicate:'secret',value:'OTHER_TASK_FACT',validFrom:null,validTo:null,observedAt:source.recordedAt,sourceRecordId:source.id}}}]);
 const history=await run(f,['/history','/quit']);assert.match(history.output,/VISIBLE_LEGACY_HISTORY/);assert.doesNotMatch(history.output,/OTHER_SESSION_HISTORY/);
 const journal=await run(f,['/journal 2','/quit']);assert.match(journal.output,/message.received|task.focused/);
 const memory=await run(f,['/memory','/quit']);assert.match(memory.output,/TASK MEMORY/);assert.doesNotMatch(memory.output,/OTHER_TASK_FACT/);
});
test('owner recall finds attributed task history and stays read only',async t=>{
 const f=await fixture(t);createWork(f);selectTaskThread(f.store,'personal','owner','im','w',true);
 const r=f.store.ingest('personal',message('a',{text:'Recall a synthetic date'}));
 f.store.append('personal',f.store.state('personal').version,[{type:'task.intake_recorded',data:{receipt:{ownerRecordId:r.id,threadId:'im',workId:'w',workRevisionAtIntake:1,outcome:'ready'}}}]);
 const result=await run(f,['/recall synthetic date','/quit']);assert.match(result.output,/Recall a synthetic date/);assert.match(result.output,new RegExp(r.id));assert.equal(f.store.state('personal').works.w.phase,'open');
});
