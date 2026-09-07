import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCliArgs } from '../dist/cli/main.js';

const suffixes = ['DB', 'PI_AUTH', 'WORKSPACE', 'OWNER', 'MODEL'];
function environment(t, values = {}) {
  const previous = new Map();
  for (const prefix of ['BEHALVO_', 'OPERATOR_']) {
    for (const suffix of suffixes) {
      const key = prefix + suffix;
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const oldValues = {
  OPERATOR_DB: 'data/legacy.db', OPERATOR_PI_AUTH: 'data/legacy-auth.json',
  OPERATOR_WORKSPACE: 'legacy-workspace', OPERATOR_OWNER: 'legacy-owner',
  OPERATOR_MODEL: 'legacy-provider/legacy-model'
};
const newValues = {
  BEHALVO_DB: 'data/chosen.db', BEHALVO_PI_AUTH: 'data/chosen-auth.json',
  BEHALVO_WORKSPACE: 'chosen-workspace', BEHALVO_OWNER: 'chosen-owner',
  BEHALVO_MODEL: 'chosen-provider/chosen-model'
};

function assertNewValues(args) {
  assert.equal(args.dbPath, resolve(newValues.BEHALVO_DB));
  assert.equal(args.authPath, resolve(newValues.BEHALVO_PI_AUTH));
  assert.equal(args.workspaceId, newValues.BEHALVO_WORKSPACE);
  assert.equal(args.ownerId, newValues.BEHALVO_OWNER);
  assert.deepEqual(args.model, { provider: 'chosen-provider', model: 'chosen-model' });
}

test('package and lockfile identify the release consistently as behalvo', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'behalvo');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'UNLICENSED');
});

test('CLI accepts all five BEHALVO configuration environment variables', t => {
  environment(t, newValues);
  assertNewValues(parseCliArgs([]));
});

test('existing OPERATOR configuration continues to select the original data and identity', t => {
  environment(t, oldValues);
  const args = parseCliArgs([]);
  assert.equal(args.dbPath, resolve(oldValues.OPERATOR_DB));
  assert.equal(args.authPath, resolve(oldValues.OPERATOR_PI_AUTH));
  assert.equal(args.workspaceId, oldValues.OPERATOR_WORKSPACE);
  assert.equal(args.ownerId, oldValues.OPERATOR_OWNER);
  assert.deepEqual(args.model, { provider: 'legacy-provider', model: 'legacy-model' });
});

test('BEHALVO values take precedence when both prefixes are present', t => {
  environment(t, { ...oldValues, ...newValues });
  assertNewValues(parseCliArgs([]));
});

test('explicit CLI flags override both new and legacy environment configuration', t => {
  environment(t, { ...oldValues, ...newValues });
  const args = parseCliArgs([
    '--db', 'data/flag.db', '--auth', 'data/flag-auth.json',
    '--workspace', 'flag-workspace', '--owner', 'flag-owner',
    '--model', 'flag-provider/flag-model', '--offline'
  ]);
  assert.equal(args.dbPath, resolve('data/flag.db'));
  assert.equal(args.authPath, resolve('data/flag-auth.json'));
  assert.equal(args.workspaceId, 'flag-workspace');
  assert.equal(args.ownerId, 'flag-owner');
  assert.deepEqual(args.model, { provider: 'flag-provider', model: 'flag-model' });
  assert.equal(args.offline, true);
});

test('renaming does not change default database, credentials, workspace or owner', t => {
  environment(t);
  const args = parseCliArgs([]);
  assert.equal(args.dbPath, resolve('data/agent.db'));
  assert.equal(args.authPath, resolve('data/pi-auth.json'));
  assert.equal(args.workspaceId, 'personal');
  assert.equal(args.ownerId, 'owner');
  assert.equal(args.model, undefined);
});
