import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,existsSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomBytes} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {SqliteStore} from '../dist/storage/sqlite-store.js';import {Operator} from '../dist/runtime/operator.js';import {validateStorage} from '../dist/storage/sqlite-schema.js';import {journalContext,projectionContext} from '../dist/storage/sqlite-codec.js';import {emptyState,reduce} from '../dist/kernel/reducer.js';import {prepareProgressEvent} from '../dist/runtime/task-continuity.js';
for(const mutation of ['intake_owner','goal_quote','progress_owner','progress_cross_work'])test(`encrypted backup rejects authenticated but invalid task source: ${mutation}`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'continuity-backup-'));const path=join(dir,'db');const key=randomBytes(32);let store;
 try{
 store=new SqliteStore(path,{encryptionKey:key});store.createWorkspace('w','o');const operator=new Operator(store);for(const id of ['task','other'])operator.createWork('w','o',{id,title:id,goal:'Synthetic',threadId:'t'});
 const owner=store.ingest('w',{source:'owner',externalId:'one',threadId:'t',senderId:'o',senderRole:'owner',text:'Check synthetic slots'});const external=store.ingest('w',{source:'external',externalId:'two',threadId:'t',senderId:'stranger',senderRole:'external',text:'Check synthetic slots'});
 const foreign=operator.propose('w',{workId:'other',key:'foreign',command:{kind:'message.send',channel:'mock-email',to:'synthetic@example.test',body:'Synthetic'}});
 const receipt={ownerRecordId:owner.id,threadId:'t',workId:'task',workRevisionAtIntake:1,outcome:'ready',goalSourceQuote:'Check synthetic slots'};
 store.append('w',store.state('w').version,[{type:'task.intake_recorded',data:{receipt}},prepareProgressEvent(store,{workspaceId:'w',ownerId:'o',workId:'task',ownerRecordId:owner.id,expectedWorkRevision:1},{summary:'Still open',nextStep:'Observe',blocker:null,references:[]},'completed')]);
 const records=store.journal('w');const target=records.find(r=>r.event.type===(mutation.startsWith('progress')?'task.progress_recorded':'task.intake_recorded'));
 if(mutation==='intake_owner')target.event.data.receipt.ownerRecordId=external.id;
 if(mutation==='goal_quote')target.event.data.receipt.goalSourceQuote='Invented owner goal';
 if(mutation==='progress_owner')target.event.data.progress.ownerRecordId=external.id;
 if(mutation==='progress_cross_work')target.event.data.progress.references=[{kind:'action',id:foreign.id}];
 const projection=records.reduce((s,r)=>reduce(s,r.event,r.seq),emptyState('w',4));store.close();
 const db=new DatabaseSync(path);const cipher=validateStorage(db,key);const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='journal_no_update'").get().sql;db.exec('DROP TRIGGER journal_no_update');db.prepare('UPDATE journal SET event_json=? WHERE id=?').run(cipher.seal(JSON.stringify(target.event),journalContext(target,'event_json')),target.id);db.exec(trigger);
 db.prepare('UPDATE projections SET state_json=?').run(cipher.seal(JSON.stringify(projection),projectionContext('w',projection.version,4)));db.close();
 store=new SqliteStore(path,{encryptionKey:key});assert.throws(()=>store.rebuild('w'),/source|scope|quote/);
 await assert.rejects(()=>store.backup(join(dir,'backup')));assert.equal(existsSync(join(dir,'backup')),false);
 }finally{store?.close();key.fill(0);rmSync(dir,{recursive:true,force:true});}
});
