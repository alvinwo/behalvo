import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, symlinkSync, linkSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as api from '../dist/index.js';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';

const posix=process.platform!=='win32';
const scope={workspaceId:'synthetic-workspace',ownerId:'synthetic-owner'};
const input=()=>({label:'Synthetic account',origin:'https://login.example.test',username:Buffer.from('  synthetic-user  '),password:Buffer.from('  SYNTHETIC-vault-canary-9!  ')});
function fixture(t){
 assert.equal(typeof api.LocalCredentialVault,'function','LocalCredentialVault is exported');
 const root=mkdtempSync(join(tmpdir(),'bhv-vault-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'vault.json');const key=Buffer.alloc(32,19);const options={path,loadKey:()=>Buffer.from(key)};
 const vault=new api.LocalCredentialVault(options);t.after(()=>vault.lock());return{root,path,key,options,vault};
}
const ref=m=>({id:m.id,revision:m.revision,origin:m.origin});
const guard={assertCurrent(){}};
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}

test('vault requires explicit initialization and preserves encrypted logins across restart',{skip:!posix},async t=>{
 const f=fixture(t);await assert.rejects(()=>f.vault.unlock());await assert.rejects(()=>f.vault.list(scope));
 await f.vault.initialize(scope);const m=await f.vault.add(scope,input(),guard);
 assert.deepEqual(Object.keys(m).sort(),['id','label','origin','revision','status']);
 const disk=readFileSync(f.path,'utf8');for(const value of ['synthetic-user','SYNTHETIC-vault-canary','Synthetic account','login.example.test','synthetic-workspace'])assert.ok(!disk.includes(value));
 f.vault.lock();await assert.rejects(()=>f.vault.withLogin(scope,ref(m),()=>assert.fail('locked use'),guard));
 const again=new api.LocalCredentialVault(f.options);t.after(()=>again.lock());await again.unlock();
 assert.deepEqual(await again.list(scope),[m]);let borrowed;
 assert.equal(await again.withLogin(scope,ref(m),async(login,check)=>{check();borrowed=login;assert.equal(Buffer.from(login.username).toString(),'  synthetic-user  ');assert.equal(Buffer.from(login.password).toString(),'  SYNTHETIC-vault-canary-9!  ');return 'filled';},guard),'filled');
 assert.ok(borrowed.username.every(x=>x===0));assert.ok(borrowed.password.every(x=>x===0));
 await assert.rejects(()=>again.initialize(scope));again.lock();unlinkSync(f.path);
 const missing=new api.LocalCredentialVault(f.options);t.after(()=>missing.lock());await assert.rejects(()=>missing.unlock());
});

test('vault scope and exact origin prevent cross-account disclosure',{skip:!posix},async t=>{
 const {vault}=fixture(t);await vault.initialize(scope);const m=await vault.add(scope,input(),guard);
 for(const other of [{...scope,ownerId:'other'},{...scope,workspaceId:'other'}]){
  assert.deepEqual(await vault.list(other),[]);await assert.rejects(()=>vault.withLogin(other,ref(m),()=>assert.fail('foreign use'),guard));
  await assert.rejects(()=>vault.remove(other,m.id,m.revision));
 }
 for(const origin of ['https://other.example.test','https://login.example.test:444','https://sub.login.example.test'])await assert.rejects(()=>vault.withLogin(scope,{...ref(m),origin},()=>assert.fail('foreign site'),guard));
 for(const origin of ['http://example.test','http://127.0.0.1:43118','https://login.example.test/path','https://user:pass@login.example.test','https://login.example.test/','https://*.example.test'])await assert.rejects(()=>vault.add(scope,{...input(),origin},guard));
});

test('replacement and removal invalidate old references without reviving tombstones',{skip:!posix},async t=>{
 const {vault}=fixture(t);await vault.initialize(scope);const m=await vault.add(scope,input(),guard);
 const newer=await vault.replace(scope,m.id,1,{...input(),password:Buffer.from('second-synthetic-password')},guard);
 assert.equal(newer.revision,2);await assert.rejects(()=>vault.withLogin(scope,ref(m),()=>assert.fail('stale'),guard));
 await assert.rejects(()=>vault.remove(scope,m.id,1));await vault.remove(scope,m.id,2);assert.deepEqual(await vault.list(scope),[]);
 await assert.rejects(()=>vault.withLogin(scope,ref(newer),()=>assert.fail('removed'),guard));
 await assert.rejects(()=>vault.replace(scope,m.id,3,input(),guard));
 const next=await vault.add(scope,input(),guard);assert.notEqual(next.id,m.id);
});

test('wrong key, tampering, plaintext and unsafe file custody fail with fixed errors',{skip:!posix},async t=>{
 const f=fixture(t);await f.vault.initialize(scope);await f.vault.add(scope,input(),guard);f.vault.lock();const original=readFileSync(f.path);
 const wrong=new api.LocalCredentialVault({...f.options,loadKey:()=>Buffer.alloc(32,20)});t.after(()=>wrong.lock());
 await assert.rejects(()=>wrong.unlock(),e=>e.message==='Credential vault unavailable.');
 writeFileSync(f.path,'SYNTHETIC-vault-canary-9!');await assert.rejects(()=>f.vault.unlock(),e=>e.message==='Credential vault unavailable.');
 writeFileSync(f.path,original);chmodSync(f.path,0o644);await assert.rejects(()=>f.vault.unlock());chmodSync(f.path,0o600);
 const moved=join(f.root,'original');writeFileSync(moved,original,{mode:0o600});unlinkSync(f.path);symlinkSync(moved,f.path);await assert.rejects(()=>f.vault.unlock());unlinkSync(f.path);linkSync(moved,f.path);await assert.rejects(()=>f.vault.unlock());
});

test('cancellation and stale authority after capture never publish new credentials',{skip:!posix},async t=>{
 const f=fixture(t);await f.vault.initialize(scope);const original=readFileSync(f.path);const abort=new AbortController();abort.abort();
 await assert.rejects(()=>f.vault.add(scope,input(),{...guard,signal:abort.signal}));
 await assert.rejects(()=>f.vault.add(scope,input(),{assertCurrent(){throw new Error('SYNTHETIC-vault-canary-9!');}}),e=>e.message==='Credential vault unavailable.');
 assert.deepEqual(readFileSync(f.path),original);
});

test('borrow holds exclusive custody through callback and fixed errors clear buffers',{skip:!posix},async t=>{
 const f=fixture(t);await f.vault.initialize(scope);const m=await f.vault.add(scope,input(),guard);
 const other=new api.LocalCredentialVault(f.options);t.after(()=>other.lock());await other.unlock();const entered=deferred(),release=deferred();let bytes;
 const use=f.vault.withLogin(scope,ref(m),async(login,check)=>{bytes=login.password;entered.resolve();await release.promise;check();return 'ok';},guard);
 await entered.promise;let removed=false;const remove=other.remove(scope,m.id,m.revision).then(()=>removed=true);
 await new Promise(r=>setTimeout(r,35));assert.equal(removed,false);release.resolve();assert.equal(await use,'ok');await remove;assert.ok(bytes.every(x=>x===0));
 const fresh=await f.vault.add(scope,input(),guard);
 await assert.rejects(()=>f.vault.withLogin(scope,ref(fresh),login=>{bytes=login.password;throw new Error(Buffer.from(bytes).toString());},guard),e=>e.message==='Credential vault unavailable.');assert.ok(bytes.every(x=>x===0));
});

test('same-process lock cancels an active borrow and rejects late callback results',{skip:!posix},async t=>{
 const f=fixture(t);await f.vault.initialize(scope);const m=await f.vault.add(scope,input(),guard);const entered=deferred(),release=deferred();let bytes;
 const use=f.vault.withLogin(scope,ref(m),async(login,check)=>{bytes=login.password;entered.resolve();await release.promise;check();return 'late';},guard);
 await entered.promise;f.vault.lock();assert.ok(bytes.every(x=>x===0));release.resolve();await assert.rejects(()=>use);await f.vault.unlock();assert.equal((await f.vault.list(scope)).length,1);
});

test('shared encrypted-file guard rejects cancelled publication while legacy behavior stays opt-in',{skip:!posix},async t=>{
 const f=fixture(t);const {PrivateEncryptedJsonFile}=await import('../dist/storage/private-encrypted-json-file.js');
 const schema={empty:()=>({n:0}),validate:v=>{assert.equal(typeof v.n,'number');}};
 const file=new PrivateEncryptedJsonFile(f.path,'credential-vault',f.key,schema);t.after(()=>file.dispose());
 await file.update(async()=>({next:{n:1},result:null}));const before=readFileSync(f.path);const controller=new AbortController();
 await assert.rejects(()=>file.update(async()=>{controller.abort();return{next:{n:2},result:null};},{signal:controller.signal,beforePublish(){}}));
 assert.deepEqual(readFileSync(f.path),before);
 const {ModelStateCodec}=await import('../dist/storage/model-state-codec.js');
 assert.throws(()=>new ModelStateCodec(f.key,'pi-credentials').open(before));
 file.dispose();await assert.rejects(()=>file.read());
});

test('replacement preserves the confirmed unlock epoch but cancels earlier borrows',{skip:!posix},async t=>{
 const f=fixture(t);await f.vault.initialize(scope);const m=await f.vault.add(scope,input(),guard);const epoch=f.vault.epoch;
 const saved=await f.vault.replace(scope,m.id,m.revision,input(),{assertCurrent(){assert.equal(f.vault.epoch,epoch);}});
 assert.equal(saved.revision,2);
});

test('an aborted write waiting for a borrow leaves no captured credential behind',{skip:!posix},async t=>{
 const f=fixture(t);await f.vault.initialize(scope);const m=await f.vault.add(scope,input(),guard);
 const other=new api.LocalCredentialVault(f.options);t.after(()=>other.lock());await other.unlock();const entered=deferred(),release=deferred();
 const use=f.vault.withLogin(scope,ref(m),async()=>{entered.resolve();await release.promise;},guard);await entered.promise;
 const controller=new AbortController();const pending=other.add(scope,{...input(),label:'Must not be saved'},{...guard,signal:controller.signal});controller.abort();await assert.rejects(()=>pending);
 release.resolve();await use;assert.equal((await other.list(scope)).length,1);
});

test('vault limits reject invalid bytes and metadata without publishing',{skip:!posix},async t=>{
 const f=fixture(t);await f.vault.initialize(scope);const original=readFileSync(f.path);
 for(const bad of [{...input(),label:'bad\nlabel'},{...input(),label:'x'.repeat(129)},{...input(),username:Buffer.alloc(1025,65)},{...input(),password:Buffer.alloc(16385,65)},{...input(),password:Buffer.from([0xff])},{...input(),password:Buffer.alloc(0)},{...input(),extra:'forbidden'}])await assert.rejects(()=>f.vault.add(scope,bad,guard));
 assert.deepEqual(readFileSync(f.path),original);
});

test('cancelled initialization and removal refuse publication',{skip:!posix},async t=>{
 const f=fixture(t);const controller=new AbortController();controller.abort();
 await assert.rejects(()=>f.vault.initialize(scope,{signal:controller.signal,...guard}));
 await f.vault.initialize(scope);const m=await f.vault.add(scope,input(),guard);
 await assert.rejects(()=>f.vault.remove(scope,m.id,m.revision,{signal:controller.signal,...guard}));assert.equal((await f.vault.list(scope)).length,1);
});

test('authority expiring during staging prevents both vault creation and replacement publication',{skip:!posix},async t=>{
 const f=fixture(t);const original=fs.fsyncSync;
 for(const create of [true,false]){
  if(!create)await f.vault.initialize(scope);
  const before=create?undefined:readFileSync(f.path);let current=true,count=0;
  fs.fsyncSync=fd=>{const result=original(fd);if(++count===2)current=false;return result;};syncBuiltinESMExports();
  try{
   const options={assertCurrent(){if(!current)throw Error('Synthetic deadline expired');}};
   await assert.rejects(()=>create?f.vault.initialize(scope,options):f.vault.add(scope,input(),options));
   assert.ok(count>=2);
   if(create)assert.equal(fs.existsSync(f.path),false);else assert.deepEqual(readFileSync(f.path),before);
   assert.deepEqual(fs.readdirSync(f.root),create?[]:['vault.json']);
  }finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 }
});
