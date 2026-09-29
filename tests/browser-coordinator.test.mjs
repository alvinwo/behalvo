import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchDedicatedChrome, SYNTHETIC_PORTAL_ORIGIN } from '../dist/index.js';

const posix = process.platform !== 'win32';

test('dedicated Chrome launcher uses only the owned profile and fixed synthetic portal URL',
  { skip: !posix }, async t => {
    const temp = mkdtempSync(join(tmpdir(), 'behalvo-chrome-launch-'));
    chmodSync(temp, 0o700);
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const profilePath = join(temp, 'profile with spaces');
    const chromePath = join(temp, 'fake chrome');
    const capturePath = join(temp, 'argv.txt');
    writeFileSync(chromePath,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "' + capturePath.replaceAll('"', '\\"') + '"\nexit 0\n',
      { mode: 0o700 });
    chmodSync(chromePath, 0o700);

    const launched = launchDedicatedChrome({ chromePath, profilePath });
    const exit = await launched.exited;
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(launched.stderr(), '');

    const argv = readFileSync(capturePath, 'utf8').trimEnd().split('\n');
    assert.deepEqual(argv, [
      `--user-data-dir=${profilePath}`,
      `${SYNTHETIC_PORTAL_ORIGIN}/`
    ]);
    assert.equal(argv.some(value => /remote-debugging|automation|load-extension|profile-directory/i.test(value)), false);
  });

test('dedicated Chrome launcher rejects non-absolute or mismatched inputs before spawning', () => {
  for (const input of [
    { chromePath: 'relative-chrome', profilePath: '/private/profile' },
    { chromePath: '/private/chrome', profilePath: 'relative-profile' },
    { chromePath: '/private/chrome', profilePath: '/private/profile', extra: true }
  ]) {
    assert.throws(() => launchDedicatedChrome(input), /Chrome bridge launch failed\./);
  }
});
