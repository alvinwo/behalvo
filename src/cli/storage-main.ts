import { pathToFileURL } from 'node:url';
import { stderr, stdout } from 'node:process';
import { createStorageKeyFile, loadStorageKeyFile } from '../storage/key-file.js';
import { SqliteStore } from '../storage/sqlite-store.js';

const USAGE = `Usage:
  npm run storage -- keygen --out <key-file>
  npm run storage -- backup --db <source-db> --out <backup-db> --key-file <key-file>
  npm run storage -- restore --from <backup-db> --out <new-db> --key-file <key-file>
`;

class StorageArgumentError extends Error {}

type StorageCommand =
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
    if (command.verb === 'keygen') {
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
