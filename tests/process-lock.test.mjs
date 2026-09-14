import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireLocalProcessLock } from '../dist/storage/process-lock.js';
import { openLocalAgent } from '../dist/index.js';
import { openOwnerControl } from '../dist/control/local-app.js';
import { SqliteStore } from '../dist/storage/sqlite-store.js';
import { createOwnerControlFixture } from './owner-control-fixture.mjs';

const posix = process.platform !== 'win32' && typeof process.geteuid === 'function';
const gateway = { async listModels() { return [{ provider: 'fake', model: 'one' }]; },
    async complete() { return { text: '{"reply":"unused","workProposals":[],"factProposals":[]}' }; } };
function directory(t, prefix = 'behalvo-lock-') {
    const value = mkdtempSync(join(tmpdir(), prefix));
    t.after(() => rmSync(value, { recursive: true, force: true }));
    return value;
}
function startChild(kind, dbPath) {
    const child = spawn(process.execPath, ['tests/owner-control-lock-child.mjs', kind, dbPath], {
        cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe']
    });
    return new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('lock child readiness timeout')); }, 5000);
        child.once('error', reject);
        child.stdout.on('data', chunk => {
            output += chunk;
            if (output.includes('READY\n')) { clearTimeout(timer); resolve(child); }
        });
        child.once('exit', code => { if (!output.includes('READY\n')) reject(new Error(`lock child exited ${code}`)); });
    });
}
function stopChild(child) {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`lock child exited ${code}`)));
        child.stdin.end();
    });
}

test('local process ownership reference-counts canonical aliases and releases only its own lock identity', { skip: !posix }, t => {
    const dir = directory(t);
    const dbPath = join(dir, 'agent.db');
    const first = acquireLocalProcessLock(dbPath);
    const second = acquireLocalProcessLock(`${dir}/./agent.db`);
    assert.equal(second.dbPath, first.dbPath);
    assert.equal(lstatSync(`${first.dbPath}.behalvo-lock`).mode & 0o777, 0o600);
    first.release();
    assert.equal(existsSync(`${first.dbPath}.behalvo-lock`), true);
    second.release();
    second.release();
    assert.equal(existsSync(`${first.dbPath}.behalvo-lock`), false);

    const owned = acquireLocalProcessLock(dbPath);
    unlinkSync(`${owned.dbPath}.behalvo-lock`);
    writeFileSync(`${owned.dbPath}.behalvo-lock`, 'replacement', { mode: 0o600 });
    owned.release();
    assert.equal(readFileSync(`${owned.dbPath}.behalvo-lock`, 'utf8'), 'replacement');
});

test('unsafe database leaves, immediate directories, and leftover locks fail closed without replacement', { skip: !posix }, t => {
    const dir = directory(t);
    const target = join(dir, 'target.db');
    writeFileSync(target, 'not sqlite');
    const symlink = join(dir, 'symlink.db');
    symlinkSync(target, symlink);
    assert.throws(() => acquireLocalProcessLock(symlink), /lock|private|failed|unsafe/i);
    const hardlink = join(dir, 'hardlink.db');
    linkSync(target, hardlink);
    assert.throws(() => acquireLocalProcessLock(hardlink), /lock|private|failed|unsafe/i);
    unlinkSync(hardlink);
    unlinkSync(target);
    const directoryLeaf = join(dir, 'directory.db');
    const childDirectory = mkdtempSync(`${directoryLeaf}-`);
    assert.throws(() => acquireLocalProcessLock(childDirectory), /lock|private|failed|unsafe/i);

    const unsafeDir = directory(t, 'behalvo-lock-unsafe-');
    chmodSync(unsafeDir, 0o755);
    assert.throws(() => acquireLocalProcessLock(join(unsafeDir, 'agent.db')), /lock|private|failed|unsafe/i);

    const dbPath = join(dir, 'stale.db');
    writeFileSync(`${dbPath}.behalvo-lock`, '{"version":1}', { mode: 0o600 });
    assert.throws(() => acquireLocalProcessLock(dbPath), /lock|owned|active|unavailable/i);
    assert.equal(readFileSync(`${dbPath}.behalvo-lock`, 'utf8'), '{"version":1}');
});

test('lock creation establishes mode 0600 even under a restrictive process umask', { skip: !posix }, t => {
    const dir = directory(t);
    const dbPath = join(dir, 'umask.db');
    const previous = process.umask(0o777);
    let lock;
    try {
        lock = acquireLocalProcessLock(dbPath);
        assert.equal(lstatSync(`${dbPath}.behalvo-lock`).mode & 0o777, 0o600);
    } finally {
        process.umask(previous);
        lock?.release();
    }
});

test('a real symlink-parent alias shares canonical lock, database, and synthetic provider identity', { skip: !posix }, async t => {
    const root = directory(t, 'behalvo-lock-parent-alias-');
    const canonicalDirectory = join(root, 'canonical');
    const aliasDirectory = join(root, 'alias');
    mkdirSync(canonicalDirectory, { mode: 0o700 });
    symlinkSync(canonicalDirectory, aliasDirectory, 'dir');
    const canonicalPath = join(canonicalDirectory, 'synthetic.db');
    const aliasPath = join(aliasDirectory, 'synthetic.db');

    const first = acquireLocalProcessLock(canonicalPath);
    const second = acquireLocalProcessLock(aliasPath);
    assert.equal(second.dbPath, canonicalPath);
    first.release();
    assert.equal(existsSync(`${canonicalPath}.behalvo-lock`), true);
    second.release();
    assert.equal(existsSync(`${canonicalPath}.behalvo-lock`), false);

    const child = await startChild('lock', aliasPath);
    try {
        assert.throws(() => acquireLocalProcessLock(canonicalPath), /lock|owned|active|unavailable/i);
    } finally { await stopChild(child); }

    const app = openLocalAgent({ dbPath: aliasPath, workspaceId: 'owner-control-demo', ownerId: 'owner',
        gateways: [gateway], syntheticOperations: true });
    try {
        assert.equal(existsSync(canonicalPath), true);
        assert.equal(existsSync(`${canonicalPath}.synthetic.sqlite`), true);
        assert.equal(existsSync(`${canonicalPath}.behalvo-lock`), true);
    } finally { app.close(); }
    assert.equal(existsSync(`${canonicalPath}.behalvo-lock`), false);
});

test('the shared lock excludes another process in both local/control directions before provider mutation', { skip: !posix }, async t => {
    const dir = directory(t, 'behalvo-lock-directions-');
    const unseededPath = join(dir, 'unseeded.db');
    const setup = new SqliteStore(unseededPath);
    setup.bindLocalMode('synthetic'); setup.createWorkspace('owner-control-demo', 'owner'); setup.close();
    const control = openOwnerControl({ dbPath: unseededPath, workspaceId: 'owner-control-demo' });
    try {
        const child = spawn(process.execPath, ['tests/owner-control-lock-child.mjs', 'local-synthetic', unseededPath], {
            cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe']
        });
        const [code, stderr] = await new Promise(resolve => {
            let error = ''; child.stderr.on('data', chunk => error += chunk);
            child.once('exit', value => resolve([value, error]));
        });
        assert.notEqual(code, 0);
        assert.match(stderr, /lock|owned|active|unavailable/i);
        assert.equal(existsSync(`${unseededPath}.synthetic.sqlite`), false);
    } finally { control.close(); }

    const fixture = await createOwnerControlFixture(t);
    const child = await startChild('local-synthetic', fixture.dbPath);
    try {
        assert.throws(() => openOwnerControl({ dbPath: fixture.dbPath, workspaceId: fixture.workspaceId }), /lock|owned|active|unavailable/i);
    } finally { await stopChild(child); }
});

test('an unclean child leaves a lock that is never stolen automatically', { skip: !posix }, async t => {
    const dir = directory(t);
    const dbPath = join(dir, 'crash.db');
    const child = await startChild('lock', dbPath);
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    assert.equal(existsSync(`${dbPath}.behalvo-lock`), true);
    assert.throws(() => acquireLocalProcessLock(dbPath), /lock|owned|active|unavailable/i);
});

test('localMode inspects without adopting and ordinary 0644 databases reopen under a private parent', { skip: !posix }, t => {
    const dir = directory(t);
    const dbPath = join(dir, 'ordinary.db');
    const app = openLocalAgent({ dbPath, workspaceId: 'ordinary', ownerId: 'owner', gateways: [gateway] });
    app.close();
    chmodSync(dbPath, 0o644);
    const reopened = openLocalAgent({ dbPath, workspaceId: 'ordinary', ownerId: 'owner', gateways: [gateway] });
    reopened.close();
    assert.equal(lstatSync(dbPath).mode & 0o777, 0o644);

    const unboundPath = join(dir, 'unbound.db');
    const unbound = new SqliteStore(unboundPath);
    assert.equal(unbound.localMode(), undefined);
    unbound.close();
    const raw = new DatabaseSync(unboundPath, { readOnly: true });
    assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='local_mode'").get().n, 0);
    raw.close();
});

test('owner control admits only an existing plaintext synthetic workspace without changing rejected files', { skip: !posix }, async t => {
    const dir = directory(t);
    const missing = join(dir, 'missing.db');
    assert.throws(() => openOwnerControl({ dbPath: missing, workspaceId: 'ws' }));
    assert.equal(existsSync(missing), false);

    const ordinaryPath = join(dir, 'ordinary.db');
    const ordinary = openLocalAgent({ dbPath: ordinaryPath, workspaceId: 'ws', ownerId: 'owner', gateways: [gateway] });
    ordinary.close();
    const beforeOrdinary = readFileSync(ordinaryPath);
    assert.throws(() => openOwnerControl({ dbPath: ordinaryPath, workspaceId: 'ws' }), /synthetic|mode|unavailable/i);
    assert.deepEqual(readFileSync(ordinaryPath), beforeOrdinary);

    const noWorkspace = join(dir, 'no-workspace.db');
    const empty = new SqliteStore(noWorkspace); empty.bindLocalMode('synthetic'); empty.close();
    const beforeEmpty = readFileSync(noWorkspace);
    assert.throws(() => openOwnerControl({ dbPath: noWorkspace, workspaceId: 'ws' }), /workspace|not found|unavailable/i);
    assert.deepEqual(readFileSync(noWorkspace), beforeEmpty);

    const encryptedPath = join(dir, 'encrypted.db');
    const encrypted = new SqliteStore(encryptedPath, { encryptionKey: Buffer.alloc(32, 7) });
    encrypted.bindLocalMode('synthetic'); encrypted.createWorkspace('ws', 'owner'); encrypted.close();
    const beforeEncrypted = readFileSync(encryptedPath);
    assert.throws(() => openOwnerControl({ dbPath: encryptedPath, workspaceId: 'ws' }));
    assert.deepEqual(readFileSync(encryptedPath), beforeEncrypted);

    const fixture = await createOwnerControlFixture(t);
    const admitted = openOwnerControl({ dbPath: fixture.dbPath, workspaceId: fixture.workspaceId });
    admitted.close(); admitted.close();
    assert.equal(existsSync(`${fixture.dbPath}.behalvo-lock`), false);
});
