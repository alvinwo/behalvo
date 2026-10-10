import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../dist/storage/sqlite-store.js';
import { Operator } from '../dist/runtime/operator.js';
test('old projection remains v1 through ordinary writes until explicit effect-free v2 upgrade',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bhv-teach-')); const path=join(dir,'db'); let store;
 try {
 store=new SqliteStore(path); store.createWorkspace('w','o'); store.close();
 const db=new DatabaseSync(path); const row=db.prepare('SELECT * FROM projections').get(); const state=JSON.parse(row.state_json); delete state.teachingMemory;
 db.prepare('UPDATE projections SET projection_version=1,state_json=?').run(JSON.stringify(state)); db.close();
 store=new SqliteStore(path); assert.equal(store.state('w').teachingMemory,undefined);
 new Operator(store).createWork('w','o',{id:'task',title:'task',goal:'synthetic',threadId:'t'});
 assert.equal(store.state('w').teachingMemory,undefined);
 const before=store.journal('w');
 assert.equal(typeof store.upgradeTeachingProjection,'function'); store.upgradeTeachingProjection('w');
 assert.deepEqual(store.state('w').teachingMemory,{teachings:{},clarifications:{}});
 assert.deepEqual(store.journal('w'),before); assert.deepEqual(store.rebuild('w'),store.state('w'));
 store.upgradeTeachingProjection('w'); assert.deepEqual(store.journal('w'),before);
 } finally {store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('upgrade CLI parses explicit workspace and optional key without accepting unrelated flags',async()=>{
 const {parseStorageArgs}=await import('../dist/cli/storage-main.js');
 assert.deepEqual(parseStorageArgs(['upgrade-teachings','--db','synthetic.db','--workspace','w']),{verb:'upgrade-teachings',db:'synthetic.db',workspace:'w'});
 assert.deepEqual(parseStorageArgs(['upgrade-teachings','--db','synthetic.db','--workspace','w','--key-file','key']),{verb:'upgrade-teachings',db:'synthetic.db',workspace:'w',keyFile:'key'});
 assert.throws(()=>parseStorageArgs(['upgrade-teachings','--db','synthetic.db']));
});
test('upgrade refuses corrupt old message source and preserves the old projection',()=>{
 const dir=mkdtempSync(join(tmpdir(),'teach-corrupt-'));const path=join(dir,'db');let store;
 try{
 store=new SqliteStore(path);store.createWorkspace('w','o');store.ingest('w',{source:'owner',externalId:'x',threadId:'t',senderId:'o',senderRole:'owner',text:'Synthetic source'});store.close();
 const db=new DatabaseSync(path);const old=JSON.parse(db.prepare('SELECT state_json FROM projections').get().state_json);delete old.teachingMemory;db.prepare('UPDATE projections SET projection_version=1,state_json=?').run(JSON.stringify(old));db.exec("UPDATE artifacts SET body=''");db.close();
 store=new SqliteStore(path);assert.throws(()=>store.upgradeTeachingProjection('w'));assert.equal(store.projectionVersion('w'),1);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('encrypted v1 backup upgrades explicitly and restores v2 without changing journal evidence',async()=>{
 const {randomBytes}=await import('node:crypto');const {validateStorage}=await import('../dist/storage/sqlite-schema.js');const {projectionContext}=await import('../dist/storage/sqlite-codec.js');
 const dir=mkdtempSync(join(tmpdir(),'teach-encrypted-'));const path=join(dir,'db');const key=randomBytes(32);let store;
 try{
 store=new SqliteStore(path,{encryptionKey:key});store.createWorkspace('w','o');store.ingest('w',{source:'owner',externalId:'x',threadId:'t',senderId:'o',senderRole:'owner',text:'Synthetic old instruction'});store.close();
 const db=new DatabaseSync(path);const cipher=validateStorage(db,key);const row=db.prepare('SELECT * FROM projections').get();const state=JSON.parse(cipher.open(row.state_json,projectionContext('w',row.version,2)));delete state.teachingMemory;db.prepare('UPDATE projections SET projection_version=1,state_json=?').run(cipher.seal(JSON.stringify(state),projectionContext('w',row.version,1)));db.close();
 store=new SqliteStore(path,{encryptionKey:key});const journal=store.journal('w');await store.backup(join(dir,'old-backup'));store.close();
 store=new SqliteStore(join(dir,'old-backup'),{encryptionKey:key});assert.equal(store.projectionVersion('w'),1);store.upgradeTeachingProjection('w');assert.equal(store.projectionVersion('w'),2);assert.deepEqual(store.journal('w'),journal);await store.backup(join(dir,'v2-backup'));const expected=store.state('w');store.close();
 store=new SqliteStore(join(dir,'v2-backup'),{encryptionKey:key});assert.deepEqual(store.rebuild('w'),expected);assert.deepEqual(store.journal('w'),journal);
 }finally{store?.close();key.fill(0);rmSync(dir,{recursive:true,force:true});}
});
test('corrupt encrypted v1 source cannot be upgraded or rewrite projection ciphertext',async()=>{
 const {randomBytes}=await import('node:crypto');const {validateStorage}=await import('../dist/storage/sqlite-schema.js');const {projectionContext}=await import('../dist/storage/sqlite-codec.js');
 const dir=mkdtempSync(join(tmpdir(),'teach-encrypted-bad-'));const path=join(dir,'db');const key=randomBytes(32);let store;
 try{
 store=new SqliteStore(path,{encryptionKey:key});store.createWorkspace('w','o');store.ingest('w',{source:'owner',externalId:'x',threadId:'t',senderId:'o',senderRole:'owner',text:'Synthetic source'});store.close();
 const db=new DatabaseSync(path);const cipher=validateStorage(db,key);const row=db.prepare('SELECT * FROM projections').get();const state=JSON.parse(cipher.open(row.state_json,projectionContext('w',row.version,2)));delete state.teachingMemory;const old=cipher.seal(JSON.stringify(state),projectionContext('w',row.version,1));db.prepare('UPDATE projections SET projection_version=1,state_json=?').run(old);db.exec("UPDATE artifacts SET body='corrupt'");db.close();
 store=new SqliteStore(path,{encryptionKey:key});assert.throws(()=>store.upgradeTeachingProjection('w'));assert.equal(store.projectionVersion('w'),1);store.close();
 const check=new DatabaseSync(path);assert.equal(check.prepare('SELECT state_json FROM projections').get().state_json,old);check.close();
 }finally{store?.close();key.fill(0);rmSync(dir,{recursive:true,force:true});}
});
