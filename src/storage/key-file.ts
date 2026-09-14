import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { publishPrivateFile, readPrivateFile } from './private-files.js';

const KEY_ERROR = 'Invalid storage key file.';
const CREATE_ERROR = 'Unable to create storage key file.';
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalidKey(): never {
  throw new Error(KEY_ERROR);
}

export async function createStorageKeyFile(path: string): Promise<void> {
  try {
    const key = randomBytes(32);
    const document = JSON.stringify({ version: 1, key: key.toString('base64') });
    try {
      await publishPrivateFile(path, stagedPath => writeFile(stagedPath, `${document}\n`, 'utf8'));
    } finally {
      key.fill(0);
    }
  } catch {
    throw new Error(CREATE_ERROR);
  }
}

export function loadStorageKeyFile(path: string): Uint8Array {
  try {
    const text = readPrivateFile(path, 4096).toString('utf8');
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalidKey();
    const document = parsed as Record<string, unknown>;
    const keys = Object.keys(document).sort();
    if (keys.length !== 2 || keys[0] !== 'key' || keys[1] !== 'version' || document.version !== 1 ||
        typeof document.key !== 'string' || !BASE64.test(document.key))
      invalidKey();
    const key = Buffer.from(document.key, 'base64');
    if (key.byteLength !== 32 || key.toString('base64') !== document.key) invalidKey();
    const result = Uint8Array.from(key);
    key.fill(0);
    return result;
  } catch {
    invalidKey();
  }
}
