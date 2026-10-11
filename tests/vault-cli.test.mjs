import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import * as api from '../dist/index.js';
const scope={workspaceId:'w',ownerId:'o'};
test('vault commands capture privately, manage metadata and refuse inline values',{skip:process.platform==='win32'},async t=>{
 const module=await import('../dist/cli/vault-commands.js').catch(()=>({}));assert.equal(typeof module.handleVaultCommand,'function');
 const root=mkdtempSync(join(tmpdir(),'vault-cli-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const vault=new api.LocalCredentialVault({path:join(root,'vault'),loadKey:()=>Buffer.alloc(32,11)});t.after(()=>vault.lock());
 const answers=['yes','https://login.example.test','Synthetic login'];const secrets=['synthetic-user','SYNTHETIC-CLI-PASSWORD'];const output=[];
 const io={interactive:true,readLine:async()=>answers.shift()??null,readSecret:async()=>secrets.shift()??null,discardSensitiveInput(){},write:x=>output.push(x)};
 const options={vault,io,scope};await module.handleVaultCommand('/vault init',options);await module.handleVaultCommand('/vault add',options);
 const [m]=await vault.list(scope);assert.ok(m);await module.handleVaultCommand('/vault list',options);assert.match(output.join('\n'),/Synthetic login/);
 await module.handleVaultCommand('/vault add INLINE-PASSWORD',options);await module.handleVaultCommand('/vault add\nSYNTHETIC-CLI-PASSWORD',options);
 assert.doesNotMatch(output.join('\n'),/INLINE-PASSWORD|SYNTHETIC-CLI-PASSWORD|synthetic-user/);
 answers.push('yes');await module.handleVaultCommand(`/vault remove ${m.id}`,options);assert.deepEqual(await vault.list(scope),[]);
 await module.handleVaultCommand('/vault lock',options);assert.equal(vault.isUnlocked,false);await module.handleVaultCommand('/vault unlock',options);assert.equal(vault.isUnlocked,true);
});

test('vault configuration rejects unpaired, duplicated and colliding paths',async()=>{
 const module=await import('../dist/cli/vault-config.js').catch(()=>({}));assert.equal(typeof module.parseVaultConfiguration,'function');
 for(const args of [['--vault','v'],['--vault-key-file','k'],['--vault=v','--vault-key-file','k'],['--vault','v','--vault','v','--vault-key-file','k'],['--vault','same','--vault-key-file','same']])assert.throws(()=>module.parseVaultConfiguration(args,[]));
 assert.equal(module.parseVaultConfiguration([],[]),undefined);
 assert.throws(()=>module.parseVaultConfiguration(['--vault','same','--vault-key-file','key'],['same']));
 const valid=['--vault','some-vault','--vault-key-file','some-key'];
 if(process.platform==='win32')assert.throws(()=>module.parseVaultConfiguration(valid,[]));
 else assert.equal(module.parseVaultConfiguration(valid,[]).path,join(process.cwd(),'some-vault'));
});

test('REPL keeps multiline vault input and all captured values out of journal and model',{skip:process.platform==='win32'},async t=>{
 const {openLocalAgent}=await import('../dist/cli/local-app.js');const {runRepl}=await import('../dist/cli/repl.js');
 const root=mkdtempSync(join(tmpdir(),'vault-repl-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const model={provider:'fake',model:'synthetic'};const requests=[];const app=openLocalAgent({dbPath:join(root,'db'),workspaceId:'w',ownerId:'o',gateways:[{listModels:async()=>[model],complete:async r=>{requests.push(r);return{text:JSON.stringify({reply:'ok',workProposals:[],factProposals:[]})};}}]});t.after(()=>app.close());await app.registry.select('fake','synthetic');
 const vault=new api.LocalCredentialVault({path:join(root,'vault'),loadKey:()=>Buffer.alloc(32,11)});t.after(()=>vault.lock());await vault.initialize(scope);
 const lines=['/vault add\nSYNTHETIC-MULTILINE-SECRET','/vault add','hello','/quit'];const answers=['https://example.test','Account'];const secrets=['SYNTHETIC-USERNAME','SYNTHETIC-PASSWORD'];const output=[];
 await runRepl({store:app.store,registry:app.registry,service:app.service,workspaceId:'w',ownerId:'o',vault,io:{interactive:true,readPrompt:async()=>lines.shift()??null,readLine:async()=>answers.shift()??null,readSecret:async()=>secrets.shift()??null,discardSensitiveInput(){},write:x=>output.push(x)}});
 assert.equal((await vault.list(scope)).length,1);assert.equal(requests.length,1);
 const records=app.store.journal('w');const artifacts=records.filter(r=>r.event.type==='message.received').map(r=>app.store.readArtifact('w',r.event.data.artifactId));
 assert.doesNotMatch(JSON.stringify({requests,records,artifacts,output}),/SYNTHETIC-(?:MULTILINE-SECRET|USERNAME|PASSWORD)/);
});
