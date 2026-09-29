import { join, resolve } from 'node:path';
import { stderr, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  doctorChromeBridgeInstallation,
  finalizeChromeBridgeInstallation,
  removeChromeBridgeInstallation,
  stageChromeBridgeInstallation
} from '../browser/installation.js';
import type { ChromeBridgeDiagnosticInput, ChromeBridgeDiagnosticResult } from '../browser/coordinator.js';
import { loadStorageKeyFile } from '../storage/key-file.js';

const FAILURE = 'Chrome bridge command failed.\n';

type BrowserCommand =
  | { kind: 'stage'; root: string; chromePath: string; registrationDirectory: string }
  | { kind: 'finalize'; root: string; extensionId: string }
  | { kind: 'doctor'; root: string }
  | { kind: 'remove'; root: string }
  | { kind: 'run'; root: string; storageKeyPath: string };

class BrowserArgumentError extends Error {}

export interface BrowserCliDependencies {
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  loadStorageKey?: (path: string) => Uint8Array;
  diagnostic?: (input: ChromeBridgeDiagnosticInput) => Promise<ChromeBridgeDiagnosticResult>;
}

function options(argv: readonly string[], allowed: readonly string[]): Map<string, string> {
  if (argv.length % 2 !== 0) throw new BrowserArgumentError();
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.includes(flag) || flag.includes('=') || result.has(flag) ||
        !value || value.startsWith('--')) throw new BrowserArgumentError();
    result.set(flag, value);
  }
  return result;
}

function absolute(value: string): string {
  if (!value || resolve(value) !== value) throw new BrowserArgumentError();
  return value;
}

export function parseBrowserArgs(argv: readonly string[]): BrowserCommand {
  const [verb, ...rest] = argv;
  if (verb === 'setup') {
    const values = options(rest, ['--root', '--chrome', '--registration-dir', '--extension-id']);
    const root = values.get('--root');
    if (!root) throw new BrowserArgumentError();

    const chromePath = values.get('--chrome');
    const registrationDirectory = values.get('--registration-dir');
    const extensionId = values.get('--extension-id');
    if (chromePath && registrationDirectory && !extensionId && values.size === 3) {
      return {
        kind: 'stage',
        root: absolute(root),
        chromePath: absolute(chromePath),
        registrationDirectory: absolute(registrationDirectory)
      };
    }
    if (extensionId && !chromePath && !registrationDirectory && values.size === 2 &&
        /^[a-p]{32}$/.test(extensionId)) {
      return { kind: 'finalize', root: absolute(root), extensionId };
    }
    throw new BrowserArgumentError();
  }

  if (verb === 'doctor' || verb === 'remove') {
    const values = options(rest, ['--root']);
    const root = values.get('--root');
    if (!root || values.size !== 1) throw new BrowserArgumentError();
    return { kind: verb, root: absolute(root) };
  }

  if (verb === 'run') {
    const values = options(rest, ['--root', '--storage-key-file']);
    const root = values.get('--root');
    const storageKeyPath = values.get('--storage-key-file');
    if (!root || !storageKeyPath || values.size !== 2) throw new BrowserArgumentError();
    return { kind: 'run', root: absolute(root), storageKeyPath: absolute(storageKeyPath) };
  }

  throw new BrowserArgumentError();
}

export async function runBrowserCli(
  argv: readonly string[],
  dependencies: BrowserCliDependencies = {}
): Promise<number> {
  const writeOut = dependencies.writeStdout ?? (text => stdout.write(text));
  const writeErr = dependencies.writeStderr ?? (text => stderr.write(text));
  let command: BrowserCommand;
  try { command = parseBrowserArgs(argv); }
  catch { writeErr(FAILURE); return 2; }

  try {
    if (command.kind === 'stage') {
      const installation = stageChromeBridgeInstallation({
        root: command.root,
        packageRoot: process.cwd(),
        chromePath: command.chromePath,
        nodePath: process.execPath,
        registrationDirectory: command.registrationDirectory
      });
      writeOut(JSON.stringify({
        status: 'staged',
        root: installation.root,
        profilePath: installation.profilePath,
        extensionPath: installation.extensionPath,
        launcherPath: installation.launcherPath
      }) + '\n');
      return 0;
    }

    if (command.kind === 'finalize') {
      const installation = finalizeChromeBridgeInstallation({
        root: command.root,
        extensionId: command.extensionId
      });
      writeOut(JSON.stringify({
        status: 'configured',
        root: installation.root,
        extensionId: installation.extensionId,
        registrationPath: installation.registrationPath
      }) + '\n');
      return 0;
    }

    if (command.kind === 'doctor') {
      const report = doctorChromeBridgeInstallation({ root: command.root });
      writeOut(JSON.stringify({
        configured: report.configured,
        registered: report.registered,
        handshakeObserved: report.handshakeObserved,
        issues: report.issues,
        root: report.installation.root,
        profilePath: report.installation.profilePath,
        extensionPath: report.installation.extensionPath,
        registrationPath: report.installation.registrationPath
      }) + '\n');
      return 0;
    }

    if (command.kind === 'remove') {
      const result = removeChromeBridgeInstallation({ root: command.root });
      writeOut(JSON.stringify({ status: 'removed', retainedPaths: result.retainedPaths }) + '\n');
      return 0;
    }

    let encryptionKey: Uint8Array | undefined;
    try {
      encryptionKey = (dependencies.loadStorageKey ?? loadStorageKeyFile)(command.storageKeyPath);
      if (!(encryptionKey instanceof Uint8Array) || encryptionKey.byteLength !== 32)
        throw new Error(FAILURE);
      const enrollmentPath = join(command.root, 'runtime', 'bridge-enrollment.json');
      writeOut(`Chrome bridge enrollment file: ${JSON.stringify(enrollmentPath)}\n`);
      writeOut('Open the extension popup and connect the synthetic tab. Close the dedicated Chrome window after enrollment to finish the diagnostic.\n');
      const diagnostic = dependencies.diagnostic ??
        (await import('../browser/coordinator.js')).runChromeBridgeDiagnostic;
      const result = await diagnostic({
        root: command.root,
        dbPath: join(command.root, 'synthetic-service.db'),
        bootstrapDirectory: join(command.root, 'service-bootstrap'),
        workspaceId: 'synthetic-chrome-diagnostic',
        ownerId: 'owner',
        storageKeyPath: command.storageKeyPath,
        encryptionKey
      });
      writeOut(JSON.stringify(result) + '\n');
      return 0;
    } finally {
      encryptionKey?.fill(0);
    }
  } catch {
    writeErr(FAILURE);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBrowserCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
