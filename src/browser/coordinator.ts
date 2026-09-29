import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';

const LAUNCH_ERROR = 'Chrome bridge launch failed.';
const MAXIMUM_STDERR_BYTES = 16 * 1024;

export interface DedicatedChromeLaunchOptions {
  chromePath: string;
  profilePath: string;
}

export interface DedicatedChromeProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr(): string;
}

export function launchDedicatedChrome(input: DedicatedChromeLaunchOptions): DedicatedChromeProcess {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'chromePath,profilePath' ||
      typeof input.chromePath !== 'string' || !isAbsolute(input.chromePath) ||
      typeof input.profilePath !== 'string' || !isAbsolute(input.profilePath))
    throw new Error(LAUNCH_ERROR);

  let child: ChildProcess;
  try {
    child = spawn(input.chromePath, [
      `--user-data-dir=${input.profilePath}`,
      'http://127.0.0.1:43117/'
    ], {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe']
    });
  } catch {
    throw new Error(LAUNCH_ERROR);
  }

  let errorText = '';
  let errorBytes = 0;
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (errorBytes >= MAXIMUM_STDERR_BYTES) return;
    const remaining = MAXIMUM_STDERR_BYTES - errorBytes;
    const bytes = Buffer.from(chunk, 'utf8');
    const kept = bytes.subarray(0, remaining);
    errorText += kept.toString('utf8');
    errorBytes += kept.byteLength;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    exited,
    stderr(): string { return errorText; }
  };
}
