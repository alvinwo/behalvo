import { startSemanticFixture, type SemanticSite } from '../browser/semantic-fixture-sites.js';
import { ManagedBrowserController } from '../browser/managed-session.js';
import { liveMessage } from '../browser/live-messages.js';
import { reviewBrowserGesture } from './browser-commands.js';
import { SemanticPlaywright } from '../browser/semantic-playwright.js';
import { startSyntheticLoginFixture } from '../browser/synthetic-login-fixture.js';
import { SyntheticLoginBrowser } from '../browser/synthetic-login-browser.js';
import { VaultLoginBroker } from '../vault/login-broker.js';
import type { BrowserExplorationOptions } from '../runtime/browser-exploration.js';
import { browserMessage } from '../runtime/browser-messages.js';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stdin, stdout, stderr } from 'node:process';
import { FakeModelGateway } from '../model/fake-gateway.js';
import { PiModelGateway, createPiRuntimeLoader } from '../model/pi-gateway.js';
import { PiCredentialFileStore } from '../model/pi-auth-store.js';
import { openLocalAgent } from './local-app.js';
import { runRepl } from './repl.js';
import { NodeLineIo } from './node-io.js';
import type { TerminalPromptIo } from './terminal-prompt.js';
import { ModelSettingsStore, settingsPathForDatabase } from './model-settings.js';
import { loadStorageKeyFile } from '../storage/key-file.js';
import type { ModelStateProtectionOptions } from '../storage/model-state-codec.js';
import { configuredVault, parseVaultConfiguration, type VaultConfiguration } from './vault-config.js';
import { vaultMessage } from '../vault/messages.js';
import type { LocalCredentialVault } from '../vault/local-vault.js';
import {
  assertModelStatePathSeparation,
  loadModelStateProtection,
  resolveModelStateKeyPath
} from './model-state-config.js';

export interface CliArgs {
  vault?: VaultConfiguration;
  offline: boolean;
  syntheticOperations: boolean;
  teachingMode?: boolean;
  semanticSite?: SemanticSite | 'login';
  liveBrowser?: boolean;
  dbPath: string;
  authPath: string;
  workspaceId: string;
  ownerId: string;
  model?: { provider: string; model: string };
  storageKeyPath?: string;
  modelStateKeyPath?: string;
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
  if (argv.some(value => value.startsWith('--model-state-key-file=')))
    throw new Error('--model-state-key-file requires a separate value');
  const modelStateKeyFlags = argv.filter(value => value === '--model-state-key-file').length;
  if (modelStateKeyFlags > 1) throw new Error('--model-state-key-file may be provided once');
  const offline = argv.includes('--offline');
  const explicitModelStateKey = modelStateKeyFlags === 1
    ? valueAfter(argv, '--model-state-key-file')
    : undefined;
  const modelStateKeyPath = resolveModelStateKeyPath(
    explicitModelStateKey,
    process.env.BEHALVO_MODEL_STATE_KEY_FILE,
    process.cwd(),
    !offline
  );
  const semanticSite=valueAfter(argv,'--synthetic-browser');
  const liveBrowser=valueAfter(argv,'--browser');
  if(argv.filter(value=>value==='--browser').length>1||argv.some(value=>/^--(?:browser=|browser-|proxy|cdp|profile|ignore-https-errors|allow-localhost|resolver)/.test(value))||
    liveBrowser&&(liveBrowser!=='live'||offline||semanticSite||argv.includes('--synthetic-operations')))throw new Error(liveMessage('flag'));
  if(semanticSite&&(!['appointments-a','appointments-b','classes','login'].includes(semanticSite)||offline||argv.includes('--synthetic-operations')))throw new Error(browserMessage('invalidFixture'));
  const model = parseModel(valueAfter(argv, '--model') ?? process.env.BEHALVO_MODEL ?? process.env.OPERATOR_MODEL);
  const parsed: CliArgs = {
    offline,
    ...(liveBrowser?{liveBrowser:true}:{}),
    ...(semanticSite?{semanticSite:semanticSite as SemanticSite | 'login',teachingMode:true}:{}),
    ...(argv.includes('--task-teachings') ? {teachingMode:true} : {}),
    syntheticOperations: argv.includes('--synthetic-operations'),
    dbPath: resolve(valueAfter(argv, '--db') ?? (argv.includes('--synthetic-operations') ? 'data/synthetic-agent.db' : process.env.BEHALVO_DB ?? process.env.OPERATOR_DB ?? 'data/agent.db')),
    authPath: resolve(valueAfter(argv, '--auth') ?? process.env.BEHALVO_PI_AUTH ?? process.env.OPERATOR_PI_AUTH ?? 'data/pi-auth.json'),
    workspaceId: valueAfter(argv, '--workspace') ?? process.env.BEHALVO_WORKSPACE ?? process.env.OPERATOR_WORKSPACE ?? 'personal',
    ownerId: valueAfter(argv, '--owner') ?? process.env.BEHALVO_OWNER ?? process.env.OPERATOR_OWNER ?? 'owner',
    ...(model ? { model } : {}),
    ...(configuredStorageKey ? { storageKeyPath: resolve(configuredStorageKey) } : {}),
    ...(modelStateKeyPath ? { modelStateKeyPath } : {})
  };
  const settingsPath = settingsPathForDatabase(parsed.dbPath);
  const reserved = [parsed.dbPath, `${parsed.dbPath}-wal`, `${parsed.dbPath}-shm`, `${parsed.dbPath}-journal`,
    `${parsed.dbPath}.behalvo-lock`, parsed.authPath, `${parsed.authPath}.behalvo-model-state-lock`,
    settingsPath, `${settingsPath}.behalvo-model-state-lock`,
    ...(parsed.storageKeyPath ? [parsed.storageKeyPath] : []), ...(parsed.modelStateKeyPath ? [parsed.modelStateKeyPath] : [])];
  if (parsed.syntheticOperations) for (const suffix of ['', '-wal', '-shm', '-journal']) reserved.push(`${parsed.dbPath}.synthetic.sqlite${suffix}`);
  const vault = parseVaultConfiguration(argv, reserved);
  return { ...parsed, ...(vault ? { vault } : {}) };
}

async function terminalIo(): Promise<NodeLineIo | TerminalPromptIo> {
  if (!stdin.isTTY || !stdout.isTTY) return new NodeLineIo(stdin, stdout);
  const { TerminalPromptIo } = await import('./terminal-prompt.js');
  return new TerminalPromptIo(stdin, stdout);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if(args.liveBrowser&&(!stdin.isTTY||!stdout.isTTY))throw new Error(liveMessage('interactive'));
  if (args.storageKeyPath && args.syntheticOperations)
    throw new Error('Encrypted storage cannot use persistent synthetic operations.');
  let encryptionKey: Uint8Array | undefined;
  let protection: ModelStateProtectionOptions = {};
  let app;
  let pi: PiModelGateway | undefined;
  let settings: ModelSettingsStore | undefined;
  let fixture: Awaited<ReturnType<typeof startSemanticFixture>> | undefined;
  let loginFixture: Awaited<ReturnType<typeof startSyntheticLoginFixture>> | undefined;
  let vault: LocalCredentialVault | undefined;
  let io: NodeLineIo | TerminalPromptIo | undefined;
  let managed: ManagedBrowserController | undefined;
  const browser: BrowserExplorationOptions | undefined=args.semanticSite?{open:async context=>{
    if (args.semanticSite === 'login') {
      loginFixture ??= await startSyntheticLoginFixture();
      return new SyntheticLoginBrowser(loginFixture.authority, context.execution.signal ?? new AbortController().signal);
    }
    fixture??=await startSemanticFixture(args.semanticSite as SemanticSite);
    return new SemanticPlaywright(fixture.policy,context.execution.signal ?? new AbortController().signal);
  }, login: async (binding, challenge, execution, use) => {
    if (!io || !loginFixture) return { status: 'unavailable' };
    return new VaultLoginBroker({ ...(vault ? { vault } : {}), io }).use(
      { workspaceId: binding.workspaceId, ownerId: binding.ownerId }, challenge, execution, use,
      loginFixture.authority.secretAuthority);
  }}:args.liveBrowser?{mode:'live',sessionState:scope=>{if(!managed)throw new Error(liveMessage('unavailable'));return managed.sessionState(scope);},beforeTurn:scope=>managed?.beforeTurn(scope),available:scope=>managed?.available(scope)??false,open:(context,binding)=>{
    if(!managed)throw new Error(liveMessage('unavailable'));return managed.exploration().open(context,binding);
  }}:undefined;
  try {
    encryptionKey = args.storageKeyPath ? loadStorageKeyFile(args.storageKeyPath) : undefined;
    if (args.offline) {
      mkdirSync(dirname(args.dbPath), { recursive: true, mode: 0o700 });
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
      app = openLocalAgent({
        dbPath: args.dbPath,
        workspaceId: args.workspaceId,
        ownerId: args.ownerId,
        gateways: [offline],
        syntheticOperations: args.syntheticOperations,
        ...(args.teachingMode ? {teachingMode:true} : {}),
        ...(browser?{browser}:{}),
        ...(encryptionKey ? { encryptionKey } : {})
      });
    } else {
      const settingsPath = settingsPathForDatabase(args.dbPath);
      if (args.modelStateKeyPath) {
        protection = loadModelStateProtection({
          modelStateKeyPath: args.modelStateKeyPath,
          authPath: args.authPath,
          settingsPath,
          dbPath: args.dbPath,
          ...(args.storageKeyPath ? { storageKeyPath: args.storageKeyPath } : {}),
          syntheticOperations: args.syntheticOperations
        });
        assertModelStatePathSeparation({
          modelStateKeyPath: args.modelStateKeyPath,
          authPath: args.authPath,
          settingsPath,
          dbPath: args.dbPath,
          ...(args.storageKeyPath ? { storageKeyPath: args.storageKeyPath } : {}),
          syntheticOperations: args.syntheticOperations
        });
      }
      settings = new ModelSettingsStore(settingsPath, protection);
      if (protection.encryptionKey !== undefined) {
        const credentials = new PiCredentialFileStore(args.authPath, protection);
        await credentials.preflight({ writable: true });
        await settings.preflight({ writable: true });
      } else {
        mkdirSync(dirname(args.authPath), { recursive: true, mode: 0o700 });
      }
      const loader = createPiRuntimeLoader(args.authPath, undefined, protection);
      pi = new PiModelGateway(loader,
        protection.encryptionKey === undefined ? {} : { sanitizeErrors: true });
      mkdirSync(dirname(args.dbPath), { recursive: true, mode: 0o700 });
      app = openLocalAgent({
        dbPath: args.dbPath,
        workspaceId: args.workspaceId,
        ownerId: args.ownerId,
        gateways: [pi],
        taskContinuity: true,
        syntheticOperations: args.syntheticOperations,
        ...(args.teachingMode ? {teachingMode:true} : {}),
        ...(browser?{browser}:{}),
        ...(encryptionKey ? { encryptionKey } : {})
      });
    }
  } finally {
    encryptionKey?.fill(0);
    protection.encryptionKey?.fill(0);
  }
  let stopping=false;
  const stopForSignal=(signal:NodeJS.Signals)=>{
    if(stopping)return;stopping=true;
    void(async()=>{const result=await managed?.shutdown();if(result&&!result.confirmed)stderr.write(liveMessage('cleanupPending')+'\n');
      vault?.lock();io?.close();await fixture?.close();await loginFixture?.close();app.close();process.exit(signal==='SIGINT'?130:143);
    })().catch(()=>{stderr.write(liveMessage('cleanupPending')+'\n');process.exit(1);});
  };
  try {
    io = await terminalIo();
    if(args.liveBrowser){managed=new ManagedBrowserController(app.store,(action,detail,signal)=>reviewBrowserGesture(io!,action,detail,signal));io.write(liveMessage('startup'));}
    process.on('SIGINT',stopForSignal);process.on('SIGTERM',stopForSignal);
    if (args.vault) {
      vault = configuredVault(args.vault);
      io.write(vaultMessage('locked'));
    }
    if(args.semanticSite)io.write(browserMessage('synthetic'));
    if (args.syntheticOperations) io.write('SYNTHETIC OPERATIONS ONLY — simulated account data; no real account effects.');
    if (args.offline) {
      await app.registry.select('offline', 'deterministic');
    } else {
      if (!settings || !pi) throw new Error('Online model state was not initialized.');
      const startupModel = args.model ?? await settings.read(args.workspaceId);
      if (startupModel) {
        let selected;
        try {
          selected = await app.registry.select(startupModel.provider, startupModel.model);
        } catch (error) {
          if (!args.model)
            throw new Error('Saved model selection is unavailable. Recover with --model provider/model; then use /model to inspect the catalog.');
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`${detail}. Recover with --model provider/model or /model <provider> <model>.`);
        }
        await settings.write(args.workspaceId, selected);
        io.write(`Active model: ${selected.provider}/${selected.model}`);
      } else {
        io.write('No model selected. Run /login openai-codex oauth, then /model and /model <provider> <model>.');
      }
    }
    await runRepl({
      store: app.store,
      registry: app.registry,
      service: app.service,
      operations: app.operations,
      ...(!args.offline && pi ? { authenticator: pi } : {}),
      io,
      workspaceId: args.workspaceId,
      ownerId: args.ownerId,
      ...(vault ? { vault } : {}),
      ...(managed?{managedBrowser:managed}:{}),
      ...(!args.offline && settings ? { onModelSelected: (selected: { provider: string; model: string }) =>
        settings.write(args.workspaceId, selected) } : {})
    });
  } finally {
    process.off('SIGINT',stopForSignal);process.off('SIGTERM',stopForSignal);
    const cleanup=await managed?.shutdown();if(cleanup&&!cleanup.confirmed){stderr.write(liveMessage('cleanupPending')+'\n');process.exitCode=1;}
    vault?.lock();
    io?.close();
    app.close();
    await fixture?.close();
    await loginFixture?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
