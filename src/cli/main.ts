import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stdin, stdout, stderr } from 'node:process';
import { FakeModelGateway } from '../model/fake-gateway.js';
import { PiModelGateway, createPiRuntimeLoader } from '../model/pi-gateway.js';
import { openLocalAgent } from './local-app.js';
import { runRepl } from './repl.js';
import { NodeLineIo } from './node-io.js';
import { ModelSettingsStore, settingsPathForDatabase } from './model-settings.js';
import { loadStorageKeyFile } from '../storage/key-file.js';

export interface CliArgs {
  offline: boolean;
  syntheticOperations: boolean;
  dbPath: string;
  authPath: string;
  workspaceId: string;
  ownerId: string;
  model?: { provider: string; model: string };
  storageKeyPath?: string;
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseModel(value: string | undefined): { provider: string; model: string } | undefined {
  if (!value) return undefined;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1)
    throw new Error('--model must be provider/model');
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

export function parseCliArgs(argv: string[]): CliArgs {
  if (argv.some(value => value.startsWith('--storage-key-file=')))
    throw new Error('--storage-key-file requires a separate value');
  const storageKeyFlags = argv.filter(value => value === '--storage-key-file').length;
  if (storageKeyFlags > 1) throw new Error('--storage-key-file may be provided once');
  const configuredStorageKey = storageKeyFlags === 1
    ? valueAfter(argv, '--storage-key-file')
    : process.env.BEHALVO_STORAGE_KEY_FILE;
  if (configuredStorageKey !== undefined && configuredStorageKey.length === 0)
    throw new Error('Configured storage key file is empty');
  const model = parseModel(valueAfter(argv, '--model') ?? process.env.BEHALVO_MODEL ?? process.env.OPERATOR_MODEL);
  return {
    offline: argv.includes('--offline'),
    syntheticOperations: argv.includes('--synthetic-operations'),
    dbPath: resolve(valueAfter(argv, '--db') ?? (argv.includes('--synthetic-operations') ? 'data/synthetic-agent.db' : process.env.BEHALVO_DB ?? process.env.OPERATOR_DB ?? 'data/agent.db')),
    authPath: resolve(valueAfter(argv, '--auth') ?? process.env.BEHALVO_PI_AUTH ?? process.env.OPERATOR_PI_AUTH ?? 'data/pi-auth.json'),
    workspaceId: valueAfter(argv, '--workspace') ?? process.env.BEHALVO_WORKSPACE ?? process.env.OPERATOR_WORKSPACE ?? 'personal',
    ownerId: valueAfter(argv, '--owner') ?? process.env.BEHALVO_OWNER ?? process.env.OPERATOR_OWNER ?? 'owner',
    ...(model ? { model } : {}),
    ...(configuredStorageKey ? { storageKeyPath: resolve(configuredStorageKey) } : {})
  };
}

function terminalIo(): NodeLineIo {
  return new NodeLineIo(stdin, stdout);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.storageKeyPath && args.syntheticOperations)
    throw new Error('Encrypted storage cannot use persistent synthetic operations.');
  const encryptionKey = args.storageKeyPath ? loadStorageKeyFile(args.storageKeyPath) : undefined;
  mkdirSync(dirname(args.dbPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(args.authPath), { recursive: true, mode: 0o700 });

  const offline = new FakeModelGateway(
    [{ provider: 'offline', model: 'deterministic', label: 'Deterministic offline smoke model' }],
    request => ({
      text: JSON.stringify({
        reply: `Offline model received: ${request.prompt.includes('RAW MESSAGE') ? 'a durable owner message' : 'context'}.`,
        workProposals: [],
        factProposals: []
      })
    })
  );
  const pi = new PiModelGateway(createPiRuntimeLoader(args.authPath));
  const gateways = args.offline ? [offline] : [pi];
  let app;
  try {
    app = openLocalAgent({
      dbPath: args.dbPath,
      workspaceId: args.workspaceId,
      ownerId: args.ownerId,
      gateways,
      syntheticOperations: args.syntheticOperations,
      ...(encryptionKey ? { encryptionKey } : {})
    });
  } finally {
    encryptionKey?.fill(0);
  }
  const io = terminalIo();
  try {
    if (args.syntheticOperations) io.write('SYNTHETIC OPERATIONS ONLY — simulated account data; no real account effects.');
    if (args.offline) {
      await app.registry.select('offline', 'deterministic');
    } else {
      const settings = new ModelSettingsStore(settingsPathForDatabase(args.dbPath));
      const startupModel = args.model ?? await settings.read(args.workspaceId);
      if (startupModel) {
        try {
          const selected = await app.registry.select(startupModel.provider, startupModel.model);
          await settings.write(args.workspaceId, selected);
          io.write(`Active model: ${selected.provider}/${selected.model}`);
        } catch (error) {
          if (!args.model)
            throw new Error('Saved model selection is unavailable. Recover with --model provider/model; then use /model to inspect the catalog.');
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`${detail}. Recover with --model provider/model or /model <provider> <model>.`);
        }
      } else {
        io.write('No model selected. Run /login openai-codex oauth, then /model and /model <provider> <model>.');
      }
    }
    await runRepl({
      store: app.store,
      registry: app.registry,
      service: app.service,
      operations: app.operations,
      ...(!args.offline ? { authenticator: pi } : {}),
      io,
      workspaceId: args.workspaceId,
      ownerId: args.ownerId,
      ...(!args.offline ? { onModelSelected: (selected: { provider: string; model: string }) =>
        new ModelSettingsStore(settingsPathForDatabase(args.dbPath)).write(args.workspaceId, selected) } : {})
    });
  } finally {
    io.close();
    app.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
