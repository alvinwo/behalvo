import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
    chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync,
    symlinkSync, unlinkSync, writeFileSync
} from 'node:fs';
import { request } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { connect } from 'node:net';
import { join } from 'node:path';
import { openOwnerControl, OperationRegistry, OperationService, Operator, SqliteStore } from '../dist/index.js';
import { startOwnerControlServer } from '../dist/control/http-server.js';
import { createOwnerControlFixture } from './owner-control-fixture.mjs';
import { requestControl } from './owner-control-http-helpers.mjs';

const ASSETS = {
    html: '<!doctype html><title>Control</title>',
    javascript: "'use strict';",
    css: 'body { color: black; }'
};
const SECURITY_HEADERS = {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer'
};

async function start(t, options = {}) {
    const fixture = await createOwnerControlFixture(t);
    const app = openOwnerControl({ dbPath: fixture.dbPath, workspaceId: fixture.workspaceId,
        ...(options.clock ? { clock: options.clock } : {}) });
    let server;
    try {
        server = await startOwnerControlServer({ app,
            bootstrapDirectory: join(fixture.directory, 'bootstrap'), assets: ASSETS });
    } catch (error) {
        app.close();
        throw error;
    }
    t.after(async () => { await server.close(); app.close(); });
    return { fixture, app, server };
}

function assertSecurityHeaders(response) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(response.headers[name], value);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
}

async function pair(server) {
    const bootstrap = JSON.parse(readFileSync(server.bootstrapPath, 'utf8'));
    const response = await requestControl(server.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {});
    assert.equal(response.status, 200);
    return { bootstrap, session: response.body };
}

function customRequest(origin, method, path, { headers = {}, body } = {}) {
    const url = new URL(origin);
    return new Promise((resolve, reject) => {
        const outgoing = request({ hostname: url.hostname, port: url.port, method, path,
            headers: { Connection: 'close', ...headers }, setHost: false }, incoming => {
            const chunks = [];
            incoming.on('data', chunk => chunks.push(chunk));
            incoming.once('error', reject);
            incoming.once('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed = text;
                if (String(incoming.headers['content-type'] ?? '').startsWith('application/json') && text)
                    parsed = JSON.parse(text);
                resolve({ status: incoming.statusCode, headers: incoming.headers, body: parsed });
            });
        });
        outgoing.once('error', reject);
        if (body !== undefined) outgoing.write(body);
        outgoing.end();
    });
}

function rawRequest(origin, bytes) {
    const url = new URL(origin);
    return new Promise((resolve, reject) => {
        const socket = connect({ host: url.hostname, port: Number(url.port) });
        const chunks = [];
        socket.once('connect', () => socket.end(bytes));
        socket.on('data', chunk => chunks.push(chunk));
        socket.once('error', reject);
        socket.once('close', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const [head = '', body = ''] = raw.split('\r\n\r\n', 2);
            const lines = head.split('\r\n');
            const status = Number(lines[0]?.split(' ')[1]);
            const headers = {};
            for (const line of lines.slice(1)) {
                const separator = line.indexOf(':');
                if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
            }
            let parsed = body;
            if (headers['content-type']?.startsWith('application/json') && body) parsed = JSON.parse(body);
            resolve({ status, headers, body: parsed, raw });
        });
    });
}

function heldRawRequest(origin, bytes, maximumWait = 13_000) {
    const url = new URL(origin);
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const socket = connect({ host: url.hostname, port: Number(url.port) });
        const chunks = [];
        const timeout = setTimeout(() => {
            socket.destroy(); reject(new Error('Timed out waiting for the control server to close the request.'));
        }, maximumWait);
        socket.once('connect', () => socket.write(bytes));
        socket.on('data', chunk => chunks.push(chunk));
        socket.once('error', error => { clearTimeout(timeout); reject(error); });
        socket.once('close', () => {
            clearTimeout(timeout);
            const raw = Buffer.concat(chunks).toString('utf8');
            const [head = '', body = ''] = raw.split('\r\n\r\n', 2);
            const lines = head.split('\r\n');
            const headers = {};
            for (const line of lines.slice(1)) {
                const separator = line.indexOf(':');
                if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
            }
            resolve({ status: Number(lines[0]?.split(' ')[1]), headers, elapsed: Date.now() - started,
                body: headers['content-type']?.startsWith('application/json') ? JSON.parse(body) : body });
        });
    });
}

test('actual loopback bootstrap is private, absent from responses, single use, and authorizes one session', async t => {
    const { fixture, server } = await start(t);
    const anonymous = await requestControl(server.origin, 'GET', '/api/actions');
    assert.equal(anonymous.status, 401);
    assert.deepEqual(anonymous.body, { error: 'unauthenticated' });
    assert.doesNotMatch(JSON.stringify(anonymous), /Update synthetic contact|owner-control@example\.test/);
    assertSecurityHeaders(anonymous);

    assert.deepEqual(Object.keys(server).sort(), ['bootstrapPath', 'close', 'origin']);
    assert.equal(new URL(server.origin).hostname, '127.0.0.1');
    assert.equal(statSync(join(fixture.directory, 'bootstrap')).mode & 0o777, 0o700);
    assert.equal(statSync(server.bootstrapPath).mode & 0o777, 0o600);
    assert.equal(statSync(server.bootstrapPath).uid, process.geteuid());
    const bootstrap = JSON.parse(readFileSync(server.bootstrapPath, 'utf8'));
    assert.deepEqual(Object.keys(bootstrap).sort(), ['expiresAt', 'origin', 'token', 'version']);
    assert.equal(bootstrap.origin, server.origin);
    assert.equal(bootstrap.version, 1);
    assert.match(bootstrap.token, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(JSON.stringify(anonymous), new RegExp(bootstrap.token));

    const login = await requestControl(server.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {});
    assert.equal(login.status, 200);
    assert.match(login.body.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(existsSync(server.bootstrapPath), false);
    assert.equal((await requestControl(server.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {})).status, 401);
    const page = await requestControl(server.origin, 'GET', '/api/actions', login.body.token);
    assert.equal(page.status, 200);
    assert.equal(page.body.items.length, 2);
    assert.equal(JSON.stringify(page).includes(bootstrap.token), false);
});

test('bootstrap expiry, logout, shutdown, and restart revoke their respective credentials', async t => {
    let now = Date.now();
    const first = await start(t, { clock: () => now });
    const bootstrap = JSON.parse(readFileSync(first.server.bootstrapPath, 'utf8'));
    now += 5 * 60_000;
    const expired = await requestControl(first.server.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {});
    assert.equal(expired.status, 401);
    assert.equal(existsSync(first.server.bootstrapPath), false);

    const secondFixture = await createOwnerControlFixture(t);
    const secondApp = openOwnerControl({ dbPath: secondFixture.dbPath, workspaceId: secondFixture.workspaceId });
    const secondServer = await startOwnerControlServer({ app: secondApp,
        bootstrapDirectory: join(secondFixture.directory, 'bootstrap'), assets: ASSETS });
    const paired = await pair(secondServer);
    const logout = await requestControl(secondServer.origin, 'POST', '/api/session/logout', paired.session.token, {});
    assert.equal(logout.status, 204); assert.equal(logout.body, '');
    assert.equal((await requestControl(secondServer.origin, 'GET', '/api/actions', paired.session.token)).status, 401);
    await secondServer.close(); await secondServer.close(); secondApp.close();

    const restarted = openOwnerControl({ dbPath: secondFixture.dbPath, workspaceId: secondFixture.workspaceId });
    const restartedServer = await startOwnerControlServer({ app: restarted,
        bootstrapDirectory: join(secondFixture.directory, 'restarted-bootstrap'), assets: ASSETS });
    t.after(async () => { await restartedServer.close(); restarted.close(); });
    assert.equal((await requestControl(restartedServer.origin, 'GET', '/api/actions', paired.session.token)).status, 401);
});

test('bootstrap publication rejects collisions and unsafe identities, closes failed startup, and removes only its inode', async t => {
    for (const kind of ['collision', 'unsafe-directory', 'symlink-directory', 'symlink-leaf']) {
        await t.test(kind, async t => {
            const fixture = await createOwnerControlFixture(t);
            const app = openOwnerControl({ dbPath: fixture.dbPath, workspaceId: fixture.workspaceId });
            t.after(() => app.close());
            const directory = join(fixture.directory, 'bootstrap');
            const destination = join(directory, `${app.sessions.instanceId}.behalvo-bootstrap`);
            if (kind === 'unsafe-directory') { mkdirSync(directory, { mode: 0o755 }); chmodSync(directory, 0o755); }
            else if (kind === 'symlink-directory') symlinkSync(fixture.directory, directory);
            else {
                mkdirSync(directory, { mode: 0o700 });
                if (kind === 'collision') writeFileSync(destination, 'preserve', { mode: 0o600 });
                else { const target = join(fixture.directory, 'target'); writeFileSync(target, 'preserve'); symlinkSync(target, destination); }
            }
            await assert.rejects(startOwnerControlServer({ app, bootstrapDirectory: directory, assets: ASSETS }),
                error => error?.message === 'Owner control server startup failed.');
            if (kind === 'collision') assert.equal(readFileSync(destination, 'utf8'), 'preserve');
            assert.throws(() => app.sessions.issueBootstrap('http://127.0.0.1:1'));
        });
    }

    const { server } = await start(t);
    const bootstrap = JSON.parse(readFileSync(server.bootstrapPath, 'utf8'));
    const original = lstatSync(server.bootstrapPath);
    const oldPath = `${server.bootstrapPath}.old`;
    renameSync(server.bootstrapPath, oldPath);
    writeFileSync(server.bootstrapPath, 'replacement', { mode: 0o600 });
    assert.notEqual(lstatSync(server.bootstrapPath).ino, original.ino);
    const login = await requestControl(server.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {});
    assert.equal(login.status, 200);
    assert.equal((await requestControl(server.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {})).status, 401);
    await server.close();
    assert.equal(readFileSync(server.bootstrapPath, 'utf8'), 'replacement');
    unlinkSync(server.bootstrapPath); unlinkSync(oldPath);

    const shutdown = await start(t);
    assert.equal(existsSync(shutdown.server.bootstrapPath), true);
    await shutdown.server.close();
    assert.equal(existsSync(shutdown.server.bootstrapPath), false);
});

test('a post-link bootstrap publication failure removes the owned partial file and revokes its authority', async t => {
    const fixture = await createOwnerControlFixture(t);
    const app = openOwnerControl({ dbPath: fixture.dbPath, workspaceId: fixture.workspaceId });
    t.after(() => app.close());
    const directory = join(fixture.directory, 'bootstrap');
    const destination = join(directory, `${app.sessions.instanceId}.behalvo-bootstrap`);
    const originalFsync = fs.fsyncSync;
    const canary = 'post-link-fsync-CANARY';
    let fsyncCalls = 0;
    fs.fsyncSync = descriptor => {
        fsyncCalls++;
        if (fsyncCalls === 3) throw Object.assign(new Error(canary), { code: 'EIO' });
        return originalFsync(descriptor);
    };
    syncBuiltinESMExports();
    let failure;
    try {
        await startOwnerControlServer({ app, bootstrapDirectory: directory, assets: ASSETS });
    } catch (error) {
        failure = error;
    } finally {
        fs.fsyncSync = originalFsync;
        syncBuiltinESMExports();
    }
    assert.equal(fsyncCalls, 3);
    assert.equal(failure?.message, 'Owner control server startup failed.');
    assert.equal(failure?.message.includes(canary), false);
    assert.equal(existsSync(destination), false);
    assert.throws(() => app.sessions.issueBootstrap('http://127.0.0.1:1'), error => error?.code === 'unavailable');
});

test('owner control refuses a pre-existing synthetic-looking database without a bound local mode', async t => {
    const fixture = await createOwnerControlFixture(t);
    const unbound = join(fixture.directory, 'unbound.db');
    const store = new SqliteStore(unbound);
    store.createWorkspace('owner-control-demo', 'owner');
    store.close();
    assert.throws(() => openOwnerControl({ dbPath: unbound, workspaceId: 'owner-control-demo' }),
        /existing synthetic database/i);
    const check = new SqliteStore(unbound, { readOnly: true });
    assert.equal(check.localMode(), undefined);
    check.close();
});

test('static assets are fixed, header-hardened, query-free, and carry no workspace data', async t => {
    const { server } = await start(t);
    for (const [path, body, type] of [
        ['/', ASSETS.html, 'text/html; charset=utf-8'],
        ['/app.js', ASSETS.javascript, 'text/javascript; charset=utf-8'],
        ['/styles.css', ASSETS.css, 'text/css; charset=utf-8']
    ]) {
        const response = await requestControl(server.origin, 'GET', path);
        assert.equal(response.status, 200); assert.equal(response.body, body);
        assert.equal(response.headers['content-type'], type); assertSecurityHeaders(response);
        assert.doesNotMatch(response.body, /owner-control-demo|Update synthetic contact/);
    }
    const query = await requestControl(server.origin, 'GET', '/?unexpected=1');
    assert.equal(query.status, 400); assert.deepEqual(query.body, { error: 'invalid_request' });
});

test('malformed and wrong-origin bootstrap requests do not spend the credential attempt allowance', async t => {
    const malformed = await start(t);
    const malformedBootstrap = JSON.parse(readFileSync(malformed.server.bootstrapPath, 'utf8'));
    for (let index = 0; index < 12; index++) {
        const response = await customRequest(malformed.server.origin, 'POST', '/api/session/bootstrap', {
            headers: { Host: new URL(malformed.server.origin).host, Origin: malformed.server.origin,
                Authorization: 'Bearer malformed', 'Content-Type': 'application/json', 'Content-Length': '2' }, body: '{}'
        });
        assert.equal(response.status, 401);
    }
    assert.equal((await requestControl(malformed.server.origin, 'POST', '/api/session/bootstrap', malformedBootstrap.token, {})).status, 200);

    const wrongOrigin = await start(t);
    const originBootstrap = JSON.parse(readFileSync(wrongOrigin.server.bootstrapPath, 'utf8'));
    for (let index = 0; index < 12; index++) {
        const response = await customRequest(wrongOrigin.server.origin, 'POST', '/api/session/bootstrap', {
            headers: { Host: new URL(wrongOrigin.server.origin).host, Origin: 'http://127.0.0.1:1',
                Authorization: `Bearer ${originBootstrap.token}`, 'Content-Type': 'application/json', 'Content-Length': '2' }, body: '{}'
        });
        assert.equal(response.status, 403);
    }
    assert.equal((await requestControl(wrongOrigin.server.origin, 'POST', '/api/session/bootstrap', originBootstrap.token, {})).status, 200);
});

test('ten well-formed bad bootstrap credentials exhaust exchange attempts without leaking the secret', async t => {
    const { server } = await start(t);
    const bootstrap = JSON.parse(readFileSync(server.bootstrapPath, 'utf8'));
    for (let index = 0; index < 10; index++) {
        const token = Buffer.alloc(32, index + 1).toString('base64url');
        const response = await requestControl(server.origin, 'POST', '/api/session/bootstrap', token, {});
        assert.equal(response.status, 401); assert.doesNotMatch(JSON.stringify(response), new RegExp(bootstrap.token));
    }
    const limited = await requestControl(server.origin, 'POST', '/api/session/bootstrap', bootstrap.token, {});
    assert.equal(limited.status, 429); assert.deepEqual(limited.body, { error: 'rate_limited' });
    assertSecurityHeaders(limited);
});

async function admissionContext(t) {
    const context = await start(t);
    const { session } = await pair(context.server);
    const review = await requestControl(context.server.origin, 'POST',
        `/api/actions/${context.fixture.approveActionId}/review`, session.token, {});
    assert.equal(review.status, 200);
    const decision = { reviewToken: review.body.reviewToken, digest: review.body.action.digest };
    return { ...context, token: session.token, review: review.body, decision };
}

function snapshot(fixture) {
    const store = new SqliteStore(fixture.dbPath, { readOnly: true });
    try {
        const state = store.state(fixture.workspaceId);
        return { version: state.version, status: state.actions[fixture.approveActionId].status,
            journalLength: store.journal(fixture.workspaceId).length };
    } finally { store.close(); }
}

function mutationRequest(context, overrides = {}) {
    const body = overrides.body ?? JSON.stringify(context.decision);
    const url = new URL(context.server.origin);
    const headers = { Host: url.host, Origin: context.server.origin,
        Authorization: `Bearer ${context.token}`, 'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)), ...(overrides.headers ?? {}) };
    for (const [name, value] of Object.entries(headers)) if (value === undefined) delete headers[name];
    return customRequest(context.server.origin, overrides.method ?? 'POST',
        overrides.path ?? `/api/actions/${context.fixture.approveActionId}/approve`, { headers, body });
}

test('transport admission rejects forged mutation shapes before journal state can change', async t => {
    const cases = [
        ['foreign Host', { headers: { Host: '127.0.0.1:1' } }, 400],
        ['wrong Origin', { headers: { Origin: 'http://127.0.0.1:1' } }, 403],
        ['missing POST Origin', { headers: { Origin: undefined } }, 400],
        ['cross-site Fetch Metadata', { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403],
        ['same-site Fetch Metadata', { headers: { 'Sec-Fetch-Site': 'same-site' } }, 403],
        ['Forwarded', { headers: { Forwarded: 'for=127.0.0.1' } }, 400],
        ['X-Forwarded-For', { headers: { 'X-Forwarded-For': '127.0.0.1' } }, 400],
        ['unknown method', { method: 'PUT' }, 405],
        ['unknown route', { path: '/api/actions/execute' }, 404],
        ['unknown query', { path: '/api/actions/action/approve?workspaceId=owner-control-demo' }, 400],
        ['unknown body field', { body: JSON.stringify({ reviewToken: 'x'.repeat(43), digest: '0'.repeat(64), ownerId: 'owner' }) }, 400],
        ['array JSON', { body: '[]' }, 400],
        ['null JSON', { body: 'null' }, 400],
        ['trailing JSON', { body: '{} trailing' }, 400],
        ['wrong content type', { headers: { 'Content-Type': 'text/plain' } }, 400],
        ['content encoding', { headers: { 'Content-Encoding': 'gzip' } }, 400],
        ['oversized body', { body: JSON.stringify({ padding: 'x'.repeat(4096) }) }, 413],
        ['oversized target', { path: `/api/actions/${'x'.repeat(2050)}/approve` }, 400]
    ];
    for (const [name, overrides, status] of cases) {
        await t.test(name, async t => {
            const context = await admissionContext(t);
            const before = snapshot(context.fixture);
            const response = await mutationRequest(context, overrides);
            assert.equal(response.status, status);
            assert.deepEqual(response.body, { error: status === 404 ? 'not_found' :
                status === 403 ? 'forbidden' : 'invalid_request' });
            assertSecurityHeaders(response);
            assert.deepEqual(snapshot(context.fixture), before);
        });
    }
});

test('missing GET Origin is permitted with bearer while foreign Host, Origin, and Fetch Metadata are rejected', async t => {
    const { server, token } = await admissionContext(t);
    const host = new URL(server.origin).host;
    const allowed = await customRequest(server.origin, 'GET', '/api/actions', {
        headers: { Host: host, Authorization: `Bearer ${token}` }
    });
    assert.equal(allowed.status, 200); assert.equal(allowed.body.items.length, 2);
    for (const headers of [
        { Host: '127.0.0.1:1', Authorization: `Bearer ${token}` },
        { Host: host, Origin: 'http://127.0.0.1:1', Authorization: `Bearer ${token}` },
        { Host: host, Authorization: `Bearer ${token}`, 'Sec-Fetch-Site': 'cross-site' }
    ]) {
        const response = await customRequest(server.origin, 'GET', '/api/actions', { headers });
        assert.equal(response.status, headers.Origin || headers['Sec-Fetch-Site'] ? 403 : 400);
    }
});

test('action listing accepts one cursor and rejects duplicate cursors, cookies, and body credentials', async t => {
    const context = await admissionContext(t);
    const firstId = (await requestControl(context.server.origin, 'GET', '/api/actions', context.token)).body.items[0].actionId;
    const after = await requestControl(context.server.origin, 'GET', `/api/actions?after=${encodeURIComponent(firstId)}`, context.token);
    assert.equal(after.status, 200); assert.equal(after.body.items.length, 1);
    assert.equal((await requestControl(context.server.origin, 'GET',
        `/api/actions?after=${encodeURIComponent(firstId)}&after=${encodeURIComponent(firstId)}`, context.token)).status, 400);
    const host = new URL(context.server.origin).host;
    const ambient = await customRequest(context.server.origin, 'GET', '/api/actions', {
        headers: { Host: host, Origin: context.server.origin, Cookie: `token=${context.token}` }
    });
    assert.equal(ambient.status, 401);
    const bodyCredential = JSON.stringify({ token: context.token });
    const bodyOnly = await customRequest(context.server.origin, 'POST', '/api/session/logout', {
        headers: { Host: host, Origin: context.server.origin, 'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(bodyCredential)) }, body: bodyCredential
    });
    assert.equal(bodyOnly.status, 401);
});

test('raw HTTP duplicate critical headers, missing Host, absolute targets, and oversized headers fail safely', async t => {
    const context = await admissionContext(t);
    const host = new URL(context.server.origin).host;
    const path = `/api/actions/${context.fixture.approveActionId}/approve`;
    const body = JSON.stringify(context.decision);
    const base = [`POST ${path} HTTP/1.1`, `Host: ${host}`, `Origin: ${context.server.origin}`,
        `Authorization: Bearer ${context.token}`, 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`];
    const duplicateLines = {
        Host: `Host: ${host}`,
        Origin: `Origin: ${context.server.origin}`,
        Authorization: `Authorization: Bearer ${context.token}`,
        'Content-Length': `Content-Length: ${Buffer.byteLength(body)}`,
        'Transfer-Encoding': 'Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked'
    };
    for (const [name, line] of Object.entries(duplicateLines)) {
        const lines = [...base];
        if (name === 'Transfer-Encoding') {
            const index = lines.findIndex(value => value.startsWith('Content-Length:')); lines.splice(index, 1);
        }
        lines.push(line, 'Connection: close', '', name === 'Transfer-Encoding' ? `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n` : body);
        const response = await rawRequest(context.server.origin, lines.join('\r\n'));
        assert.equal(response.status, 400, name); assert.deepEqual(response.body, { error: 'invalid_request' }, name);
        assertSecurityHeaders(response);
    }
    const rawCases = [
        ['missing Host', `GET /api/actions HTTP/1.1\r\nAuthorization: Bearer ${context.token}\r\nConnection: close\r\n\r\n`],
        ['absolute target', `GET http://${host}/api/actions HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${context.token}\r\nConnection: close\r\n\r\n`],
        ['oversized header', `GET /api/actions HTTP/1.1\r\nHost: ${host}\r\nX-Fill: ${'x'.repeat(17 * 1024)}\r\nConnection: close\r\n\r\n`]
    ];
    for (const [name, bytes] of rawCases) {
        const response = await rawRequest(context.server.origin, bytes);
        assert.equal(response.status, 400, name);
        assert.deepEqual(response.body, { error: 'invalid_request' }, `${name}: ${response.raw}`);
        assertSecurityHeaders(response);
    }
});

test('parser, expectation, protocol-upgrade, and receipt-timeout paths return bounded hardened failures',
    { timeout: 15_000 }, async t => {
        const { server } = await start(t);
        const host = new URL(server.origin).host;
        for (const requestBytes of [
            `POST /api/session/bootstrap HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${server.origin}\r\nExpect: 100-continue\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n`,
            `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
            'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'
        ]) {
            const response = await rawRequest(server.origin, requestBytes);
            assert.equal(response.status, 400); assert.deepEqual(response.body, { error: 'invalid_request' });
            assertSecurityHeaders(response);
        }
        const [headerTimeout, requestTimeout] = await Promise.all([
            heldRawRequest(server.origin, 'GET / HTTP/1.1\r\nX-Incomplete:'),
            heldRawRequest(server.origin,
                `POST /api/session/bootstrap HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${server.origin}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{`)
        ]);
        for (const response of [headerTimeout, requestTimeout]) {
            assert.equal(response.status, 400); assert.deepEqual(response.body, { error: 'invalid_request' });
            assertSecurityHeaders(response);
        }
        assert.ok(headerTimeout.elapsed >= 4_000 && headerTimeout.elapsed < 8_000, headerTimeout.elapsed);
        assert.ok(requestTimeout.elapsed >= 9_000 && requestTimeout.elapsed < 13_000, requestTimeout.elapsed);
});

test('shutdown stops admission and settles an idle loopback connection', async t => {
    const { server } = await start(t);
    const url = new URL(server.origin);
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const closed = new Promise(resolve => socket.once('close', resolve));
    await server.close();
    await closed;
    await assert.rejects(requestControl(server.origin, 'GET', '/'));
});

test('actual HTTP review, approval, replay rejection, cancellation, and logout preserve exact domain semantics', async t => {
    let now = Date.parse('2026-09-14T12:00:00.000Z');
    const { fixture, server } = await start(t, { clock: () => now });
    const { bootstrap, session } = await pair(server);
    const listed = await requestControl(server.origin, 'GET', '/api/actions', session.token);
    assert.deepEqual(listed.body.items.map(item => item.actionId), [...listed.body.items.map(item => item.actionId)].sort());
    const reviewResponse = await requestControl(server.origin, 'POST',
        `/api/actions/${fixture.approveActionId}/review`, session.token, {});
    assert.equal(reviewResponse.status, 200);
    const review = reviewResponse.body;
    assert.deepEqual(review.command, {
        kind: 'operation.execute', operationId: 'contact.update', operationVersion: '1',
        connectionId: 'synthetic-account', provider: 'synthetic-accounts', subject: 'synthetic-person',
        connectionGeneration: 1, resourceId: 'contact-profile', arguments: { email: 'owner-control@example.test' },
        affectedResourceIds: ['contact-profile'], precondition: review.command.precondition,
        expectedResult: { kind: 'contact-profile', email: 'owner-control@example.test', locale: 'en-US' },
        subjectRevision: 0, requestFingerprint: review.command.requestFingerprint
    });
    assert.deepEqual(Object.keys(review.command.precondition).sort(), ['observedAt', 'providerVersion', 'source', 'state']);
    assert.equal(review.approvalExpiresAt, '2026-09-14T12:10:00.000Z');
    assert.equal(review.reviewExpiresAt, '2026-09-14T12:02:00.000Z');
    const approvalInput = { reviewToken: review.reviewToken, digest: review.action.digest };
    now += 30_000;
    const approved = await requestControl(server.origin, 'POST',
        `/api/actions/${fixture.approveActionId}/approve`, session.token, approvalInput);
    assert.equal(approved.status, 200); assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.approvalExpiresAt, '2026-09-14T12:10:00.000Z');
    assert.equal((await requestControl(server.origin, 'POST',
        `/api/actions/${fixture.approveActionId}/approve`, session.token, approvalInput)).status, 409);

    const cancelReview = (await requestControl(server.origin, 'POST',
        `/api/actions/${fixture.cancelActionId}/review`, session.token, {})).body;
    const crossAction = await requestControl(server.origin, 'POST',
        `/api/actions/${fixture.approveActionId}/cancel`, session.token,
        { reviewToken: cancelReview.reviewToken, digest: cancelReview.action.digest });
    assert.equal(crossAction.status, 409);
    assertSecurityHeaders(crossAction);
    const cancelled = await requestControl(server.origin, 'POST',
        `/api/actions/${fixture.cancelActionId}/cancel`, session.token,
        { reviewToken: cancelReview.reviewToken, digest: cancelReview.action.digest });
    assert.equal(cancelled.status, 200); assert.equal(cancelled.body.status, 'cancelled');
    assert.equal((await requestControl(server.origin, 'POST', '/api/session/logout', session.token, {})).status, 204);
    assert.equal((await requestControl(server.origin, 'GET', '/api/actions', session.token)).status, 401);

    const store = new SqliteStore(fixture.dbPath, { readOnly: true });
    const records = store.journal(fixture.workspaceId); store.close();
    assert.equal(records.some(record => record.event.type === 'action.started'), false);
    assert.equal(records.filter(record => record.event.type === 'action.approved' && record.event.data.id === fixture.approveActionId).length, 1);
    assert.equal(records.filter(record => record.event.type === 'action.cancelled' && record.event.data.id === fixture.cancelActionId).length, 1);
    const durable = JSON.stringify(records);
    for (const secret of [bootstrap.token, session.token, review.reviewToken, cancelReview.reviewToken])
        assert.equal(durable.includes(secret), false);
});

test('decision admission rechecks expired sessions, closed work, and changed connection generations and subjects', async t => {
    await t.test('session expires at decision time', async t => {
        let now = Date.now();
        const context = await start(t, { clock: () => now });
        const { session } = await pair(context.server);
        const review = (await requestControl(context.server.origin, 'POST',
            `/api/actions/${context.fixture.approveActionId}/review`, session.token, {})).body;
        now += 15 * 60_000;
        const before = snapshot(context.fixture);
        const response = await requestControl(context.server.origin, 'POST',
            `/api/actions/${context.fixture.approveActionId}/approve`, session.token,
            { reviewToken: review.reviewToken, digest: review.action.digest });
        assert.equal(response.status, 401); assert.deepEqual(snapshot(context.fixture), before);
    });
    for (const change of ['closed-work', 'generation', 'subject']) {
        await t.test(change, async t => {
            const context = await admissionContext(t);
            const writer = new SqliteStore(context.fixture.dbPath);
            try {
                if (change === 'closed-work') {
                    const evidenceRef = writer.putArtifact(context.fixture.workspaceId, 'Synthetic completion evidence.');
                    new Operator(writer).setWorkPhase(context.fixture.workspaceId,
                        context.fixture.ownerId, 'contact-work', 'done', evidenceRef);
                }
                else new OperationService(writer, new OperationRegistry()).registerConnection({
                    workspaceId: context.fixture.workspaceId, ownerId: context.fixture.ownerId,
                    connection: { id: 'synthetic-account', provider: 'synthetic-accounts',
                        subject: change === 'subject' ? 'changed-person' : 'synthetic-person', label: 'changed' }
                });
            } finally { writer.close(); }
            const before = snapshot(context.fixture);
            const response = await mutationRequest(context);
            assert.equal(response.status, 409); assert.deepEqual(snapshot(context.fixture), before);
        });
    }
});

test('accepted, failed, and unknown actions cannot be cancelled through HTTP', async t => {
    for (const status of ['accepted', 'failed', 'unknown']) {
        await t.test(status, async t => {
            const fixture = await createOwnerControlFixture(t);
            const writer = new SqliteStore(fixture.dbPath);
            const state = writer.state(fixture.workspaceId);
            const action = state.actions[fixture.approveActionId];
            const approval = { ownerId: fixture.ownerId, digest: action.digest,
                expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
            writer.append(fixture.workspaceId, state.version,
                [{ type: 'action.approved', data: { id: action.id, approval } }]);
            const approved = writer.state(fixture.workspaceId);
            writer.append(fixture.workspaceId, approved.version,
                [{ type: 'action.started', data: { id: action.id, attemptId: `attempt-${status}` } }]);
            const evidenceRef = writer.putArtifact(fixture.workspaceId, `evidence-${status}`);
            const running = writer.state(fixture.workspaceId);
            writer.append(fixture.workspaceId, running.version,
                [{ type: 'action.finished', data: { id: action.id, attemptId: `attempt-${status}`, status, evidenceRef } }]);
            writer.close();
            const app = openOwnerControl({ dbPath: fixture.dbPath, workspaceId: fixture.workspaceId });
            const server = await startOwnerControlServer({ app, bootstrapDirectory: join(fixture.directory, 'bootstrap'), assets: ASSETS });
            t.after(async () => { await server.close(); app.close(); });
            const { session } = await pair(server);
            const review = (await requestControl(server.origin, 'POST',
                `/api/actions/${fixture.approveActionId}/review`, session.token, {})).body;
            assert.equal(review.canCancel, false);
            const before = snapshot(fixture);
            const response = await requestControl(server.origin, 'POST',
                `/api/actions/${fixture.approveActionId}/cancel`, session.token,
                { reviewToken: review.reviewToken, digest: review.action.digest });
            assert.equal(response.status, 409); assert.deepEqual(snapshot(fixture), before);
        });
    }
});

test('unexpected service faults return a fixed non-logging error, consume receipts, and never disclose secrets', async t => {
    const context = await admissionContext(t);
    const canary = 'unexpected-error-CANARY-secret-command';
    const original = context.app.service.approve.bind(context.app.service);
    context.app.service.approve = (...args) => { const result = original(...args); throw new Error(canary); };
    const stdout = []; const stderr = [];
    const oldOut = process.stdout.write; const oldErr = process.stderr.write;
    process.stdout.write = chunk => { stdout.push(String(chunk)); return true; };
    process.stderr.write = chunk => { stderr.push(String(chunk)); return true; };
    let response;
    try { response = await mutationRequest(context); }
    finally { process.stdout.write = oldOut; process.stderr.write = oldErr; }
    assert.equal(response.status, 500); assert.deepEqual(response.body, { error: 'internal_error' });
    assertSecurityHeaders(response);
    assert.equal(JSON.stringify(response).includes(canary), false);
    assert.equal(stdout.join('').includes(canary), false); assert.equal(stderr.join('').includes(canary), false);
    assert.equal((await mutationRequest(context)).status, 409);
    const records = new SqliteStore(context.fixture.dbPath, { readOnly: true });
    const journal = JSON.stringify(records.journal(context.fixture.workspaceId)); records.close();
    for (const secret of [context.token, context.review.reviewToken, canary]) assert.equal(journal.includes(secret), false);
});

test('list and review response size limits reject overflow instead of truncating data', async t => {
    const list = await start(t); const listPair = await pair(list.server);
    list.app.service.list = () => ({ workspaceId: list.fixture.workspaceId, items: [], nextAfter: null,
        overflow: 'x'.repeat(256 * 1024) });
    const listResponse = await requestControl(list.server.origin, 'GET', '/api/actions', listPair.session.token);
    assert.equal(listResponse.status, 500); assert.deepEqual(listResponse.body, { error: 'internal_error' });

    const review = await start(t); const reviewPair = await pair(review.server);
    review.app.service.review = () => ({ overflow: 'x'.repeat(512 * 1024) });
    const reviewResponse = await requestControl(review.server.origin, 'POST',
        `/api/actions/${review.fixture.approveActionId}/review`, reviewPair.session.token, {});
    assert.equal(reviewResponse.status, 500); assert.deepEqual(reviewResponse.body, { error: 'internal_error' });
});

test('unavailable is mapped to a fixed header-hardened 503 response', async t => {
    const context = await start(t); const { session } = await pair(context.server);
    context.app.service.close();
    const response = await requestControl(context.server.origin, 'GET', '/api/actions', session.token);
    assert.equal(response.status, 503); assert.deepEqual(response.body, { error: 'unavailable' });
    assertSecurityHeaders(response);
});
