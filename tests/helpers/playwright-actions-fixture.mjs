import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { PlaywrightActionsTransport } from '../../dist/browser/playwright-actions-transport.js';
import { SyntheticPortalState } from '../../dist/synthetic-portal/state.js';
export async function actionsFixture(options = {}) {
  const origin = 'http://127.0.0.1:43117', frame = {};
  const page = new EventEmitter(), context = new EventEmitter(), browser = new EventEmitter();
  const state = new SyntheticPortalState({ scenario: 'calendar_match' });
  let url = 'about:blank', handler, navigation, sequence = 0, closes = 0;
  const routes = [], posts = [], tokenBodies = [];
  const signal = new AbortController();
  const binding = { profileId: 'p2-unit', connectionGeneration: 1, serviceGeneration: 'p2-generation' };
  const epoch = randomBytes(32).toString('hex');
  const dispose = async () => {};
  const form = { dispose, async evaluate(_callback, args) {
    let body = new URLSearchParams({ ...args.command, _behalvo_dispatch: args.dispatchToken }).toString();
    tokenBodies.push(body); body = options.body ? options.body(body) : body;
    void send('POST', origin + '/gesture', body).catch(() => {});
  } };
  const button = { dispose, async evaluateHandle() { return { asElement: () => form }; } };
  const root = { dispose, async evaluate() { return options.snapshot ? options.snapshot(state.inspect()) : state.inspect(); },
    async $$(selector) { return [button]; } };
  Object.assign(browser, { isConnected: () => true });
  Object.assign(context, { browser: () => browser, route: async (_, callback) => { handler = callback; }, routeWebSocket: async () => {} });
  Object.assign(page, { context: () => context, mainFrame: () => frame, isClosed: () => false, url: () => url,
    locator: () => ({ count: async () => 1 }), $: async () => root,
    waitForNavigation: () => new Promise((resolve, reject) => { navigation = { resolve, reject }; }),
    async goto(target) { await send('GET', target); } });
  async function send(method, target, body) {
    const request = { method: () => method, url: () => target, frame: () => frame,
      isNavigationRequest: () => true, headers: () => ({ origin, 'content-type': 'application/x-www-form-urlencoded' }),
      postData: () => body, ...(options.request ?? {}) };
    const route = { request: () => request,
      async fetch(config) {
        if (config.maxRedirects !== 0 || config.maxRetries !== 0) throw new Error('unsafe fetch configuration');
        if (method === 'POST') { const fields = new URLSearchParams(body); fields.delete('_behalvo_dispatch');
          const command = Object.fromEntries(fields); posts.push(command.kind); state.gesture(command);
          if (options.afterDispatch) await options.afterDispatch(command); }
        return { url: () => target, status: () => options.status ?? 200,
          headers: () => ({ 'content-type': 'text/html; charset=utf-8', ...(options.headers ?? {}) }),
          body: async () => Buffer.from(options.html ?? '<main>synthetic</main>'), dispose,
        };
      },
      async fulfill() { url = target; page.emit('framenavigated', frame); navigation?.resolve(); },
      async abort() { navigation?.reject(new Error('blocked')); }
    };
    routes.push(route); await handler(route);
  }
  const transport = new PlaywrightActionsTransport({ ...binding, page, signal: signal.signal,
    runDeadline: Date.now() + 30000, close: async () => { closes++; await options.close?.(); } });
  await transport.initialize(Date.now() + 5000);
  const request = (kind = 'recognize', extra = {}) => ({ protocolVersion: 1, requestId: `request-${++sequence}`,
    ...binding, epoch, origin, tabId: 1, sequence, kind, ...extra });
  await transport.inspect(request());
  return { transport, request, signal, state, page, frame, routes, posts, tokenBodies, handler: () => handler,
    closeCount: () => closes,
    gesture: (command = { kind: 'calendar.first_page' }, authorize = async () => () => {}, authority = {}) =>
      transport.gesture(request('gesture', { expectedPageState: 'calendar', command }), authorize,
        { signal: signal.signal, deadline: Date.now() + 1000, ...authority }) };
}
