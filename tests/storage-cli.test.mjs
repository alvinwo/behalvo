import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createStorageKeyFile, loadStorageKeyFile, SqliteStore } from '../dist/index.js';

const POSIX = process.platform !== 'win32';
const warning = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/gm;

function runStorage(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli/storage-main.js', ...args], {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr: stderr.replace(warning, '') }));
  });
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'behalvo-storage-cli-'));
  chmodSync(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('storage CLI usage and strict option errors have stable exit codes', { skip: !POSIX }, async t => {
  await fixture(t);
  for (const args of [[], ['--help'], ['keygen', '--help']]) {
    const result = await runStorage(args);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /keygen --out|backup --db|restore --from/);
  }
  for (const args of [
    ['unknown'], ['keygen'], ['keygen', '--out'], ['keygen', '--out=a'],
    ['keygen', '--out', 'a', '--out', 'b'], ['backup', '--db', 'a', '--out', 'b', '--key-file', 'c', '--extra']
  ]) {
    const result = await runStorage(args);
    assert.equal(result.code, 2, `${args.join(' ')}\n${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Invalid storage command.\n');
  }
});

test('storage keygen, backup, and restore print no keys or payloads and restore literal state', { skip: !POSIX }, async t => {
  const directory = await fixture(t);
  const keyPath = join(directory, 'key.behalvo-key');
  const recoveredKeyPath = join(directory, 'recovered.behalvo-key');
  const dbPath = join(directory, 'agent.db');
  const backupPath = join(directory, 'backup.db');
  const restoredPath = join(directory, 'restored.db');
  const generated = await runStorage(['keygen', '--out', keyPath]);
  assert.deepEqual(generated, { code: 0, stdout: 'Storage key created.\n', stderr: '' });
  const keyText = readFileSync(keyPath, 'utf8');
  assert.equal(generated.stdout.includes(JSON.parse(keyText).key), false);
  const collision = await runStorage(['keygen', '--out', keyPath]);
  assert.deepEqual(collision, { code: 1, stdout: '', stderr: 'Storage key generation failed.\n' });
  assert.equal(readFileSync(keyPath, 'utf8'), keyText);
  await copyFile(keyPath, recoveredKeyPath);
  chmodSync(recoveredKeyPath, 0o400);

  const store = new SqliteStore(dbPath, { encryptionKey: loadStorageKeyFile(keyPath) });
  store.createWorkspace('personal', 'synthetic-owner');
  store.ingest('personal', { source: 'synthetic-source', externalId: 'synthetic-id', threadId: 'synthetic-thread',
    senderId: 'synthetic-owner', senderRole: 'owner', text: 'synthetic secret payload' });
  const expected = store.state('personal');
  const expectedJournal = store.journal('personal');
  store.close();

  const backup = await runStorage(['backup', '--db', dbPath, '--out', backupPath, '--key-file', keyPath]);
  assert.deepEqual(backup, { code: 0, stdout: 'Encrypted storage backup created.\n', stderr: '' });
  const restore = await runStorage(['restore', '--from', backupPath, '--out', restoredPath, '--key-file', recoveredKeyPath]);
  assert.deepEqual(restore, { code: 0, stdout: 'Encrypted storage restored.\n', stderr: '' });
  for (const output of [backup.stdout, backup.stderr, restore.stdout, restore.stderr]) {
    assert.equal(output.includes(JSON.parse(keyText).key), false);
    assert.equal(output.includes('synthetic secret payload'), false);
  }
  const restored = new SqliteStore(restoredPath, { encryptionKey: loadStorageKeyFile(recoveredKeyPath) });
  assert.deepEqual(restored.state('personal'), expected);
  assert.deepEqual(restored.journal('personal'), expectedJournal);
  restored.close();
});

test('storage CLI runtime failures are fixed and do not create missing inputs or overwrite outputs', { skip: !POSIX }, async t => {
  const directory = await fixture(t);
  const keyPath = join(directory, 'key.behalvo-key');
  await createStorageKeyFile(keyPath);
  const missing = join(directory, 'missing.db');
  const output = join(directory, 'output.db');
  const missingResult = await runStorage(['backup', '--db', missing, '--out', output, '--key-file', keyPath]);
  assert.deepEqual(missingResult, { code: 1, stdout: '', stderr: 'Encrypted storage backup failed.\n' });
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(output), false);
  const missingRestore = await runStorage(['restore', '--from', missing, '--out', output, '--key-file', keyPath]);
  assert.deepEqual(missingRestore, { code: 1, stdout: '', stderr: 'Encrypted storage restore failed.\n' });
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(output), false);

  const dbPath = join(directory, 'agent.db');
  const store = new SqliteStore(dbPath, { encryptionKey: loadStorageKeyFile(keyPath) });
  store.createWorkspace('personal', 'owner');
  store.close();
  writeFileSync(output, 'preserve me', { mode: 0o600 });
  const collision = await runStorage(['backup', '--db', dbPath, '--out', output, '--key-file', keyPath]);
  assert.deepEqual(collision, { code: 1, stdout: '', stderr: 'Encrypted storage backup failed.\n' });
  assert.equal(readFileSync(output, 'utf8'), 'preserve me');
  const wrongKey = join(directory, 'wrong.behalvo-key');
  await createStorageKeyFile(wrongKey);
  const wrong = await runStorage(['restore', '--from', dbPath, '--out', join(directory, 'wrong.db'), '--key-file', wrongKey]);
  assert.deepEqual(wrong, { code: 1, stdout: '', stderr: 'Encrypted storage restore failed.\n' });
});
test('browser recovery CLI requires explicit maintenance and never creates a missing database', {skip:!POSIX},async t=>{
 const dir=await fixture(t),path=join(dir,'missing.db');
 for(const suffix of [[],['--exclusive-maintenance','true'],['--exclusive-maintenance','--exclusive-maintenance']]){
  const result=await runStorage(['recover-browser','--db',path,'--workspace','personal',...suffix]);assert.equal(result.code,2);assert.equal(existsSync(path),false);
 }
 const result=await runStorage(['recover-browser','--db',path,'--workspace','personal','--exclusive-maintenance']);assert.equal(result.code,1);assert.equal(existsSync(path),false);
 const empty=join(dir,'empty.db');writeFileSync(empty,'',{mode:0o600});assert.equal((await runStorage(['recover-browser','--db',empty,'--workspace','personal','--exclusive-maintenance'])).code,1);assert.equal(readFileSync(empty).length,0);
});
for(const encrypted of [false,true])test(`browser maintenance recovery is scoped, exclusive and idempotent (${encrypted?'encrypted':'plaintext'})`,{skip:!POSIX},async t=>{
 const {Operator}=await import('../dist/runtime/operator.js'),{commandDigest}=await import('../dist/kernel/policy.js'),{acquireLocalProcessLock}=await import('../dist/storage/process-lock.js');
 const dir=await fixture(t),path=join(dir,'agent.db'),keyPath=join(dir,'storage.key');let key;
 if(encrypted){await createStorageKeyFile(keyPath);key=loadStorageKeyFile(keyPath);}
 const store=new SqliteStore(path,key?{encryptionKey:key}:{});store.createWorkspace('personal','owner');store.createWorkspace('other','owner');const op=new Operator(store);
 const browserCommand={kind:'browser.gesture',version:1,operation:'visit',url:'https://example.test/',origin:'https://example.test',threadId:'t',sessionId:'s',generation:1,grantRevision:1};
 for(const workspace of ['personal','other']){
  op.createWork(workspace,'owner',{id:'w',title:'Synthetic task',goal:'Inspect',threadId:'t'});
  const action={id:'browser',workId:'w',workRevision:1,key:'browser',command:browserCommand,digest:commandDigest(workspace,'w',1,browserCommand),status:'proposed'};
  store.append(workspace,store.state(workspace).version,[{type:'action.proposed',data:{action}},{type:'action.approved',data:{id:action.id,approval:{ownerId:'owner',digest:action.digest,expiresAt:new Date(Date.now()+30000).toISOString()}}},{type:'action.started',data:{id:action.id,attemptId:'browser-attempt'}}]);
 }
 const messageAction=op.propose('personal',{workId:'w',key:'message',command:{kind:'message.send',channel:'mock-email',to:'synthetic-recipient@example.test',body:'synthetic body'}});
 op.approve('personal','owner',messageAction.id,messageAction.digest,new Date(Date.now()+30000).toISOString());op.startEffect('personal',messageAction.id,'mock-email');
 op.createWork('personal','owner',{id:'settled',title:'Settled synthetic task',goal:'Inspect',threadId:'t'});
 const terminal={id:'terminal-browser',workId:'settled',workRevision:1,key:'terminal',command:browserCommand,digest:commandDigest('personal','settled',1,browserCommand),status:'proposed'};
 store.append('personal',store.state('personal').version,[{type:'action.proposed',data:{action:terminal}},{type:'action.cancelled',data:{id:terminal.id,reason:'Synthetic cancellation'}}]);
 const beforeOther=store.state('other'),beforeMessage=store.state('personal').actions[messageAction.id],beforeTerminal=store.state('personal').actions[terminal.id];store.close();
 const args=['recover-browser','--db',path,'--workspace','personal','--exclusive-maintenance',...(encrypted?['--key-file',keyPath]:[])];
 const lock=acquireLocalProcessLock(path);try{assert.equal((await runStorage(args)).code,1);}finally{lock.release();}
 const missingWorkspace=await runStorage(args.map(value=>value==='personal'?'missing':value));assert.equal(missingWorkspace.code,1);
 if(encrypted){const wrong=join(dir,'wrong.key');await createStorageKeyFile(wrong);assert.equal((await runStorage(args.map(value=>value===keyPath?wrong:value))).code,1);}
 const result=await runStorage(args);assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/1/);assert.doesNotMatch(result.stdout+result.stderr,/synthetic body|synthetic-recipient/);
 let read=new SqliteStore(path,key?{encryptionKey:key}:{});const after=read.state('personal');assert.equal(after.actions.browser.status,'unknown');assert.equal(after.actions.browser.attemptId,'browser-attempt');assert.deepEqual(after.actions[messageAction.id],beforeMessage);assert.deepEqual(after.actions[terminal.id],beforeTerminal);assert.deepEqual(read.state('other'),beforeOther);assert.deepEqual(read.rebuild('personal'),after);read.close();
 assert.equal((await runStorage(args)).code,0);read=new SqliteStore(path,key?{encryptionKey:key}:{});assert.deepEqual(read.state('personal'),after);assert.throws(()=>read.state('missing'));read.close();key?.fill(0);
});
