import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';
import { NativeMessageReader, NativeMessagingTransport, writeNativeMessage } from '../browser/native-host.js';
import type { BrowserSessionTransport } from '../browser/session.js';
import { SYNTHETIC_PORTAL_ORIGIN } from '../browser/types.js';
import type { SyntheticPortalServer } from './server.js';

const extensionId = 'a'.repeat(32);
const renderedPageStates = new Set(['login', 'security_question', 'group_roster', 'calendar',
  'booking_review', 'challenge', 'session_expired', 'forbidden', 'rate_limited', 'terms_changed', 'unknown',
  'confirmation', 'ambiguous_submission', 'appointment']);

interface ExtensionManifest {
  background: { service_worker: string };
  content_scripts: [{ matches: [string]; js: [string] }];
}

type ContentListener = (value: unknown, sender: { id: string }, respond: (value: unknown) => void) => void;

export interface CompiledSyntheticBrowserMetrics {
  readonly commands: readonly string[];
  readonly contentRequests: readonly string[];
  readonly nativeFrames: number;
  readonly navigationErrors: readonly string[];
  readonly compiledManifestContent: true;
  readonly compiledBackground: true;
  readonly framedNativeTransport: true;
}

export interface CompiledSyntheticBrowserHarness {
  readonly transport: BrowserSessionTransport;
  readonly tabId: number;
  readonly commands: readonly string[];
  readonly contentRequests: readonly string[];
  readonly navigationErrors: readonly string[];
  metrics(): CompiledSyntheticBrowserMetrics;
  refreshPageFromPortal(): Promise<void>;
  finish(): Promise<void>;
}

export interface CompiledSyntheticBrowserOptions {
  readonly transportTimeoutMs?: number;
  readonly transformHtml?: (html: string) => string;
  readonly beforeNavigate?: (kind: string, count: number, commands: readonly string[]) => void | Promise<void>;
  readonly beforeDestination?: (kind: string, count: number, commands: readonly string[]) => void | Promise<void>;
  readonly beforeContentRequest?: (request: unknown, rootDataset: Readonly<Record<string, string>>) => void;
}

function manifest(): ExtensionManifest {
  const value = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8')) as ExtensionManifest;
  if (!value.background?.service_worker || value.content_scripts?.length !== 1 ||
      value.content_scripts[0]?.matches?.length !== 1 || value.content_scripts[0].js?.length !== 1)
    throw new Error('Synthetic extension manifest is invalid.');
  if (value.content_scripts[0].matches[0] !== `${SYNTHETIC_PORTAL_ORIGIN}/*`)
    throw new Error('Synthetic extension origin does not match the trusted portal.');
  return value;
}

function compiledContent(document: unknown, origin: string, selected: ExtensionManifest): ContentListener {
  const source = readFileSync(new URL(`../../extension/${selected.content_scripts[0].js[0]}`, import.meta.url), 'utf8');
  let listener: ContentListener | undefined;
  new vm.Script(source, { filename: selected.content_scripts[0].js[0] }).runInContext(vm.createContext({
    TextEncoder, structuredClone, performance, crypto: webcrypto, document,
    location: { origin },
    chrome: { runtime: { id: extensionId, onMessage: { addListener(value: ContentListener) { listener = value; } } } }
  }));
  if (!listener) throw new Error('Compiled synthetic content script did not install its listener.');
  return listener;
}

function htmlAttributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) {
    const raw = match[1];
    if (!raw) continue;
    const key = raw.replace(/^data-/, '').replace(/-([a-z])/g, (_all, value: string) => value.toUpperCase());
    result[key] = (match[2] ?? '').replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
  }
  return result;
}

interface FakeElement {
  dataset: Record<string, string>;
  value?: string;
  click(): void;
}

function browserDocument(html: string, navigate: (fields: Record<string, string>) => Promise<void>): unknown {
  const main = html.match(/<main ([^>]*)>/);
  if (!main?.[1]) throw new Error('Synthetic portal main element is missing.');
  const root: FakeElement = { dataset: htmlAttributes(main[1]), click() {} };
  const elements: FakeElement[] = [];
  for (const match of html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)) {
    const form = match[1] ?? ''; const fields: Record<string, string> = {};
    for (const input of form.matchAll(/<input ([^>]*)>/g)) {
      const attributes = htmlAttributes(input[1] ?? ''); const name = attributes.name;
      if (!name) continue;
      fields[name] = attributes.value ?? '';
      if (attributes.behalvoIntentInput !== undefined) {
        const element: FakeElement = { dataset: attributes, click() {},
          get value() { return fields[name] ?? ''; }, set value(value: string) { fields[name] = value; } };
        elements.push(element);
      }
    }
    const button = form.match(/<button [^>]*data-behalvo-gesture="[^"]+"[^>]*>/);
    if (button?.[0]) elements.push({ dataset: htmlAttributes(button[0]), click() { void navigate(fields); } });
  }
  const review = html.match(/<div ([^>]*data-behalvo-review-slot[^>]*)>/);
  if (review?.[1]) elements.push({ dataset: { ...htmlAttributes(review[1]), behalvoReviewSlot: '' }, click() {} });
  const matches = (element: FakeElement, selector: string): boolean => {
    for (const match of selector.matchAll(/\[data-([a-z0-9-]+)(?:="([^"]*)")?\]/g)) {
      const key = (match[1] ?? '').replace(/-([a-z])/g, (_all, value: string) => value.toUpperCase());
      if (!(key in element.dataset) || (match[2] !== undefined && element.dataset[key] !== match[2])) return false;
    }
    return true;
  };
  return { root, querySelector(selector: string) {
    if (selector === '[data-behalvo-page-state]') return root;
    return elements.find(element => matches(element, selector)) ?? null;
  }, querySelectorAll(selector: string) { return elements.filter(element => matches(element, selector)); } };
}

export async function createCompiledSyntheticBrowserHarness(server: SyntheticPortalServer,
  options: CompiledSyntheticBrowserOptions = {}): Promise<CompiledSyntheticBrowserHarness> {
  assert.equal(server.origin, SYNTHETIC_PORTAL_ORIGIN);
  const selected = manifest();
  const backgroundUrl = new URL(`../../extension/${selected.background.service_worker}`, import.meta.url);
  const background = await import(backgroundUrl.href) as {
    createNativeRequestBoundary(send: (tabId: number, value: unknown) => Promise<unknown>):
      (value: unknown) => Promise<unknown>;
  };
  if (typeof background.createNativeRequestBoundary !== 'function')
    throw new Error('Compiled synthetic background script is invalid.');

  let listener!: ContentListener;
  let currentRootDataset: Readonly<Record<string, string>> = {};
  let closed = false; let navigationCount = 0; let nativeFrames = 0;
  const commands: string[] = []; const contentRequests: string[] = []; const navigationErrors: string[] = [];
  const navigations = new Set<Promise<void>>();
  const fromExtension = new PassThrough(); const toExtension = new PassThrough();

  const navigationDestination = async (fields: Record<string, string>, kind: string, count: number): Promise<string> => {
    const submitted = await fetch(`${server.origin}/gesture`, { method: 'POST', redirect: 'manual',
      headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields) });
    const location = submitted.headers.get('location');
    if (submitted.status !== 303 || !location) throw new Error(`Synthetic navigation failed: ${submitted.status}`);
    const destinationUrl = new URL(location, server.origin);
    if (destinationUrl.origin !== server.origin) throw new Error('Synthetic navigation left the allowed origin.');
    await options.beforeDestination?.(kind, count, commands);
    const response = await fetch(destinationUrl, { redirect: 'manual' });
    if (new URL(response.url).origin !== server.origin ||
        !response.headers.get('content-type')?.toLowerCase().startsWith('text/html'))
      throw new Error('Synthetic navigation destination was not same-origin HTML.');
    const html = await response.text(); const main = html.match(/<main ([^>]*)>/);
    const state = main?.[1] ? htmlAttributes(main[1]).behalvoPageState : undefined;
    const expectedStatus = state === 'forbidden' ? 403 : state === 'rate_limited' ? 429 : 200;
    if (!state || !renderedPageStates.has(state) || response.status !== expectedStatus)
      throw new Error(`Synthetic navigation destination was invalid: ${response.status}`);
    return html;
  };
  const install = (html: string): void => {
    const transformed = options.transformHtml ? options.transformHtml(html) : html;
    const document = browserDocument(transformed, fields => {
      const kind = fields.kind ?? 'unknown'; commands.push(kind); navigationCount++;
      const navigation = Promise.resolve(options.beforeNavigate?.(kind, navigationCount, commands))
        .then(() => navigationDestination(fields, kind, navigationCount)).then(install);
      navigations.add(navigation);
      void navigation.catch(error => navigationErrors.push(String(error)))
        .finally(() => navigations.delete(navigation)).catch(() => {});
      return navigation;
    }) as { root: { dataset: Record<string, string> } };
    currentRootDataset = document.root.dataset;
    listener = compiledContent(document, server.origin, selected);
  };
  const initial = await fetch(`${server.origin}/`);
  const initialHtml = await initial.text();
  const initialMain = initialHtml.match(/<main ([^>]*)>/);
  const initialState = initialMain?.[1] ? htmlAttributes(initialMain[1]).behalvoPageState : undefined;
  const initialStatus = initialState === 'forbidden' ? 403 : initialState === 'rate_limited' ? 429 : 200;
  if (!initialState || !renderedPageStates.has(initialState) || initial.status !== initialStatus)
    throw new Error('Synthetic portal initial page is unavailable.');
  install(initialHtml);

  const boundary = background.createNativeRequestBoundary((tabId, value) => new Promise((resolve, reject) => {
    if (tabId !== 7) return reject(new Error('Synthetic tab binding is invalid.'));
    const kind = value && typeof value === 'object' && !Array.isArray(value)
      ? String((value as Record<string, unknown>).kind) : 'invalid';
    contentRequests.push(kind);
    try {
      options.beforeContentRequest?.(value, currentRootDataset);
      listener(value, { id: extensionId }, resolve);
    }
    catch (error) { reject(error); }
  }));
  const reader = new NativeMessageReader(toExtension);
  let writes = Promise.resolve();
  const pump = (async () => {
    while (!closed) {
      const message = await reader.read();
      if (message === undefined) return;
      nativeFrames++;
      void boundary(message).then(response => {
        writes = writes.then(() => writeNativeMessage(fromExtension, response));
        return writes;
      }).catch(() => {});
    }
  })();
  void pump.catch(() => {});
  const transport = new NativeMessagingTransport(fromExtension, toExtension, undefined,
    options.transportTimeoutMs ?? 1_000);
  const finish = async (): Promise<void> => {
    if (closed) return;
    await Promise.allSettled([...navigations]);
    closed = true; fromExtension.end(); toExtension.end(); await writes;
  };
  return { transport, tabId: 7, commands, contentRequests, navigationErrors,
    metrics: () => ({ commands: [...commands], contentRequests: [...contentRequests], nativeFrames,
      navigationErrors: [...navigationErrors], compiledManifestContent: true,
      compiledBackground: true, framedNativeTransport: true }),
    async refreshPageFromPortal() {
      const response = await fetch(`${server.origin}/`, { redirect: 'manual' });
      if (response.status !== 200 || new URL(response.url).origin !== server.origin ||
          !response.headers.get('content-type')?.toLowerCase().startsWith('text/html'))
        throw new Error('Synthetic human page refresh failed.');
      install(await response.text());
    }, finish };
}
