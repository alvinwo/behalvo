import type { LocalCredentialVault } from './local-vault.js';
import { captureLogin, canPromptCredentials, privatePrompt, type PrivateCredentialIo } from './private-prompt.js';
import { vaultMessage } from './messages.js';
import { loginOrigin, syntheticLoginAuthority, vaultError, vaultScope, vaultText,
  type LoginBytes, type VaultScope } from './types.js';

export interface LoginChallenge extends VaultScope {
  workId: string; workRevision: number; sessionId: string; generation: number;
  documentId: string; observationId: string; ref: string; origin: string;
}
export interface LoginExecution {
  deadline: number; signal?: AbortSignal; assertCurrent(): void;
}
export type LoginUseResult<T> = { status: 'used'; value: T } | { status: 'skipped' | 'unavailable' | 'stopped' };

/** One trusted request, with no model-provided secret or durable grant. */
export class VaultLoginBroker {
  #used = false;
  constructor(private readonly options: { vault?: LocalCredentialVault; io: PrivateCredentialIo }) {}
  async use<T>(rawScope: VaultScope, rawChallenge: LoginChallenge, execution: LoginExecution,
    use: (login: LoginBytes, assertCurrent: () => void) => Promise<T> | T,
    authority?: typeof syntheticLoginAuthority): Promise<LoginUseResult<T>> {
    if (this.#used) return { status: 'unavailable' }; this.#used = true;
    const { vault, io } = this.options;
    if (!vault?.isUnlocked || !canPromptCredentials(io)) return { status: 'unavailable' };
    try {
      const scope = vaultScope(rawScope), challenge = structuredClone(rawChallenge), epoch = vault.epoch;
      if (scope.workspaceId !== challenge.workspaceId || scope.ownerId !== challenge.ownerId) throw vaultError();
      const origin = loginOrigin(challenge.origin, authority === syntheticLoginAuthority);
      for (const key of ['workId', 'sessionId', 'documentId', 'observationId', 'ref'] as const) vaultText(challenge[key], 256);
      for (const key of ['workRevision', 'generation'] as const)
        if (!Number.isSafeInteger(challenge[key]) || challenge[key] < 1) throw vaultError();
      if (!Number.isFinite(execution.deadline) || execution.deadline <= Date.now()) throw vaultError();
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(120000, Math.floor(execution.deadline - Date.now()))));
      const signal = execution.signal ? AbortSignal.any([timeout, execution.signal]) : timeout;
      const check = () => {
        if (signal.aborted || Date.now() >= execution.deadline || !vault.isUnlocked || vault.epoch !== epoch) throw vaultError();
        execution.assertCurrent();
      };
      check(); const candidates = (await vault.list(scope)).filter(item => item.origin === origin); check();
      return await privatePrompt(io, async (): Promise<LoginUseResult<T>> => {
        let selected = candidates[0];
        if (candidates.length > 1) {
          for (const [index, item] of candidates.entries()) io.write(`${index + 1}. ${JSON.stringify(item.label)} — ${item.origin}`);
          const answer = await io.readLine(vaultMessage('choose'), signal); check();
          if (!answer || !/^[1-9][0-9]*$/.test(answer) || Number(answer) > candidates.length) return { status: 'skipped' };
          selected = candidates[Number(answer) - 1];
        }
        const accepted = await io.readLine(vaultMessage(selected ? 'use' : 'saveUse',
          { origin, label: JSON.stringify(selected?.label ?? '') }), signal); check();
        if (accepted?.trim().toLowerCase() !== 'yes') return { status: 'skipped' };
        if (!selected) {
          const label = await io.readLine(vaultMessage('label'), signal); check(); vaultText(label, 128);
          selected = await captureLogin(io, signal, check, bytes =>
            vault.add(scope, { label, origin, ...bytes }, { signal, assertCurrent: check }, authority));
          check();
        }
        const reference = { id: selected.id, revision: selected.revision, origin };
        const value = await vault.withLogin(scope, reference, use, { signal, assertCurrent: check });
        check(); return { status: 'used', value };
      });
    } catch { return { status: 'stopped' }; }
  }
}
