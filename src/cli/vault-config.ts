import { lstatSync } from 'node:fs';
import { resolveModelStatePath } from '../storage/private-encrypted-json-file.js';
import { loadStorageKeyFile } from '../storage/key-file.js';
import { LocalCredentialVault } from '../vault/local-vault.js';
import { vaultMessage } from '../vault/messages.js';

export interface VaultConfiguration { path: string; keyPath: string }
function fail(): never { throw new Error(vaultMessage('configuration')); }
function identity(path: string): { path: string; inode?: string } {
  const canonical = resolveModelStatePath(path);
  try {
    const s = lstatSync(canonical, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n) fail();
    return { path: canonical, inode: `${s.dev}:${s.ino}` };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: canonical }; throw error; }
}
export function parseVaultConfiguration(argv: readonly string[], reservedPaths: readonly string[]): VaultConfiguration | undefined {
  try {
    const option = (flag: string) => {
      if (argv.some(a => a.startsWith(flag + '=')) || argv.filter(a => a === flag).length > 1) fail();
      const index = argv.indexOf(flag); if (index < 0) return undefined;
      const value = argv[index + 1]; if (!value || value.startsWith('--')) fail(); return value;
    };
    const path = option('--vault'), keyPath = option('--vault-key-file');
    if (path === undefined && keyPath === undefined) return undefined;
    if (!path || !keyPath || process.platform === 'win32') fail();
    const chosen = [identity(path), identity(`${resolveModelStatePath(path)}.behalvo-model-state-lock`), identity(keyPath)];
    const others = reservedPaths.map(identity);
    for (let i = 0; i < chosen.length; i++) for (const other of [...chosen.slice(i + 1), ...others]) {
      const a = chosen[i]!;
      if (a.path === other.path || a.inode !== undefined && a.inode === other.inode) fail();
    }
    return { path: chosen[0]!.path, keyPath: chosen[2]!.path };
  } catch { fail(); }
}
export function configuredVault(config: VaultConfiguration): LocalCredentialVault {
  return new LocalCredentialVault({ path: config.path, loadKey: () => loadStorageKeyFile(config.keyPath) });
}
