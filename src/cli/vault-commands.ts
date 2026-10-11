import type { LocalCredentialVault } from '../vault/local-vault.js';
import { captureLogin, canPromptCredentials, privatePrompt, type PrivateCredentialIo } from '../vault/private-prompt.js';
import { vaultMessage } from '../vault/messages.js';
import { loginOrigin, vaultText, syntheticLoginAuthority, SYNTHETIC_LOGIN_ORIGIN, type VaultScope } from '../vault/types.js';

export async function handleVaultCommand(raw: string, options: {
  vault?: LocalCredentialVault; io: PrivateCredentialIo; scope: VaultScope;
}): Promise<boolean> {
  if (!/^\s*\/vault(?:\s|$)/.test(raw)) return false;
  const { vault, io, scope } = options;
  const usage = () => io.write(vaultMessage('usage'));
  const words = raw.trim().split(/\s+/); const command = words[1] ?? 'list';
  if (/[\r\n]/.test(raw) || !['list', 'init', 'add', 'replace', 'remove', 'lock', 'unlock'].includes(command) ||
      words.length !== (['replace', 'remove'].includes(command) ? 3 : words.length === 1 ? 1 : 2)) { usage(); return true; }
  if (!vault) { io.write(vaultMessage('setup')); return true; }
  try {
    if (command === 'lock') { vault.lock(); io.write(vaultMessage('locked')); return true; }
    if (!canPromptCredentials(io)) { io.write(vaultMessage('privateInput')); return true; }
    if (command === 'unlock') { await vault.unlock(); io.write(vaultMessage('unlocked')); return true; }
    if (command === 'list') {
      const entries = await vault.list(scope); if (!entries.length) io.write(vaultMessage('empty'));
      for (const entry of entries) io.write(`${entry.id} — ${JSON.stringify(entry.label)} — ${entry.origin} — v${entry.revision}`);
      return true;
    }
    const deadline = Date.now() + 120000, signal = AbortSignal.timeout(120000), epoch = vault.epoch;
    const check = () => { if (signal.aborted || Date.now() >= deadline || vault.epoch !== epoch) throw new Error(); };
    await privatePrompt(io, async () => {
      if (command === 'init') {
        const answer = await io.readLine(vaultMessage('init'), signal); check();
        if (answer?.trim().toLowerCase() !== 'yes') { io.write(vaultMessage('cancelled')); return; }
        await vault.initialize(scope, { signal, assertCurrent: check }); io.write(vaultMessage('initialized')); return;
      }
      const old = ['replace', 'remove'].includes(command) ? (await vault.list(scope)).find(e => e.id === words[2]) : undefined;
      check(); if (['replace', 'remove'].includes(command) && !old) throw new Error();
      if (command === 'remove') {
        const answer = await io.readLine(vaultMessage('remove', { label: JSON.stringify(old!.label), origin: old!.origin }), signal); check();
        if (answer?.trim().toLowerCase() !== 'yes') { io.write(vaultMessage('cancelled')); return; }
        await vault.remove(scope, old!.id, old!.revision, { signal, assertCurrent: check }); io.write(vaultMessage('removed')); return;
      }
      const origin = old?.origin ?? loginOrigin(await io.readLine(vaultMessage('origin'), signal)); check();
      const label = await io.readLine(vaultMessage('label'), signal); check(); vaultText(label, 128);
      await captureLogin(io, signal, check, async bytes => {
        const input = { label, origin, ...bytes };
        if (old) await vault.replace(scope, old.id, old.revision, input, { signal, assertCurrent: check },
          old.origin === SYNTHETIC_LOGIN_ORIGIN ? syntheticLoginAuthority : undefined);
        else await vault.add(scope, input, { signal, assertCurrent: check });
      });
      io.write(vaultMessage('saved'));
    });
  } catch { io.write(vaultMessage('unavailable')); }
  return true;
}
