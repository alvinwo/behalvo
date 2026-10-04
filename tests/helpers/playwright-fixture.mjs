import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export const binding = { profileId: 'p1-owned', connectionGeneration: 1, serviceGeneration: 'p1-service' };
export const origin = 'http://127.0.0.1:43117';
export function browserFixture() {
  const profile = mkdtempSync(join(realpathSync(tmpdir()), 'playwright_chromiumdev_profile-fixture-'));
  const proc = new EventEmitter(); Object.assign(proc, { pid: 987654, exitCode: null, signalCode: null,
    spawnargs: ['chromium', `--user-data-dir=${profile}`] });
  const server = new EventEmitter(); const browser = new EventEmitter(); const context = new EventEmitter(); const page = new EventEmitter(); const frame = {};
  let alive = true, closes = 0, kills = 0, connects = 0, launches = 0, attributes = 0;
  const fixture = { profile, proc, server, browser, context, page, frame, routes: [], options: undefined,
    contextOptions: undefined, reads: () => attributes, counts: () => ({ closes, kills, connects, launches }) };
  const finish = async () => { alive = false; proc.exitCode = 0; proc.emit('exit', 0, null);
    rmSync(profile, { recursive: true, force: true }); server.emit('close', 0, null); browser.emit('disconnected'); };
  Object.assign(server, { process: () => proc, wsEndpoint: () => 'ws://127.0.0.1:12345/CANARY-ENDPOINT',
    close: async () => { closes++; if (fixture.closeHook) return fixture.closeHook(); await finish(); },
    kill: async () => { kills++; if (fixture.killHook) return fixture.killHook(); await finish(); } });
  Object.assign(browser, { isConnected: () => alive, version: () => '154.0.8037.93',
    newContext: async options => { fixture.contextOptions = options; return context; } });
  Object.assign(context, { browser: () => browser, route: async (pattern, handler) => fixture.routes.push(handler),
    routeWebSocket: async (_, handler) => { fixture.ws = handler; }, newPage: async () => { context.emit('page', page); return page; },
    close: async () => {} });
  Object.assign(page, { url: () => `${origin}/`, isClosed: () => !alive, mainFrame: () => frame,
    context: () => context, goto: async () => {},
    locator: () => ({ count: async () => 1, getAttribute: async () => { attributes++; return fixture.readHook ? fixture.readHook() : 'login'; } }) });
  fixture.chromium = { executablePath: () => process.execPath,
    launchServer: async options => { launches++; fixture.options = options; return fixture.launchHook ? fixture.launchHook() : server; },
    connect: async () => { connects++; return browser; } };
  fixture.dispose = () => rmSync(profile, { recursive: true, force: true });
  return fixture;
}
