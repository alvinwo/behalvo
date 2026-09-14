import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname } from 'node:path';

const path = process.argv[2];
const mode = process.argv[3] ?? 'rename';
assert.equal(typeof path, 'string');
const parent = dirname(path);
const canary = 'synthetic-plaintext-stage-canary';
const originalRename = fs.renameSync;
const originalLink = fs.linkSync;
const originalFsync = fs.fsyncSync;
const originalOpen = fs.openSync;
const originalRmdir = fs.rmdirSync;
let renamed = false;
let linked = false;
let injected = false;
let sawCiphertextStage = false;
let armed = false;
let interposedStage;
let movedOwnedStage;

fs.renameSync = (source, destination) => {
  const raw = fs.readFileSync(source);
  assert.equal(raw.includes(Buffer.from(canary)), false);
  sawCiphertextStage = true;
  const result = originalRename(source, destination);
  if (destination === path) renamed = true;
  return result;
};
fs.linkSync = (source, destination) => {
  const raw = fs.readFileSync(source);
  assert.equal(raw.includes(Buffer.from(canary)), false);
  sawCiphertextStage = true;
  const result = originalLink(source, destination);
  if (destination === path) linked = true;
  if (armed && mode === 'link-replace' && destination === path && !injected) {
    fs.unlinkSync(source);
    fs.writeFileSync(source, 'synthetic-foreign-payload', { mode: 0o600 });
    interposedStage = dirname(source);
    injected = true;
  }
  return result;
};
fs.fsyncSync = descriptor => {
  const stat = fs.fstatSync(descriptor);
  if (armed && !injected && (mode === 'payload-replace' || mode === 'stage-replace') && stat.isDirectory()) {
    const stageName = fs.readdirSync(parent).find(name => name.startsWith('.behalvo-model-state-stage-'));
    if (stageName) {
      interposedStage = `${parent}/${stageName}`;
      const result = originalFsync(descriptor);
      if (mode === 'payload-replace') {
        const foreignPayload = `${interposedStage}/foreign-payload`;
        fs.writeFileSync(foreignPayload, 'synthetic-foreign-payload', { mode: 0o600 });
        originalRename(foreignPayload, `${interposedStage}/payload`);
      } else {
        movedOwnedStage = `${interposedStage}.owned`;
        originalRename(interposedStage, movedOwnedStage);
        fs.mkdirSync(interposedStage, { mode: 0o700 });
        fs.writeFileSync(`${interposedStage}/payload`, 'synthetic-foreign-payload', { mode: 0o600 });
      }
      injected = true;
      return result;
    }
  }
  if (((mode === 'rename' && renamed) || (mode === 'link' && linked)) && stat.isDirectory() && !injected) {
    injected = true;
    throw Object.assign(new Error('synthetic-post-rename-eio'), { code: 'EIO' });
  }
  return originalFsync(descriptor);
};
fs.openSync = (requested, flags, permissions) => {
  try {
    return originalOpen(requested, flags, permissions);
  } catch (error) {
    if (armed && mode === 'lock-disappear' && requested === `${path}.behalvo-model-state-lock` &&
        error?.code === 'EEXIST' && !injected) {
      fs.unlinkSync(requested);
      injected = true;
    }
    throw error;
  }
};
fs.rmdirSync = requested => {
  if (armed && mode === 'cleanup-failure' && basename(requested).startsWith('.behalvo-model-state-stage-') && !injected) {
    injected = true;
    throw Object.assign(new Error('synthetic-cleanup-eio'), { code: 'EIO' });
  }
  return originalRmdir(requested);
};
syncBuiltinESMExports();

try {
  const { PrivateModelStateFile } = await import('../dist/storage/private-model-state-file.js');
  const schema = {
    empty: () => ({ value: '' }),
    validate(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).length !== 1 || typeof value.value !== 'string')
        throw new Error('synthetic-schema-secret');
    }
  };
  const file = new PrivateModelStateFile(path, 'model-settings', Buffer.alloc(32, 6), schema);
  if (mode === 'rename') {
    await file.update(async () => ({ next: { value: 'initial' }, result: undefined }));
    let calls = 0;
    await assert.rejects(() => file.update(async () => {
      calls++;
      return { next: { value: canary }, result: undefined };
    }), { message: 'Private model state update failed.' });
    assert.equal(calls, 1);
    assert.equal(renamed, true);
    assert.deepEqual(await file.read(), { value: canary });
    assert.equal(fs.readdirSync(parent).includes(basename(path)), true);
    process.stdout.write('POST_RENAME_FAULT_OK\n');
  } else if (mode === 'link') {
    let calls = 0;
    await assert.rejects(() => file.update(async () => {
      calls++;
      return { next: { value: canary }, result: undefined };
    }), { message: 'Private model state update failed.' });
    assert.equal(calls, 1);
    assert.equal(linked, true);
    fs.unlinkSync(path);
    await assert.rejects(() => file.read(), { message: 'Private model state is unavailable.' });
    process.stdout.write('POST_LINK_FAULT_OK\n');
  } else if (mode === 'lock-disappear') {
    await file.update(async () => ({ next: { value: 'initial' }, result: undefined }));
    fs.writeFileSync(`${path}.behalvo-model-state-lock`, 'synthetic-competing-lock', { mode: 0o600 });
    armed = true;
    let calls = 0;
    assert.equal(await file.update(async current => {
      calls++;
      return { next: { value: `${current.value}-updated` }, result: 'saved' };
    }), 'saved');
    assert.equal(calls, 1);
    assert.equal(injected, true);
    assert.deepEqual(await file.read(), { value: 'initial-updated' });
    process.stdout.write('LOCK_DISAPPEARANCE_OK\n');
  } else if (mode === 'link-replace') {
    armed = true;
    let calls = 0;
    await assert.rejects(() => file.update(async () => {
      calls++;
      return { next: { value: canary }, result: undefined };
    }), { message: 'Private model state update failed.' });
    assert.equal(calls, 1);
    assert.equal(injected, true);
    assert.deepEqual(await file.read(), { value: canary });
    assert.equal(fs.readFileSync(`${interposedStage}/payload`, 'utf8'), 'synthetic-foreign-payload');
    fs.rmSync(interposedStage, { recursive: true });
    process.stdout.write('GUARDED_LINK_UNLINK_OK\n');
  } else {
    await file.update(async () => ({ next: { value: 'initial' }, result: undefined }));
    armed = true;
    let calls = 0;
    await assert.rejects(() => file.update(async current => {
      calls++;
      return { next: { value: `${current.value}-${canary}` }, result: undefined };
    }), { message: 'Private model state update failed.' });
    assert.equal(calls, 1);
    assert.equal(injected, true);
    if (mode === 'cleanup-failure') {
      assert.deepEqual(await file.read(), { value: `initial-${canary}` });
      const stage = fs.readdirSync(parent).find(name => name.startsWith('.behalvo-model-state-stage-'));
      assert.ok(stage);
      fs.rmSync(`${parent}/${stage}`, { recursive: true });
      process.stdout.write('CLEANUP_FAILURE_OK\n');
    } else {
      assert.deepEqual(await file.read(), { value: 'initial' });
      assert.equal(fs.readFileSync(`${interposedStage}/payload`, 'utf8'), 'synthetic-foreign-payload');
      fs.rmSync(interposedStage, { recursive: true });
      if (movedOwnedStage) fs.rmSync(movedOwnedStage, { recursive: true });
      process.stdout.write(mode === 'payload-replace' ? 'PAYLOAD_REPLACEMENT_OK\n' : 'STAGE_REPLACEMENT_OK\n');
    }
  }
  assert.equal(injected, true);
  if (mode !== 'lock-disappear') assert.equal(sawCiphertextStage, true);
  assert.equal(fs.existsSync(`${path}.behalvo-model-state-lock`), false);
  assert.equal(fs.readdirSync(parent).some(name => name.startsWith('.behalvo-model-state-stage-')), false);
} finally {
  fs.renameSync = originalRename;
  fs.linkSync = originalLink;
  fs.fsyncSync = originalFsync;
  fs.openSync = originalOpen;
  fs.rmdirSync = originalRmdir;
  syncBuiltinESMExports();
}
