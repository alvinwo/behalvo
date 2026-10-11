import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {PassThrough} from 'node:stream';
import * as api from '../dist/index.js';
const scope={workspaceId:'w',ownerId:'o'};
const challenge={...scope,workId:'task',workRevision:1,sessionId:'session',generation:1,documentId:'doc',observationId:'obs',ref:'login',origin:'https://login.example.test'};
const execution=()=>({deadline:Date.now()+10000,assertCurrent(){}});
function io(answers, secrets){const output=[];let resets=0;return{interactive:true,readLine:async()=>answers.shift()??null,readSecret:async()=>secrets.shift()??null,discardSensitiveInput(){resets++;},write:x=>output.push(x),output,get resets(){return resets;}};}
async function setup(t){assert.equal(typeof api.VaultLoginBroker,'function','VaultLoginBroker is exported');const root=mkdtempSync(join(tmpdir(),'vault-prompt-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const vault=new api.LocalCredentialVault({path:join(root,'vault'),loadKey:()=>Buffer.alloc(32,28)});t.after(()=>vault.lock());await vault.initialize(scope);return{vault,root};}
const input=()=>({label:'Synthetic label',origin:challenge.origin,username:Buffer.from('synthetic-user'),password:Buffer.from('SYNTHETIC-PROMPT-PASSWORD')});
const guard={assertCurrent(){}};

test('missing login captures outside chat and saved login requires fresh confirmation',{skip:process.platform==='win32'},async t=>{
 const {vault,root}=await setup(t);const terminal=io(['yes','Test account'],['  synthetic-user  ',' SYNTHETIC-PROMPT-PASSWORD ']);let calls=0;
 const result=await new api.VaultLoginBroker({vault,io:terminal}).use(scope,challenge,execution(),async(login,check)=>{check();calls++;assert.equal(Buffer.from(login.password).toString(),' SYNTHETIC-PROMPT-PASSWORD ');return {state:'signed_in'};});
 assert.deepEqual(result,{status:'used',value:{state:'signed_in'}});assert.equal(calls,1);assert.equal((await vault.list(scope)).length,1);
 assert.ok(terminal.resets>=2);assert.doesNotMatch(terminal.output.join('\n'),/synthetic-user|SYNTHETIC-PROMPT-PASSWORD/);assert.doesNotMatch(readFileSync(join(root,'vault'),'utf8'),/SYNTHETIC-PROMPT-PASSWORD/);
 const declined=io(['no'],[]);assert.equal((await new api.VaultLoginBroker({vault,io:declined}).use(scope,challenge,execution(),()=>assert.fail('declined'))).status,'skipped');
 const confirmed=io(['yes'],[]);const broker=new api.VaultLoginBroker({vault,io:confirmed});await broker.use(scope,challenge,execution(),()=>{calls++;return null;});
 assert.equal((await broker.use(scope,challenge,execution(),()=>assert.fail('second use'))).status,'unavailable');assert.equal(calls,2);
});

test('private prompts fail closed on EOF, headless, expired or changed task without saving',{skip:process.platform==='win32'},async t=>{
 const {vault}=await setup(t);
 for(const terminal of [io([],[]),{...io(['yes'],[]),interactive:false},io(['yes','label'],['user',null])]){
  const result=await new api.VaultLoginBroker({vault,io:terminal}).use(scope,challenge,execution(),()=>assert.fail('no dispatch'));assert.notEqual(result.status,'used');
 }
 const terminal=io(['yes','label'],['user','SYNTHETIC-PROMPT-PASSWORD']);let active=true;terminal.readSecret=async()=>{active=false;return 'SYNTHETIC-PROMPT-PASSWORD';};
 await new api.VaultLoginBroker({vault,io:terminal}).use(scope,challenge,{...execution(),assertCurrent(){if(!active)throw Error('stale');}},()=>assert.fail('stale'));
 assert.deepEqual(await vault.list(scope),[]);
 assert.notEqual((await new api.VaultLoginBroker({vault,io:io(['yes'],[])}).use(scope,challenge,{...execution(),deadline:Date.now()-1},()=>assert.fail('expired'))).status,'used');
});

test('replacement while confirmation is pending cannot authorize new credential bytes',{skip:process.platform==='win32'},async t=>{
 const {vault}=await setup(t);const m=await vault.add(scope,input(),guard);const terminal=io([],[]);
 terminal.readLine=async()=>{await vault.replace(scope,m.id,m.revision,{...input(),password:Buffer.from('new-password')},guard);return 'yes';};
 const result=await new api.VaultLoginBroker({vault,io:terminal}).use(scope,challenge,execution(),()=>assert.fail('changed login'));assert.notEqual(result.status,'used');
});

test('multiple same-origin accounts require explicit selection and no cross-scope listing',{skip:process.platform==='win32'},async t=>{
 const {vault}=await setup(t);await vault.add(scope,input(),guard);await vault.add(scope,{...input(),label:'Second account',password:Buffer.from('second-password')},guard);
 await vault.add({workspaceId:'other',ownerId:'o'},{...input(),label:'Foreign account'},guard);
 const terminal=io(['2','yes'],[]);const result=await new api.VaultLoginBroker({vault,io:terminal}).use(scope,challenge,execution(),login=>{assert.equal(Buffer.from(login.password).toString(),'second-password');return null;});
 assert.equal(result.status,'used');assert.doesNotMatch(terminal.output.join('\n'),/Foreign account/);
});

test('terminal private-input reset drops pasted extra lines before normal chat',async()=>{
 const {NodeLineIo}=await import('../dist/cli/node-io.js');const input=new PassThrough(),output=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};output.isTTY=true;const terminal=new NodeLineIo(input,output);let shown='';output.on('data',b=>shown+=b);try{
  assert.equal(typeof terminal.discardSensitiveInput,'function');assert.equal(terminal.interactive,true);
  const read=terminal.readSecret('hidden: ');input.write('SYNTHETIC-PASSWORD\nSYNTHETIC-EXTRA\n');assert.equal(await read,'SYNTHETIC-PASSWORD');terminal.discardSensitiveInput();
  const next=terminal.readLine('chat: ');input.write('hello\n');assert.equal(await next,'hello');assert.doesNotMatch(shown,/SYNTHETIC/);
 }finally{terminal.close();input.destroy();output.destroy();}
});

test('Ctrl+C cancels hidden entry and cannot resurrect it into chat',async()=>{
 const {NodeLineIo}=await import('../dist/cli/node-io.js');const input=new PassThrough(),output=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};output.isTTY=true;const terminal=new NodeLineIo(input,output);try{
  assert.equal(typeof terminal.discardSensitiveInput,'function');const read=terminal.readSecret('hidden: ');input.write('SYNTHETIC-PARTIAL\x03');assert.equal(await read,null);terminal.discardSensitiveInput();const next=terminal.readLine();input.write('\x19hello\n');assert.equal(await next,'hello');
 }finally{terminal.close();input.destroy();output.destroy();}
});
