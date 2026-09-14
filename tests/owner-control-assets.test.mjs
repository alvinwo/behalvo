import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadOwnerControlAssets } from '../dist/control/assets.js';

test('owner-control packaged assets are fixed, nonempty, and self-contained', async () => {
  const assets = loadOwnerControlAssets();
  assert.ok(assets.html.length > 0);
  assert.ok(assets.javascript.length > 0);
  assert.ok(assets.css.length > 0);
  assert.doesNotMatch(assets.html, /https?:\/\//);

  const directory = mkdtempSync(join(tmpdir(), 'behalvo spaced assets '));
  try {
    const copiedDist = join(directory, 'dist');
    cpSync('dist', copiedDist, { recursive: true });
    const copiedModule = await import(pathToFileURL(join(copiedDist, 'control/assets.js')).href);
    const copiedAssets = copiedModule.loadOwnerControlAssets();
    assert.deepEqual(copiedAssets, assets);
    assert.match(copiedAssets.html, /Local owner control/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
