import test from 'node:test';import assert from 'node:assert/strict';import {fixture,createWork,message} from './helpers.mjs';
import {buildContext} from '../dist/memory/context.js';import {prepareProgressEvent} from '../dist/runtime/task-continuity.js';import {recordBrowserObservation} from '../dist/runtime/browser-learning.js';
test('progress and a browser stop without notes survive restart, stay bounded and expose no live refs',async t=>{
 const f=await fixture(t);createWork(f);const owner=f.store.ingest('personal',message('context'));
 const binding={workspaceId:'personal',ownerId:'owner',workId:'w',ownerRecordId:owner.id,expectedWorkRevision:1};
 recordBrowserObservation(f.store,binding,{workspaceId:'personal',workId:'w',workRevision:1,sessionId:'secret-session',generation:1,id:'obs',documentId:'secret-document',origin:'http://127.0.0.1:43117',location:'/',observedAt:'2026-10-10T00:00:00.000Z',text:'Synthetic slots',controls:[]});
 const append=event=>f.store.append('personal',f.store.state('personal').version,[event]);
 append({type:'browser.checkpoint',data:{workId:'w',sourceIds:['obs'],reason:'exploration_stopped',expectedWorkRevision:1}});
 append(prepareProgressEvent(f.store,binding,{summary:'Reached directory',nextStep:'Observe fresh slots before comparison',blocker:null,references:[{kind:'browser_observation',id:'obs'}]},'final'));
 f.restart();const options={workspaceId:'personal',ownerId:'owner',workId:'w',threadId:'im',windowTokens:16000,outputReserve:1000};
 const context=buildContext(f.store,options);assert.match(context.text,/TASK PROGRESS/);assert.match(context.text,/Observe fresh slots/);assert.match(context.text,/exploration_stopped/);assert.match(context.text,/"stale":false/);assert.ok(context.includedBrowserSourceIds.includes('obs'));assert.doesNotMatch(context.text,/secret-session|secret-document/);
 f.operator.linkThread('personal','owner','w','new-thread');assert.match(buildContext(f.store,options).text,/"stale":true/);
 // Recording a stop cannot silently promote copied old advice to the new revision.
 append(prepareProgressEvent(f.store,{...binding,expectedWorkRevision:2},{summary:'Reached directory',nextStep:'Observe fresh slots before comparison',blocker:null,references:[]},'invalid_model_result',1));
 assert.match(buildContext(f.store,options).text,/"stale":true/);
 assert.throws(()=>buildContext(f.store,{...options,windowTokens:1000}),/budget/i);
 createWork(f,'other');assert.doesNotMatch(buildContext(f.store,{...options,workId:'other'}).text,/Observe fresh slots|exploration_stopped/);
});
