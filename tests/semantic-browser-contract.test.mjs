import test from 'node:test';
import assert from 'node:assert/strict';
const api=()=>import('../dist/browser/semantic-validation.js');
const scope={workspaceId:'w',workId:'task',workRevision:1,sessionId:'s',generation:1};
const observation={...scope,id:'obs',documentId:'doc',origin:'http://127.0.0.1:43117',location:'/',observedAt:'2026-10-10T00:00:00.000Z',text:'Synthetic page',controls:[{ref:'link',role:'link',name:'Sessions',actions:['navigate'],options:[]}]};
test('semantic observations are bounded exact contracts and commands bind current scope and observation',async()=>{
 const {validateObservation,parseBrowserCommand,resolveControl}=await api();
 assert.deepEqual(validateObservation(observation,scope),observation);
 const command=parseBrowserCommand({kind:'navigate',observationId:'obs',ref:'link'});assert.equal(resolveControl(observation,scope,command).name,'Sessions');
 for(const invalid of [{...observation,cookies:'secret'},{...observation,workspaceId:'other'},{...observation,text:'x'.repeat(32769)},{...observation,controls:[{...observation.controls[0],hidden:true}]}])assert.throws(()=>validateObservation(invalid,scope));
 for(const invalid of [{kind:'navigate',url:'https://example.test'},{kind:'fill',observationId:'obs',ref:'link',value:'canary'},{kind:'execute',observationId:'obs',ref:'link'}])assert.throws(()=>parseBrowserCommand(invalid));
 for(const command of [{kind:'navigate',observationId:'old',ref:'link'},{kind:'click',observationId:'obs',ref:'link'},{kind:'navigate',observationId:'obs',ref:'unknown'}])assert.throws(()=>resolveControl(observation,scope,command));
 assert.throws(()=>resolveControl(observation,{...scope,generation:2},{kind:'navigate',observationId:'obs',ref:'link'}));
});
test('input disclosure requires unique owner source and exact active revision, origin and policy purpose',async()=>{
 const {exactInputSource,resolveTaskInput}=await api();
 const source=exactInputSource('r','Use 🌱 mornings.','mornings');assert.equal(source.sourceStart,7);
 for(const quote of ['','missing','same'])assert.throws(()=>exactInputSource('r','same same',quote));
 const binding={id:'input',workspaceId:'w',workId:'task',workRevision:1,origin:observation.origin,purpose:'session-search',status:'active',...source};
 assert.equal(resolveTaskInput(binding,scope,observation.origin,'session-search'),'mornings');
 for(const change of [{workRevision:2},{workspaceId:'other'},{status:'revoked'},{origin:'http://127.0.0.1:43118'},{purpose:'password'}])assert.throws(()=>resolveTaskInput({...binding,...change},scope,observation.origin,'session-search'));
});
