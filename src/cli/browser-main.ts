import { resolve } from 'node:path';
import { stderr, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  doctorChromeBridgeInstallation,
  finalizeChromeBridgeInstallation,
  removeChromeBridgeInstallation,
  stageChromeBridgeInstallation
} from '../browser/installation.js';

const FAILURE = 'Chrome bridge command failed.\n';

type BrowserCommand =
  | { kind: 'stage'; root: string; chromePath: string; registrationDirectory: string }
  | { kind: 'finalize'; root: string; extensionId: string }
  | { kind: 'doctor'; root: string }
  | { kind: 'remove'; root: string };

class BrowserArgumentError extends Error {}

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

  throw new BrowserArgumentError();
}

export async function runBrowserCli(argv: readonly string[]): Promise<number> {
  let command: BrowserCommand;
  try { command = parseBrowserArgs(argv); }
  catch { stderr.write(FAILURE); return 2; }

  try {
    if (command.kind === 'stage') {
      const installation = stageChromeBridgeInstallation({
        root: command.root,
        packageRoot: process.cwd(),
        chromePath: command.chromePath,
        nodePath: process.execPath,
        registrationDirectory: command.registrationDirectory
      });
      stdout.write(JSON.stringify({
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
      stdout.write(JSON.stringify({
        status: 'configured',
        root: installation.root,
        extensionId: installation.extensionId,
        registrationPath: installation.registrationPath
      }) + '\n');
      return 0;
    }

    if (command.kind === 'doctor') {
      const report = doctorChromeBridgeInstallation({ root: command.root });
      stdout.write(JSON.stringify({
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

    const result = removeChromeBridgeInstallation({ root: command.root });
    stdout.write(JSON.stringify({ status: 'removed', retainedPaths: result.retainedPaths }) + '\n');
    return 0;
  } catch {
    stderr.write(FAILURE);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBrowserCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
