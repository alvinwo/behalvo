import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {SqliteStore} from '../dist/storage/sqlite-store.js';import {validateStorage} from '../dist/storage/sqlite-schema.js';import {projectionContext} from '../dist/storage/sqlite-codec.js';
for(const encrypted of [false,true])for(const version of [1,2,3])test(`continuity upgrade v${version}, encrypted=${encrypted}, preserves history and replay`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'continuity-upgrade-'));const path=join(dir,'db');const key=randomBytes(32);const options=encrypted?{encryptionKey:key}:{};let store;
 try{
 store=new SqliteStore(path,options);store.createWorkspace('w','o');store.close();const db=new DatabaseSync(path);const row=db.prepare('SELECT * FROM projections').get();const cipher=encrypted?validateStorage(db,key):undefined;
 const state=JSON.parse(cipher?cipher.open(row.state_json,projectionContext('w',row.version,row.projection_version)):row.state_json);delete state.taskContinuity;if(version<3)delete state.browserMemory;if(version<2)delete state.teachingMemory;
 const raw=JSON.stringify(state);db.prepare('UPDATE projections SET projection_version=?,state_json=?').run(version,cipher?cipher.seal(raw,projectionContext('w',row.version,version)):raw);db.close();
 store=new SqliteStore(path,options);store.ingest('w',{source:'owner',externalId:'one',threadId:'t',senderId:'o',senderRole:'owner',text:'Synthetic goal'});
 assert.equal(store.projectionVersion('w'),version);assert.equal(store.state('w').taskContinuity,undefined);const journal=store.journal('w');
 store.upgradeTaskContinuityProjection('w');assert.equal(store.projectionVersion('w'),4);assert.deepEqual(store.state('w').taskContinuity,{focus:{},intakes:{},progress:{}});store.upgradeTaskContinuityProjection('w');store.upgradeBrowserProjection('w');store.upgradeTeachingProjection('w');
 assert.deepEqual(store.journal('w'),journal);assert.deepEqual(store.rebuild('w'),store.state('w'));if(encrypted)await store.backup(join(dir,'backup'));const expected=store.state('w');store.close();store=new SqliteStore(encrypted?join(dir,'backup'):path,options);assert.deepEqual(store.rebuild('w'),expected);
 }finally{store?.close();key.fill(0);rmSync(dir,{recursive:true,force:true});}
});
test('continuity maintenance CLI requires explicit workspace',async()=>{
 const {parseStorageArgs}=await import('../dist/cli/storage-main.js');assert.deepEqual(parseStorageArgs(['upgrade-continuity','--db','synthetic.db','--workspace','w']),{verb:'upgrade-continuity',db:'synthetic.db',workspace:'w'});assert.throws(()=>parseStorageArgs(['upgrade-continuity','--db','synthetic.db']));
});
for(const encrypted of [false,true])test(`corrupt old source prevents continuity upgrade without replacing projection, encrypted=${encrypted}`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'continuity-corrupt-'));const path=join(dir,'db');const key=randomBytes(32);const options=encrypted?{encryptionKey:key}:{};let store;
 try{
 store=new SqliteStore(path,options);store.createWorkspace('w','o');store.ingest('w',{source:'owner',externalId:'x',threadId:'t',senderId:'o',senderRole:'owner',text:'Synthetic source'});store.close();
 const db=new DatabaseSync(path);const row=db.prepare('SELECT * FROM projections').get();const cipher=encrypted?validateStorage(db,key):undefined;const state=JSON.parse(cipher?cipher.open(row.state_json,projectionContext('w',row.version,row.projection_version)):row.state_json);delete state.taskContinuity;
 const old=cipher?cipher.seal(JSON.stringify(state),projectionContext('w',row.version,3)):JSON.stringify(state);db.prepare('UPDATE projections SET projection_version=3,state_json=?').run(old);db.exec("UPDATE artifacts SET body=''");db.close();
 store=new SqliteStore(path,options);assert.throws(()=>store.upgradeTaskContinuityProjection('w'));assert.equal(store.projectionVersion('w'),3);store.close();
 const check=new DatabaseSync(path);assert.equal(check.prepare('SELECT state_json FROM projections').get().state_json,old);check.close();
 }finally{store?.close();key.fill(0);rmSync(dir,{recursive:true,force:true});}
});
test('normal continuity startup directs legacy stores to maintenance and releases its lock',async()=>{
 const {openLocalAgent}=await import('../dist/cli/local-app.js');const dir=mkdtempSync(join(tmpdir(),'continuity-startup-'));const path=join(dir,'db');
 const options={dbPath:path,workspaceId:'w',ownerId:'o',gateways:[{listModels:async()=>[],complete:async()=>{throw new Error('unused')}}]};
 try{openLocalAgent(options).close();const db=new DatabaseSync(path);const state=JSON.parse(db.prepare('SELECT state_json FROM projections').get().state_json);delete state.taskContinuity;db.prepare('UPDATE projections SET projection_version=3,state_json=?').run(JSON.stringify(state));db.close();
 assert.throws(()=>openLocalAgent({...options,taskContinuity:true}),/upgrade-continuity/);const legacy=openLocalAgent(options);assert.equal(legacy.store.projectionVersion('w'),3);legacy.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
