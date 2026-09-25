import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runServiceDemo } from '../dist/service-demo.js';

test('service demo rejects unsafe output roots before starting local listeners', async () => {
  await assert.rejects(runServiceDemo({ rootDirectory: 'relative-demo-output', quiet: true }), /absolute|directory/i);
});

test('service demo never changes or populates an unsafe caller-owned output root', async t => {
  const nonPrivate = mkdtempSync(join(tmpdir(), 'behalvo-demo-nonprivate-'));
  const symlinkTarget = mkdtempSync(join(tmpdir(), 'behalvo-demo-target-'));
  const symlink = `${symlinkTarget}-link`;
  const occupied = mkdtempSync(join(tmpdir(), 'behalvo-demo-occupied-'));
  t.after(() => {
    rmSync(nonPrivate, { recursive: true, force: true });
    rmSync(symlink, { force: true });
    rmSync(symlinkTarget, { recursive: true, force: true });
    rmSync(occupied, { recursive: true, force: true });
  });

  chmodSync(nonPrivate, 0o755);
  await assert.rejects(runServiceDemo({ rootDirectory: nonPrivate, quiet: true }), /private|permissions/i);
  assert.equal(readdirSync(nonPrivate).length, 0);
  assert.equal(lstatSync(nonPrivate).mode & 0o777, 0o755);

  symlinkSync(symlinkTarget, symlink);
  await assert.rejects(runServiceDemo({ rootDirectory: symlink, quiet: true }), /symlink|directory/i);
  assert.equal(readdirSync(symlinkTarget).length, 0);

  const collision = join(occupied, 'service.db');
  writeFileSync(collision, 'caller-owned');
  await assert.rejects(runServiceDemo({ rootDirectory: occupied, quiet: true }), /empty|service\.db|occupied/i);
  assert.equal(readFileSync(collision, 'utf8'), 'caller-owned');
  assert.deepEqual(readdirSync(occupied), ['service.db']);
});
