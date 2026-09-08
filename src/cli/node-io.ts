import { createInterface, type Interface } from 'node:readline/promises';
import { Writable, type Readable } from 'node:stream';
import type { ReplIo } from './repl.js';

type Waiter = {
  resolve: (line: string | null) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  authentication: boolean;
};

export class NodeLineIo implements ReplIo {
  #rl: Interface;
  #resetting = false;
  readonly #queue: string[] = [];
  readonly #waiters: Waiter[] = [];
  #closed = false;
  #secret = false;
  #discardingAuthLine = false;
  readonly #restoreRaw: () => void;

  constructor(private readonly input: Readable, private readonly output: Writable) {
    const terminalInput = input as Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (raw: boolean) => unknown };
    const originalRaw = terminalInput.isRaw ?? false;
    this.#restoreRaw = () => {
      if (terminalInput.isTTY) terminalInput.setRawMode?.(originalRaw);
    };
    this.#rl = this.#createEditor();
  }

  #createEditor(): Interface {
    const input = this.input;
    const terminalInput = input as Readable & { isTTY?: boolean };
    // Use the editor for pipes too so partial authentication input can be erased
    // through public APIs. Pipes and input received between prompts are never echoed.
    const editorOutput = new Writable({
      write: (chunk, encoding, callback) => {
        if (terminalInput.isTTY && !this.#secret && !this.#discardingAuthLine && this.#waiters.length)
          this.output.write(chunk, encoding);
        callback();
      }
    });
    const onEnd = () => {
      if (this.#secret) this.#discardPartialLine();
    };
    input.prependListener('end', onEnd);
    const rl = createInterface({ input, output: editorOutput, terminal: true, historySize: 0, crlfDelay: Infinity });
    rl.on('line', line => {
      if (this.#discardingAuthLine) {
        line = '';
        this.#discardingAuthLine = false;
      }
      const waiter = this.#waiters.shift();
      // Buffered input has no known prompt yet and may be a credential.
      if (!waiter || waiter.authentication) this.#resetEditor();
      if (!waiter) {
        this.#queue.push(line);
        return;
      }
      this.#cleanup(waiter);
      waiter.resolve(line);
    });
    rl.on('close', () => {
      input.removeListener('end', onEnd);
      if (this.#resetting) return;
      this.#closed = true;
      this.#secret = false;
      this.#restoreRaw();
      for (const waiter of this.#waiters.splice(0)) {
        this.#cleanup(waiter);
        waiter.resolve(null);
      }
    });
    return rl;
  }

  #resetEditor(): void {
    if (this.#closed || this.input.readableEnded) return;
    const partial = this.#rl.line;
    this.#resetting = true;
    this.#rl.close();
    this.#resetting = false;
    this.#rl = this.#createEditor();
    if (partial) this.#rl.write(partial);
  }

  #cleanup(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort)
      waiter.signal.removeEventListener('abort', waiter.onAbort);
  }

  async readSecret(prompt = '', signal?: AbortSignal): Promise<string | null> {
    this.#secret = true;
    this.#resetEditor();
    try {
      return await this.readLine(prompt, signal);
    } finally {
      this.#secret = false;
    }
  }

  #discardPartialLine(): void {
    if (this.#closed) return;
    // Backspace avoids readline's kill ring, from which deleted credentials
    // could otherwise be pasted into a subsequent owner message with Ctrl+Y.
    this.#rl.write(null, { ctrl: true, name: 'e' });
    while (this.#rl.line.length) this.#rl.write(null, { name: 'backspace' });
  }

  async readLine(prompt = '', signal?: AbortSignal): Promise<string | null> {
    if (prompt) this.output.write(prompt);
    signal?.throwIfAborted();
    const queued = this.#queue.shift();
    if (queued !== undefined) return queued;
    if (this.#closed) return null;

    return new Promise<string | null>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, authentication: this.#secret || signal !== undefined, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          if (this.#rl.line.length) this.#discardingAuthLine = true;
          this.#discardPartialLine();
          this.#resetEditor();
          this.#cleanup(waiter);
          reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  write(line = ''): void {
    this.output.write(`${line}\n`);
  }

  close(): void {
    this.#rl.close();
  }
}
