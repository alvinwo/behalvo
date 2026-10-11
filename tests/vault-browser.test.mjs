import test from 'node:test';import assert from 'node:assert/strict';
import {SqliteStore} from '../dist/storage/sqlite-store.js';import {Operator} from '../dist/runtime/operator.js';
import {parseBrowserCommand,validateObservation} from '../dist/kernel/browser-contract.js';
import {runBrowserExploration} from '../dist/runtime/browser-exploration.js';
const scope={workspaceId:'w',workId:'task',workRevision:1,sessionId:'s',generation:1};
const observation={...scope,id:'obs',documentId:'doc',origin:'http://127.0.0.1:43118',location:'/',observedAt:new Date().toISOString(),text:'Synthetic sign in',controls:[{ref:'login',role:'login',name:'Sign in',actions:['request_login'],options:[]}]};
test('login contract accepts only opaque current control references',()=>{
 assert.equal(parseBrowserCommand({kind:'request_login',observationId:'obs',ref:'login'}).kind,'request_login');
 assert.deepEqual(validateObservation(observation,scope),observation);
 for(const extra of [{url:'https://example.test'},{password:'SYNTHETIC-PASSWORD'},{selector:'#password'},{credentialId:'guessed'}])assert.throws(()=>parseBrowserCommand({kind:'request_login',observationId:'obs',ref:'login',...extra}));
});
test('runtime terminates login tools after one attempt and never retries an unknown outcome',async()=>{
 const store=new SqliteStore(':memory:');store.createWorkspace('w','o');new Operator(store).createWork('w','o',{id:'task',title:'Synthetic login',goal:'Sign in',threadId:'t'});const record=store.ingest('w',{source:'owner',externalId:'owner',threadId:'t',senderId:'o',senderRole:'owner',text:'Sign in to the synthetic account.'});
 const binding={workspaceId:'w',ownerId:'o',workId:'task',expectedWorkRevision:1,ownerRecordId:record.id};let latest,opens=0,attempts=0,closes=0,calls=0;
 const gateway={complete:async request=>{
  assert.doesNotMatch(request.system,/Never claim booking, an executed action/);
  assert.match(request.system,/Report only the recognized synthetic login outcome/);
  calls++;if(calls===1)return{text:JSON.stringify({tool:{name:'observe',arguments:{}}})};
  if(calls===2)return{text:JSON.stringify({tool:{name:'request_login',arguments:{observationId:latest.id,ref:'login'}}})};
  assert.match(request.prompt,/unknown/);return{text:JSON.stringify({tool:{name:'observe',arguments:{}}})};
 }};
 const options={open:async ctx=>{opens++;return{observe:async()=>latest={...observation,...ctx,execution:undefined,assertCurrent:undefined,resolveInput:undefined,login:undefined},interact:async()=>{attempts++;return{...observation,...Object.fromEntries(Object.keys(scope).map(k=>[k,ctx[k]])),id:'after',controls:[],text:'Synthetic login outcome unknown'};},close:async()=>{closes++;return{confirmed:true};}};}};
 // The fake port returns only browser fields, just as a real port must.
 const open=options.open;options.open=async ctx=>{const port=await open(ctx);port.observe=async()=>latest={...observation,...Object.fromEntries(Object.keys(scope).map(k=>[k,ctx[k]]))};return port;};
 try{await runBrowserExploration(store,gateway,{system:'',prompt:'Synthetic owner task'},binding,{deadline:Date.now()+10000},options,8,196608,[]);assert.equal(attempts,1);assert.equal(opens,1);assert.equal(closes,1);assert.equal(calls,3);assert.deepEqual(store.rebuild('w'),store.state('w'));}finally{store.close();}
});
