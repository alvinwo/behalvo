import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { stdin, stdout, stderr } from 'node:process';
import { FakeModelGateway } from '../model/fake-gateway.js';
import { PiModelGateway, createPiRuntimeLoader } from '../model/pi-gateway.js';
import { openLocalAgent } from './local-app.js';
import { runRepl } from './repl.js';
import { NodeLineIo } from './node-io.js';

interface CliArgs {
  offline: boolean;
  dbPath: string;
  authPath: string;
  workspaceId: string;
  ownerId: string;
  model?: { provider: string; model: string };
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
  const model = parseModel(valueAfter(argv, '--model') ?? process.env.OPERATOR_MODEL);
  return {
    offline: argv.includes('--offline'),
    dbPath: resolve(valueAfter(argv, '--db') ?? process.env.OPERATOR_DB ?? 'data/agent.db'),
    authPath: resolve(valueAfter(argv, '--auth') ?? process.env.OPERATOR_PI_AUTH ?? 'data/pi-auth.json'),
    workspaceId: valueAfter(argv, '--workspace') ?? process.env.OPERATOR_WORKSPACE ?? 'personal',
    ownerId: valueAfter(argv, '--owner') ?? process.env.OPERATOR_OWNER ?? 'owner',
    ...(model ? { model } : {})
  };
}

function terminalIo(): NodeLineIo {
  return new NodeLineIo(stdin, stdout);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
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
  const app = openLocalAgent({
    dbPath: args.dbPath,
    workspaceId: args.workspaceId,
    ownerId: args.ownerId,
    gateways
  });
  const io = terminalIo();
  try {
    if (args.offline) {
      await app.registry.select('offline', 'deterministic');
    } else if (args.model) {
      await app.registry.select(args.model.provider, args.model.model);
    }
    await runRepl({
      store: app.store,
      registry: app.registry,
      service: app.service,
      ...(!args.offline ? { authenticator: pi } : {}),
      io,
      workspaceId: args.workspaceId,
      ownerId: args.ownerId
    });
  } finally {
    io.close();
    app.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
