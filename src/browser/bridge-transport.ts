import { PassThrough, type Writable } from 'node:stream';
import {
  BridgeIpcReader,
  MAX_BRIDGE_PENDING_BYTES,
  parseBridgeFrameEnvelope,
  writeBridgeIpcMessage
} from './bridge-ipc.js';
import {
  MAX_NATIVE_MESSAGE_BYTES,
  NativeMessageReader,
  NativeMessagingTransport,
  writeNativeMessage
} from './native-host.js';
import type { BrowserSessionTransport } from './session.js';
import type { BrowserEpoch, BrowserRequest } from './types.js';

const CHANNEL_ERROR = 'Bridge IPC channel failed.';

export interface BridgeBrowserTransport extends BrowserSessionTransport {
  readonly completion: Promise<void>;
}

export interface BridgeBrowserTransportOptions {
  reader: BridgeIpcReader;
  output: Writable;
  channelId: string;
  closeChannel(): void;
}

class EnrolledBridgeBrowserTransport implements BridgeBrowserTransport {
  readonly completion: Promise<void>;
  readonly #fromBridge = new PassThrough({ highWaterMark: MAX_BRIDGE_PENDING_BYTES });
  readonly #toBridge = new PassThrough({ highWaterMark: MAX_BRIDGE_PENDING_BYTES });
  readonly #native = new NativeMessagingTransport(
    this.#fromBridge,
    this.#toBridge,
    MAX_NATIVE_MESSAGE_BYTES
  );
  readonly #nativeOutputReader = new NativeMessageReader(this.#toBridge, MAX_NATIVE_MESSAGE_BYTES);
  #resolveCompletion!: () => void;
  #rejectCompletion!: (error: Error) => void;
  #closing = false;
  #failed = false;
  #channelClosed = false;

  constructor(private readonly options: BridgeBrowserTransportOptions) {
    if (!(options.reader instanceof BridgeIpcReader) ||
        !options.output || typeof options.output.write !== 'function' ||
        !/^[A-Za-z0-9_-]{43}$/.test(options.channelId) ||
        typeof options.closeChannel !== 'function') {
      throw new Error(CHANNEL_ERROR);
    }
    this.completion = new Promise<void>((resolve, reject) => {
      this.#resolveCompletion = resolve;
      this.#rejectCompletion = reject;
    });
    // A coordinator may observe completion after construction; keep a rejection
    // from becoming process-global before that observer is attached.
    void this.completion.catch(() => {});

    this.#fromBridge.on('error', () => {});
    this.#toBridge.on('error', () => {});
    void this.#pumpInbound();
    void this.#pumpOutbound();
  }

  inspect(request: BrowserRequest): Promise<unknown> {
    this.#assertAvailable();
    return this.#native.inspect(request);
  }

  gesture(request: BrowserRequest, authorize: () => Promise<() => void>,
    authority: { deadline: number; signal: AbortSignal }): Promise<unknown> {
    this.#assertAvailable();
    return this.#native.gesture(request, authorize, authority);
  }

  revoke(epoch: BrowserEpoch, tabId: number): Promise<void> {
    this.#assertAvailable();
    return this.#native.revoke(epoch, tabId);
  }

  reconcileRevocation(epoch: BrowserEpoch, tabId: number): Promise<void> {
    this.#assertAvailable();
    return this.#native.reconcileRevocation(epoch, tabId);
  }

  async close(): Promise<void> {
    if (this.#closing) {
      await this.#native.close();
      return;
    }
    this.#closing = true;
    try {
      await this.#native.close();
    } finally {
      this.#fromBridge.end();
      this.#toBridge.end();
      this.#closeOuterChannel();
      if (!this.#failed) this.#resolveCompletion();
    }
  }

  async #pumpInbound(): Promise<void> {
    try {
      for (;;) {
        const raw = await this.options.reader.read();
        if (raw === undefined) {
          if (!this.#closing) this.#fail();
          return;
        }
        const envelope = parseBridgeFrameEnvelope(raw, this.options.channelId);
        await writeNativeMessage(this.#fromBridge, envelope.message, MAX_NATIVE_MESSAGE_BYTES);
      }
    } catch {
      if (!this.#closing) this.#fail();
    }
  }

  async #pumpOutbound(): Promise<void> {
    try {
      for (;;) {
        const message = await this.#nativeOutputReader.read();
        if (message === undefined) return;
        await writeBridgeIpcMessage(this.options.output, {
          bridgeVersion: 1,
          kind: 'browser.frame',
          channelId: this.options.channelId,
          message
        });
      }
    } catch {
      if (!this.#closing) this.#fail();
    }
  }

  #assertAvailable(): void {
    if (this.#failed || this.#closing) throw new Error(CHANNEL_ERROR);
  }

  #fail(): void {
    if (this.#failed || this.#closing) return;
    this.#failed = true;
    const error = new Error(CHANNEL_ERROR);
    this.#fromBridge.end();
    this.#toBridge.end();
    this.#closeOuterChannel();
    void this.#native.close().catch(() => {});
    this.#rejectCompletion(error);
  }

  #closeOuterChannel(): void {
    if (this.#channelClosed) return;
    this.#channelClosed = true;
    try { this.options.closeChannel(); } catch { /* fixed channel failure surface */ }
  }
}

export function createBridgeBrowserTransport(
  options: BridgeBrowserTransportOptions
): BridgeBrowserTransport {
  return new EnrolledBridgeBrowserTransport(options);
}
