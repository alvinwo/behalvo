import { resolve } from 'node:path';
import { stderr, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadOwnerControlAssets } from '../control/assets.js';
import {
  initializeOwnerControlDemo,
  OWNER_CONTROL_DEMO_WORKSPACE
} from '../control/demo-fixture.js';
import { startOwnerControlServer } from '../control/http-server.js';
import { openOwnerControl } from '../control/local-app.js';

const USAGE = `Usage:
  npm run owner-control -- init-demo --db <database>
  npm run owner-control -- serve --db <database> --bootstrap-dir <directory> [--workspace <id>] [--port <0..65535>]
`;

export type OwnerControlCommand =
  | { kind: 'help' }
  | { kind: 'init-demo'; dbPath: string }
  | {
      kind: 'serve';
      dbPath: string;
      workspaceId: string;
      bootstrapDirectory: string;
      port: number;
    };

export interface OwnerControlCliDependencies {
  cwd?: string;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  signal?: AbortSignal;
}

class ArgumentError extends Error {}

function absolute(value: string, cwd: string): string {
  if (!value || value === ':memory:' || value.startsWith('--')) throw new ArgumentError();
  return resolve(cwd, value);
}

function options(argv: readonly string[], allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.includes(flag) || flag.includes('=') || result.has(flag) ||
      !value || value.startsWith('--')) {
      throw new ArgumentError();
    }
    result.set(flag, value);
  }
  return result;
}

export function parseOwnerControlArgs(
  argv: readonly string[],
  cwd = process.cwd()
): OwnerControlCommand {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--help')) {
    return { kind: 'help' };
  }

  const [verb, ...rest] = argv;
  if (verb === 'init-demo') {
    const values = options(rest, ['--db']);
    if (values.size !== 1 || !values.has('--db')) throw new ArgumentError();
    return { kind: 'init-demo', dbPath: absolute(values.get('--db')!, cwd) };
  }

  if (verb === 'serve') {
    const values = options(rest, ['--db', '--bootstrap-dir', '--workspace', '--port']);
    if (!values.has('--db') || !values.has('--bootstrap-dir')) throw new ArgumentError();
    const portText = values.get('--port') ?? '0';
    if (!/^(0|[1-9][0-9]*)$/.test(portText)) throw new ArgumentError();
    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port > 65_535) throw new ArgumentError();
    const workspaceId = values.get('--workspace') ?? OWNER_CONTROL_DEMO_WORKSPACE;
    if (!workspaceId) throw new ArgumentError();
    return {
      kind: 'serve',
      dbPath: absolute(values.get('--db')!, cwd),
      bootstrapDirectory: absolute(values.get('--bootstrap-dir')!, cwd),
      workspaceId,
      port
    };
  }

  throw new ArgumentError();
}

export async function runOwnerControlCli(
  argv: readonly string[],
  dependencies: OwnerControlCliDependencies = {}
): Promise<number> {
  const writeOut = dependencies.writeStdout ?? (text => stdout.write(text));
  const writeErr = dependencies.writeStderr ?? (text => stderr.write(text));
  let command: OwnerControlCommand;
  try {
    command = parseOwnerControlArgs(argv, dependencies.cwd ?? process.cwd());
  } catch {
    writeErr('Invalid owner-control command.\n');
    return 2;
  }

  if (command.kind === 'help') {
    writeOut(USAGE);
    return 0;
  }

  try {
    if (command.kind === 'init-demo') {
      const fixture = await initializeOwnerControlDemo(command.dbPath);
      writeOut(`Synthetic owner-control demo initialized for ${fixture.workspaceId}.\n`);
      return 0;
    }

    let app: ReturnType<typeof openOwnerControl> | undefined;
    let server: Awaited<ReturnType<typeof startOwnerControlServer>> | undefined;
    let closed = false;
    let stopRequested = false;
    let resolveStop!: () => void;
    const stopped = new Promise<void>(resolveDone => { resolveStop = resolveDone; });
    const requestStop = (): void => {
      if (stopRequested) return;
      stopRequested = true;
      resolveStop();
    };
    const injectedSignal = dependencies.signal;
    if (injectedSignal) {
      if (injectedSignal.aborted) requestStop();
      else injectedSignal.addEventListener('abort', requestStop, { once: true });
    } else {
      process.once('SIGINT', requestStop);
      process.once('SIGTERM', requestStop);
    }
    const removeStopListeners = (): void => {
      injectedSignal?.removeEventListener('abort', requestStop);
      if (!injectedSignal) {
        process.off('SIGINT', requestStop);
        process.off('SIGTERM', requestStop);
      }
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await server?.close();
      } finally {
        app?.close();
      }
    };

    try {
      if (stopRequested) return 0;
      app = openOwnerControl({
        dbPath: command.dbPath,
        workspaceId: command.workspaceId
      });
      server = await startOwnerControlServer({
        app,
        bootstrapDirectory: command.bootstrapDirectory,
        assets: loadOwnerControlAssets(),
        port: command.port
      });
      if (stopRequested) {
        await close();
        return 0;
      }
      writeOut(
        `Local synthetic owner control: ${server.origin}\n` +
        `Bootstrap file: ${JSON.stringify(server.bootstrapPath)}\n`
      );
      await stopped;
      await close();
      return 0;
    } catch {
      try { await close(); } catch { /* shutdown remains owned and non-logging */ }
      if (stopRequested) return 0;
      writeErr(app ? 'Owner control server failed.\n' : 'Owner control command failed.\n');
      return 1;
    } finally {
      removeStopListeners();
    }
  } catch {
    writeErr('Owner control command failed.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOwnerControlCli(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
