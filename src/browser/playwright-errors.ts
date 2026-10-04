export type PlaywrightFailureCode = 'cancelled' | 'setup_timeout' | 'observation_timeout' |
  'browser_missing' | 'unsafe_environment' | 'launch_failed' | 'page_rejected' |
  'protocol_rejected' | 'read_only' | 'browser_closed' | 'cleanup_pending' | 'portal_failed';

/** Fixed operational categories only: never retain upstream Error/cause/content. */
export class PlaywrightDiagnosticError extends Error {
  constructor(readonly code: PlaywrightFailureCode) { super(code); this.name = 'PlaywrightDiagnosticError'; }
}

export function failureCode(error: unknown, fallback: PlaywrightFailureCode): PlaywrightFailureCode {
  return error instanceof PlaywrightDiagnosticError ? error.code : fallback;
}

/** Settles our wait; does not claim cancellation or nonexecution of the underlying operation. */
export async function bounded<T>(operation: Promise<T>, milliseconds: number,
  code: PlaywrightFailureCode, signal?: AbortSignal): Promise<T> {
  void operation.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(new PlaywrightDiagnosticError('cancelled'));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new PlaywrightDiagnosticError(code)), Math.max(1, milliseconds));
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
