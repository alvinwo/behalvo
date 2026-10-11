import { vaultError, type LoginBytes } from './types.js';
import { vaultMessage } from './messages.js';

export interface PrivateCredentialIo {
  interactive?: boolean;
  readLine(prompt?: string, signal?: AbortSignal): Promise<string | null>;
  readSecret?(prompt?: string, signal?: AbortSignal): Promise<string | null>;
  discardSensitiveInput?(): void;
  write(line?: string): void;
}
export function canPromptCredentials(io: PrivateCredentialIo): boolean {
  return io.interactive === true && typeof io.readSecret === 'function' && typeof io.discardSensitiveInput === 'function';
}
export async function privatePrompt<T>(io: PrivateCredentialIo, run: () => Promise<T>): Promise<T> {
  if (!canPromptCredentials(io)) throw vaultError();
  io.discardSensitiveInput!();
  try { return await run(); }
  finally { io.discardSensitiveInput!(); }
}
export async function captureLogin<T>(io: PrivateCredentialIo, signal: AbortSignal,
  check: () => void, save: (bytes: LoginBytes) => Promise<T>): Promise<T> {
  let username: Buffer | undefined, password: Buffer | undefined;
  try {
    check(); const user = await io.readSecret!(vaultMessage('username'), signal); check();
    if (user === null || Buffer.byteLength(user, 'utf8') > 1024) throw vaultError();
    username = Buffer.from(user, 'utf8');
    const pass = await io.readSecret!(vaultMessage('password'), signal); check();
    if (pass === null || Buffer.byteLength(pass, 'utf8') > 16384) throw vaultError();
    password = Buffer.from(pass, 'utf8'); check();
    return await save({ username, password });
  } finally { username?.fill(0); password?.fill(0); }
}
