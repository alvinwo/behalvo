import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../dist/cli/main.js';
import { openLocalAgent } from '../dist/cli/local-app.js';
import { runRepl } from '../dist/cli/repl.js';
test('opt-in CLI supports ordinary-language teaching and recall in focused work',async()=>{
 assert.equal(parseCliArgs(['--task-teachings','--offline']).teachingMode,true);
 const requests=[];const responses=[{outcome:'apply',changes:[{kind:'add',sourceQuote:'Prefer morning sessions.',interpretation:'Morning sessions'}],resolutions:[]},{outcome:'none'},{reply:'You prefer morning sessions.',workProposals:[],factProposals:[]}];
 const app=openLocalAgent({dbPath:':memory:',workspaceId:'w',ownerId:'o',teachingMode:true,gateways:[{listModels:async()=>[{provider:'fake',model:'test'}],complete:async r=>{requests.push(r);return {text:JSON.stringify(responses.shift())};}}]});
 try{
 app.operator.createWork('w','o',{id:'task',title:'Task',goal:'Synthetic task',threadId:'t'});
 const lines=['/model fake test','/work task','Prefer morning sessions.','What do you remember?','/quit'];const output=[];
 await runRepl({store:app.store,registry:app.registry,service:app.service,operations:app.operations,workspaceId:'w',ownerId:'o',initialThreadId:'t',io:{readLine:async()=>lines.shift()??null,write:x=>output.push(x)}});
 assert.equal(Object.keys(app.store.state('w').teachingMemory.teachings).length,1);
 assert.ok(output.some(x=>/prefer morning sessions/i.test(x))); assert.equal(requests.length,3);
 }finally{app.close();}
});
