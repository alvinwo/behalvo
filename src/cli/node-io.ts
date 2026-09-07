import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { ReplIo } from './repl.js';

type Waiter = {
  resolve: (line: string | null) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class NodeLineIo implements ReplIo {
  readonly #rl: Interface;
  readonly #queue: string[] = [];
  readonly #waiters: Waiter[] = [];
  #closed = false;

  constructor(input: Readable, private readonly output: Writable) {
    this.#rl = createInterface({ input, crlfDelay: Infinity });
    this.#rl.on('line', line => {
      const waiter = this.#waiters.shift();
      if (!waiter) {
        this.#queue.push(line);
        return;
      }
      this.#cleanup(waiter);
      waiter.resolve(line);
    });
    this.#rl.on('close', () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) {
        this.#cleanup(waiter);
        waiter.resolve(null);
      }
    });
  }

  #cleanup(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort)
      waiter.signal.removeEventListener('abort', waiter.onAbort);
  }

  async readLine(prompt = '', signal?: AbortSignal): Promise<string | null> {
    if (prompt) this.output.write(prompt);
    signal?.throwIfAborted();
    const queued = this.#queue.shift();
    if (queued !== undefined) return queued;
    if (this.#closed) return null;

    return new Promise<string | null>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
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
