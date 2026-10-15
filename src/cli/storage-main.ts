import { taskMessage } from '../runtime/task-messages.js';
import { browserMessage } from '../runtime/browser-messages.js';
import { acquireLocalProcessLock } from '../storage/process-lock.js';
import { teachingMessage } from '../runtime/teaching-messages.js';
import { pathToFileURL } from 'node:url';
import { stderr, stdout } from 'node:process';
import { createStorageKeyFile, loadStorageKeyFile } from '../storage/key-file.js';
import { SqliteStore } from '../storage/sqlite-store.js';
import { BrowserActionBroker } from '../runtime/browser-actions.js';
import { liveMessage } from '../browser/live-messages.js';

const USAGE = `Usage:
  npm run storage -- recover-browser --db <database> --workspace <workspace> --exclusive-maintenance [--key-file <key-file>]
  npm run storage -- upgrade-continuity --db <database> --workspace <workspace> [--key-file <key-file>]
  npm run storage -- upgrade-browser --db <database> --workspace <workspace> [--key-file <key-file>]
  npm run storage -- upgrade-teachings --db <database> --workspace <workspace> [--key-file <key-file>]
  npm run storage -- keygen --out <key-file>
  npm run storage -- backup --db <source-db> --out <backup-db> --key-file <key-file>
  npm run storage -- restore --from <backup-db> --out <new-db> --key-file <key-file>
`;

class StorageArgumentError extends Error {}

type StorageCommand =
  | { verb: 'recover-browser'; db:string; workspace:string; exclusiveMaintenance:true; keyFile?:string }
  | { verb: 'upgrade-continuity'; db: string; workspace: string; keyFile?: string }
  | { verb: 'upgrade-teachings'; db: string; workspace: string; keyFile?: string }
  | { verb: 'upgrade-browser'; db: string; workspace: string; keyFile?: string }
  | { verb: 'usage' }
  | { verb: 'keygen'; out: string }
  | { verb: 'backup'; db: string; out: string; keyFile: string }
  | { verb: 'restore'; from: string; out: string; keyFile: string };

function parseOptions(argv: string[], names: readonly string[]): Map<string, string> {
  const allowed = new Set(names);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.has(flag) || values.has(flag) || !value || value.startsWith('--'))
      throw new StorageArgumentError();
    values.set(flag, value);
  }
  if (values.size !== names.length || names.some(name => !values.has(name))) throw new StorageArgumentError();
  return values;
}

export function parseStorageArgs(argv: string[]): StorageCommand {
  if (argv.length === 0 || argv.includes('--help')) return { verb: 'usage' };
  const [verb, ...options] = argv;
  if(verb==='recover-browser'){
    if(options.filter(value=>value==='--exclusive-maintenance').length!==1)throw new StorageArgumentError();
    const values=parseOptions(options.filter(value=>value!=='--exclusive-maintenance'),['--db','--workspace',...(options.includes('--key-file')?['--key-file']:[])]);
    return {verb,db:values.get('--db')!,workspace:values.get('--workspace')!,exclusiveMaintenance:true,...(values.has('--key-file')?{keyFile:values.get('--key-file')!}:{})};
  }
  if (verb === 'upgrade-teachings' || verb === 'upgrade-browser' || verb === 'upgrade-continuity') {
    const names = ['--db','--workspace', ...(options.includes('--key-file') ? ['--key-file'] : [])];
    const values = parseOptions(options,names);
    return {verb,db:values.get('--db')!,workspace:values.get('--workspace')!,...(values.has('--key-file')?{keyFile:values.get('--key-file')!}:{})};
  }
  if (verb === 'keygen') {
    const values = parseOptions(options, ['--out']);
    return { verb, out: values.get('--out')! };
  }
  if (verb === 'backup') {
    const values = parseOptions(options, ['--db', '--out', '--key-file']);
    return { verb, db: values.get('--db')!, out: values.get('--out')!, keyFile: values.get('--key-file')! };
  }
  if (verb === 'restore') {
    const values = parseOptions(options, ['--from', '--out', '--key-file']);
    return { verb, from: values.get('--from')!, out: values.get('--out')!, keyFile: values.get('--key-file')! };
  }
  throw new StorageArgumentError();
}

async function copyEncrypted(sourcePath: string, destination: string, keyPath: string): Promise<void> {
  const key = loadStorageKeyFile(keyPath);
  let source: SqliteStore | undefined;
  try {
    source = new SqliteStore(sourcePath, { encryptionKey: key, readOnly: true });
    await source.backup(destination);
  } finally {
    source?.close();
    key.fill(0);
  }
}

export async function runStorageCli(argv: string[]): Promise<number> {
  let command: StorageCommand;
  try {
    command = parseStorageArgs(argv);
  } catch {
    stderr.write('Invalid storage command.\n');
    return 2;
  }
  if (command.verb === 'usage') {
    stdout.write(USAGE);
    return 0;
  }
  try {
    if(command.verb==='recover-browser'){
      const lock=acquireLocalProcessLock(command.db);let store:SqliteStore|undefined,key:Uint8Array|undefined;
      try{
        key=command.keyFile?loadStorageKeyFile(command.keyFile):undefined;
        // Authenticate the existing file and workspace before any writable open.
        store=new SqliteStore(lock.dbPath,{readOnly:true,...(key?{encryptionKey:key}:{})});store.state(command.workspace);store.close();store=undefined;
        store=new SqliteStore(lock.dbPath,key?{encryptionKey:key}:{});
        const count=new BrowserActionBroker(store).recoverInterrupted(command.workspace,command.exclusiveMaintenance);
        stdout.write(liveMessage('recovered')+count+'\n');
      }finally{store?.close();key?.fill(0);lock.release();}
    } else if (command.verb === 'upgrade-teachings' || command.verb === 'upgrade-browser' || command.verb === 'upgrade-continuity') {
      const lock = acquireLocalProcessLock(command.db); let store: SqliteStore | undefined; let key: Uint8Array | undefined;
      try { key = command.keyFile ? loadStorageKeyFile(command.keyFile) : undefined;
        store = new SqliteStore(lock.dbPath,key ? {encryptionKey:key} : {});
        if(command.verb==='upgrade-continuity')store.upgradeTaskContinuityProjection(command.workspace);else if(command.verb==='upgrade-browser')store.upgradeBrowserProjection(command.workspace);else store.upgradeTeachingProjection(command.workspace);
        stdout.write((command.verb==='upgrade-continuity'?taskMessage('upgraded'):command.verb==='upgrade-browser'?browserMessage('upgraded'):teachingMessage('upgraded'))+'\n');
      } finally { store?.close(); key?.fill(0); lock.release(); }
    } else if (command.verb === 'keygen') {
      await createStorageKeyFile(command.out);
      stdout.write('Storage key created.\n');
    } else if (command.verb === 'backup') {
      await copyEncrypted(command.db, command.out, command.keyFile);
      stdout.write('Encrypted storage backup created.\n');
    } else {
      await copyEncrypted(command.from, command.out, command.keyFile);
      stdout.write('Encrypted storage restored.\n');
    }
    return 0;
  } catch {
    if(command.verb==='recover-browser'){stderr.write(liveMessage('recoveryFailed')+'\n');return 1;}
    if (command.verb === 'upgrade-teachings' || command.verb === 'upgrade-browser' || command.verb === 'upgrade-continuity') { stderr.write((command.verb==='upgrade-continuity'?taskMessage('upgradeFailed'):command.verb==='upgrade-browser'?browserMessage('upgradeFailed'):teachingMessage('upgradeFailed'))+'\n'); return 1; }
    const operation = command.verb === 'keygen' ? 'key generation' : command.verb;
    stderr.write(command.verb === 'keygen'
      ? 'Storage key generation failed.\n'
      : `Encrypted storage ${operation} failed.\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStorageCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
