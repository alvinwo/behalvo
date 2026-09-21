import { resolve } from 'node:path';
import { stderr, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadOwnerControlAssets } from '../control/assets.js';
import { FakeModelGateway } from '../model/fake-gateway.js';
import { PiCredentialFileStore } from '../model/pi-auth-store.js';
import { PiModelGateway, createPiRuntimeLoader } from '../model/pi-gateway.js';
import { ModelSettingsStore, settingsPathForDatabase } from './model-settings.js';
import { assertModelStatePathSeparation, loadModelStateProtection } from './model-state-config.js';
import { loadStorageKeyFile } from '../storage/key-file.js';
import type { ModelStateProtectionOptions } from '../storage/model-state-codec.js';
import { recoverLocalService, startLocalService,
  type LocalService, type LocalServiceRecoveryResult } from '../service/local-service.js';
import type { LocalServiceOptions } from '../service/config.js';

export type ServiceCommand =
  | { kind: 'help' }
  | { kind: 'run'; dbPath: string; bootstrapDirectory: string; workspaceId: string; ownerId: string;
      port: number; syntheticOperations: boolean; offline: boolean; upgradeStorage: boolean;
      model?: { provider: string; model: string }; authPath?: string; storageKeyPath?: string;
      modelStateKeyPath?: string }
  | { kind: 'recover'; dbPath: string; workspaceId: string; exclusiveMaintenance: true; storageKeyPath?: string };

export interface ServiceCliDependencies {
  cwd?: string;
  signal?: AbortSignal;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  start?: (options: LocalServiceOptions) => Promise<Pick<LocalService, 'origin' | 'bootstrapPath' | 'shutdown'>>;
  recover?: (options: { dbPath: string; workspaceId: string; exclusiveMaintenance: true; encryptionKey?: Uint8Array }) =>
    LocalServiceRecoveryResult | Promise<LocalServiceRecoveryResult>;
}

const USAGE = `Usage:\n  npm run service -- run --db <database> --bootstrap-dir <directory> [--workspace <id>] [--owner <id>] [--port <0..65535>] [--synthetic-operations] [--offline] [--upgrade-storage]\n  npm run service -- recover --db <database> --workspace <id> --exclusive-maintenance [--storage-key-file <key>]\n`;

class ArgumentError extends Error {}

function parseOptions(values: readonly string[], valueFlags: readonly string[], booleanFlags: readonly string[]) {
  const result = new Map<string, string | true>();
  for (let index = 0; index < values.length; index++) {
    const flag = values[index]!;
    if (!flag.startsWith('--') || flag.includes('=') || result.has(flag)) throw new ArgumentError();
    if (booleanFlags.includes(flag)) { result.set(flag, true); continue; }
    if (!valueFlags.includes(flag)) throw new ArgumentError();
    const value = values[++index];
    if (!value || value.startsWith('--')) throw new ArgumentError();
    result.set(flag, value);
  }
  return result;
}

function absolute(value: unknown, cwd: string): string {
  if (typeof value !== 'string' || !value || value === ':memory:') throw new ArgumentError();
  return resolve(cwd, value);
}

function modelRef(value: unknown): { provider: string; model: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ArgumentError();
  const slash = value.indexOf('/');
  if (slash < 1 || slash === value.length - 1) throw new ArgumentError();
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

export function parseServiceArgs(argv: readonly string[], cwd = process.cwd()): ServiceCommand {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) return { kind: 'help' };
  const [verb, ...rest] = argv;
  if (verb === 'run') {
    const parsed = parseOptions(rest, ['--db', '--bootstrap-dir', '--workspace', '--owner', '--port', '--model',
      '--auth', '--storage-key-file', '--model-state-key-file'],
      ['--synthetic-operations', '--offline', '--upgrade-storage']);
    if (!parsed.has('--db') || !parsed.has('--bootstrap-dir')) throw new ArgumentError();
    const portText = parsed.get('--port') ?? '0';
    if (typeof portText !== 'string' || !/^(0|[1-9][0-9]*)$/.test(portText)) throw new ArgumentError();
    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port > 65_535) throw new ArgumentError();
    const offline = parsed.has('--offline');
    if (offline && (parsed.has('--model') || parsed.has('--auth') || parsed.has('--model-state-key-file')))
      throw new ArgumentError();
    const model = modelRef(parsed.get('--model'));
    return { kind: 'run', dbPath: absolute(parsed.get('--db'), cwd),
      bootstrapDirectory: absolute(parsed.get('--bootstrap-dir'), cwd),
      workspaceId: String(parsed.get('--workspace') ?? 'personal'), ownerId: String(parsed.get('--owner') ?? 'owner'),
      port, syntheticOperations: parsed.has('--synthetic-operations'), offline,
      upgradeStorage: parsed.has('--upgrade-storage'),
      ...(model ? { model } : {}),
      ...(!offline ? { authPath: absolute(parsed.get('--auth') ?? 'data/pi-auth.json', cwd) } : {}),
      ...(parsed.has('--storage-key-file') ? { storageKeyPath: absolute(parsed.get('--storage-key-file'), cwd) } : {}),
      ...(parsed.has('--model-state-key-file') ?
        { modelStateKeyPath: absolute(parsed.get('--model-state-key-file'), cwd) } : {}) };
  }
  if (verb === 'recover') {
    const parsed = parseOptions(rest, ['--db', '--workspace', '--storage-key-file'], ['--exclusive-maintenance']);
    if (!parsed.has('--db') || !parsed.has('--workspace') || parsed.get('--exclusive-maintenance') !== true)
      throw new ArgumentError();
    return { kind: 'recover', dbPath: absolute(parsed.get('--db'), cwd),
      workspaceId: String(parsed.get('--workspace')), exclusiveMaintenance: true,
      ...(parsed.has('--storage-key-file') ? { storageKeyPath: absolute(parsed.get('--storage-key-file'), cwd) } : {}) };
  }
  throw new ArgumentError();
}

export async function runServiceCli(argv: readonly string[], dependencies: ServiceCliDependencies = {}): Promise<number> {
  const writeOut = dependencies.writeStdout ?? (text => stdout.write(text));
  const writeErr = dependencies.writeStderr ?? (text => stderr.write(text));
  let command: ServiceCommand;
  try { command = parseServiceArgs(argv, dependencies.cwd ?? process.cwd()); }
  catch { writeErr('Invalid service command.\n'); return 2; }
  if (command.kind === 'help') { writeOut(USAGE); return 0; }
  try {
    if (command.kind === 'recover') {
      let recoveryKey: Uint8Array | undefined;
      try {
        recoveryKey = command.storageKeyPath ? loadStorageKeyFile(command.storageKeyPath) : undefined;
        const result = await (dependencies.recover ?? recoverLocalService)({
          dbPath: command.dbPath, workspaceId: command.workspaceId, exclusiveMaintenance: true,
          ...(recoveryKey ? { encryptionKey: recoveryKey } : {})
        });
        writeOut(`Recovery recorded ${result.jobsInterrupted} service jobs interrupted and ${result.actionsUnknown} running actions unknown.\n`);
        return 0;
      } finally {
        recoveryKey?.fill(0);
      }
    }
    const offlineModel = { provider: 'offline', model: 'deterministic' };
    let encryptionKey: Uint8Array | undefined;
    let protection: ModelStateProtectionOptions = {};
    let serviceOptions: LocalServiceOptions;
    try {
      encryptionKey = command.storageKeyPath ? loadStorageKeyFile(command.storageKeyPath) : undefined;
      const common = {
        dbPath: command.dbPath, bootstrapDirectory: command.bootstrapDirectory,
        workspaceId: command.workspaceId, ownerId: command.ownerId, port: command.port,
        syntheticOperations: command.syntheticOperations, upgradeStorage: command.upgradeStorage,
        assets: loadOwnerControlAssets(),
        ...(encryptionKey ? { encryptionKey } : {}),
        ...(command.storageKeyPath ? { storageKeyPath: command.storageKeyPath } : {})
      };
      if (command.offline) {
        const gateway = new FakeModelGateway([{ ...offlineModel, label: 'Deterministic offline service model' }], () => ({
          text: JSON.stringify({ reply: 'Offline service reply.', workProposals: [], factProposals: [] })
        }));
        serviceOptions = { ...common, gateways: [gateway], model: offlineModel };
      } else {
        const authPath = command.authPath!;
        const settingsPath = settingsPathForDatabase(command.dbPath);
        if (command.modelStateKeyPath) {
          assertModelStatePathSeparation({ modelStateKeyPath: command.modelStateKeyPath, authPath, settingsPath,
            dbPath: command.dbPath, ...(command.storageKeyPath ? { storageKeyPath: command.storageKeyPath } : {}),
            syntheticOperations: command.syntheticOperations });
          protection = loadModelStateProtection({ modelStateKeyPath: command.modelStateKeyPath, authPath, settingsPath,
            dbPath: command.dbPath, ...(command.storageKeyPath ? { storageKeyPath: command.storageKeyPath } : {}),
            syntheticOperations: command.syntheticOperations });
        }
        const credentials = new PiCredentialFileStore(authPath, protection);
        const settings = new ModelSettingsStore(settingsPath, protection);
        await credentials.preflight({ writable: true });
        await settings.preflight({ writable: true });
        const selected = command.model ?? await settings.read(command.workspaceId);
        const gateway = new PiModelGateway(createPiRuntimeLoader(authPath, undefined, protection),
          protection.encryptionKey === undefined ? {} : { sanitizeErrors: true });
        serviceOptions = { ...common, gateways: [gateway], ...(selected ? { model: selected } : {}),
          authPath, settingsPath, ...(command.modelStateKeyPath ? { modelStateKeyPath: command.modelStateKeyPath,
            modelStateProtection: protection } : {}) };
      }
      const service = await (dependencies.start ?? startLocalService)(serviceOptions);
      writeOut(`Local Behalvo service: ${service.origin}\nBootstrap file: ${JSON.stringify(service.bootstrapPath)}\n`);
      let stop!: () => void;
      const stopped = new Promise<void>(resolveStopped => { stop = resolveStopped; });
      const requestStop = (): void => stop();
      const signal = dependencies.signal;
      if (signal?.aborted) requestStop();
      else if (signal) signal.addEventListener('abort', requestStop, { once: true });
      else { process.once('SIGINT', requestStop); process.once('SIGTERM', requestStop); }
      try { await stopped; }
      finally {
        signal?.removeEventListener('abort', requestStop);
        if (!signal) { process.off('SIGINT', requestStop); process.off('SIGTERM', requestStop); }
      }
      if (!await service.shutdown()) { writeErr('Local service did not settle safely.\n'); return 1; }
      return 0;
    } finally {
      encryptionKey?.fill(0);
      protection.encryptionKey?.fill(0);
    }
  } catch {
    writeErr(command.kind === 'recover' ? 'Service recovery failed.\n' : 'Local service failed.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runServiceCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
