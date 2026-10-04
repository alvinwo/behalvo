import test from 'node:test';
import assert from 'node:assert/strict';
const enabled = process.env.BEHALVO_PLAYWRIGHT_P2_ACCEPTANCE === '1';
test('visible supervised service completes authorized synthetic workflow and read-only replay', { skip: !enabled, timeout: 190000 }, async () => {
  const { runPlaywrightActions } = await import('../dist/browser/playwright-actions-demo.js');
  const result = await runPlaywrightActions({ signal: new AbortController().signal });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.cleanup, 'confirmed');
  for (const key of ['emptyPoll', 'cleanRestart', 'handoffResume', 'candidateRace', 'singleBooking', 'authoritativeReadback', 'replayNoEffects'])
    assert.equal(result[key], true, key);
  assert.equal(result.playwrightVersion, '1.63.0');
});
test('supervisor suppresses startup canaries and never launches after cancellation', async () => {
  const { runPlaywrightActions } = await import('../dist/browser/playwright-actions-demo.js');
  const cancelled = new AbortController(); cancelled.abort(); let launches = 0;
  const result = await runPlaywrightActions({ signal: cancelled.signal }, {
    createOwner() { launches++; throw new Error('CANARY-OWNER'); }
  });
  assert.equal(result.ok, false); assert.equal(result.code, 'cancelled'); assert.equal(result.cleanup, 'confirmed'); assert.equal(launches, 0);
  const failed = await runPlaywrightActions({ signal: new AbortController().signal }, {
    startPortal: async () => { throw new Error('CANARY-PORTAL'); }
  });
  assert.equal(failed.ok, false); assert.equal(failed.cleanup, 'confirmed'); assert.equal(JSON.stringify(failed).includes('CANARY'), false);
});
test('late portal startup retains pending cleanup and closes when it arrives', async () => {
  const { runPlaywrightActions } = await import('../dist/browser/playwright-actions-demo.js');
  let release, closes = 0, services = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const result = await runPlaywrightActions({ signal: new AbortController().signal }, {
    runTimeoutMs: 20, shutdownTimeoutMs: 20, startPortal: () => pending,
    startService: async () => { services++; throw new Error('CANARY-SERVICE'); }
  });
  assert.equal(result.cleanup, 'pending'); assert.equal(services, 0);
  release({ origin: 'http://127.0.0.1:43117', close: async () => { closes++; } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closes, 1); assert.equal(services, 0);
});
test('lost real submission response resolves only by fresh service readback without resubmitting', { skip: !enabled, timeout: 190000 }, async () => {
  const { runPlaywrightActions } = await import('../dist/browser/playwright-actions-demo.js');
  const { startSyntheticPortal } = await import('../dist/synthetic-portal/server.js');
  let submissions = 0;
  const result = await runPlaywrightActions({ signal: new AbortController().signal }, {
    startPortal: async input => {
      const gesture = input.state.gesture.bind(input.state);
      input.state.gesture = command => {
        const result = gesture(command);
        if (command.kind === 'booking.submit') { submissions++; throw new Error('CANARY-LOST-RESPONSE'); }
        return result;
      };
      return startSyntheticPortal(input);
    }
  });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(submissions, 1);
  assert.equal(result.authoritativeReadback, true); assert.equal(result.cleanup, 'confirmed');
});
for (const failure of ['owner_pending', 'owner_rejected', 'portal_rejected'])
  test(`supervisor retains failure when ${failure} and never starts another browser`, async () => {
    const { runPlaywrightActions } = await import('../dist/browser/playwright-actions-demo.js');
    let owners = 0, closeCalls = 0, receipt;
    const result = await runPlaywrightActions({ signal: new AbortController().signal }, {
      startPortal: async () => ({ origin: 'http://127.0.0.1:43117', close: async () => { if (failure === 'portal_rejected') throw new Error('CANARY'); } }),
      startService: async options => {
        await options.syntheticMonitoring.createBrowserTransport({ binding: { profileId: 'test', connectionGeneration: 1 }, serviceGeneration: 'test' });
        throw new Error('CANARY-SERVICE');
      },
      createOwner: () => { owners++; return {
        receiptPath: '/private/tmp/behalvo-playwright-TEST01/receipt.json',
        start: async () => { throw new Error('CANARY-START'); },
        close: async () => { closeCalls++; if (failure === 'owner_rejected') throw new Error('CANARY-CLOSE'); return { confirmed: failure !== 'owner_pending' }; },
        finishReceipt: (...args) => { receipt = args; }
      }; }
    });
    assert.equal(result.ok, false); assert.equal(result.cleanup, 'pending'); assert.equal(owners, 1); assert.equal(closeCalls, 1);
    assert.equal(receipt[0], false); assert.equal(JSON.stringify(result).includes('CANARY'), false);
  });
for (const readback of ['absent', 'mismatched']) test(`${readback} readback leaves the real submitted action unknown`, { skip: !enabled, timeout: 190000 }, async () => {
  const { runPlaywrightActions } = await import('../dist/browser/playwright-actions-demo.js');
  const { startSyntheticPortal } = await import('../dist/synthetic-portal/server.js');
  const { startLocalService } = await import('../dist/service/local-service.js');
  const { SqliteStore } = await import('../dist/storage/sqlite-store.js');
  const statuses = []; let submissions = 0, readbacks = 0;
  const result = await runPlaywrightActions({ signal: new AbortController().signal }, {
    startService: async options => {
      const service = await startLocalService(options);
      return { ...service, shutdown: async () => {
        const stopped = await service.shutdown();
        if (stopped) {
          const store = new SqliteStore(options.dbPath, { encryptionKey: options.encryptionKey, serviceQueue: { upgradeExisting: false } });
          try { statuses.push(...Object.values(store.state(options.workspaceId).actions).map(action => action.status)); }
          finally { store.close(); }
        }
        return stopped;
      } };
    },
    startPortal: async input => {
      const gesture = input.state.gesture.bind(input.state), actualReadback = input.state.authoritativeReadback.bind(input.state);
      const inspect = input.state.inspect.bind(input.state);
      input.state.inspect = () => {
        const value = inspect();
        return readback === 'mismatched' && value.state === 'appointment'
          ? { ...value, booking: { ...value.booking, date: '2027-02-01' } } : value;
      };
      input.state.gesture = command => {
        if (command.kind === 'appointment.readback') readbacks++;
        const value = gesture(command);
        if (command.kind === 'booking.submit') {
          submissions++;
          input.state.authoritativeReadback = () => {
            const actual = actualReadback();
            return readback === 'absent' ? { state: 'unknown' } : { ...actual, booking: { ...actual.booking, date: '2027-02-01' } };
          };
          throw new Error('CANARY-LOST-RESPONSE');
        }
        return value;
      };
      return startSyntheticPortal(input);
    }
  });
  assert.equal(result.ok, false); assert.equal(result.cleanup, 'confirmed');
  assert.equal(submissions, 1); assert.equal(readbacks, 1);
  assert.ok(statuses.includes('unknown')); assert.equal(statuses.includes('accepted'), false);
  assert.equal(JSON.stringify(result).includes('CANARY'), false);
});
test('service arriving during final cleanup cannot claim confirmation before its shutdown settles', async () => {
  const { runPlaywrightActions } = await import('../dist/browser/playwright-actions-demo.js');
  let release, shutdownCalls = 0;
  const held = new Promise(resolve => { release = resolve; });
  const result = await runPlaywrightActions({ signal: new AbortController().signal }, {
    runTimeoutMs: 5, shutdownTimeoutMs: 100,
    startPortal: async () => ({ origin: 'http://127.0.0.1:43117', close: async () => { await new Promise(r => setTimeout(r, 40)); } }),
    startService: async () => { await new Promise(r => setTimeout(r, 15)); return { shutdown: async () => { shutdownCalls++; await held; return true; } }; }
  });
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(shutdownCalls, 1); assert.equal(result.cleanup, 'pending');
});
test('temporary store removal failure returns pending cleanup without exposing filesystem details', async () => {
  const { runPlaywrightActions } = await import('../dist/browser/playwright-actions-demo.js');
  const { rmSync } = await import('node:fs'); let root;
  const cancelled = new AbortController(); cancelled.abort();
  try {
    const result = await runPlaywrightActions({ signal: cancelled.signal }, {
      removeRoot: path => { root = path; throw new Error('CANARY-FILESYSTEM'); }
    });
    assert.equal(result.cleanup, 'pending'); assert.equal(result.code, 'cleanup_pending');
    assert.equal(JSON.stringify(result).includes('CANARY'), false); assert.ok(root);
  } finally { if (root) rmSync(root, { recursive: true, force: true }); }
});
test('portal startup has a separate setup deadline and retains late cleanup', async () => {
  const { runPlaywrightActions } = await import('../dist/browser/playwright-actions-demo.js');
  let release, closes = 0; const start = Date.now();
  const result = await runPlaywrightActions({ signal: new AbortController().signal }, {
    setupTimeoutMs: 10, runTimeoutMs: 2000, startPortal: () => new Promise(resolve => { release = resolve; })
  });
  assert.ok(Date.now() - start < 1000); assert.equal(result.cleanup, 'pending');
  release({ origin: 'http://127.0.0.1:43117', close: async () => { closes++; } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closes, 1);
});
test('late browser startup cannot publish authority or trigger a replacement', async () => {
  const { runPlaywrightActions } = await import('../dist/browser/playwright-actions-demo.js');
  let release, owners = 0, closes = 0;
  const started = new Promise(resolve => { release = resolve; });
  const result = await runPlaywrightActions({ signal: new AbortController().signal }, {
    setupTimeoutMs: 10, runTimeoutMs: 2000,
    startPortal: async () => ({ origin: 'http://127.0.0.1:43117', close: async () => {} }),
    startService: async options => { await options.syntheticMonitoring.createBrowserTransport({ binding: { profileId: 'late', connectionGeneration: 1 }, serviceGeneration: 'late' }); throw new Error('unexpected'); },
    createOwner: () => { owners++; return { receiptPath: '/private/tmp/behalvo-playwright-LATE01/receipt.json',
      start: () => started, close: async () => { closes++; return { confirmed: true }; }, finishReceipt() {} }; }
  });
  assert.equal(result.cleanup, 'pending'); assert.equal(owners, 1); assert.equal(closes, 1);
  release({ transport: {}, tabId: 1, browserVersion: '153.0.8010.12' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(owners, 1);
});
test('a false service shutdown forbids the next owned browser', { skip: !enabled, timeout: 190000 }, async () => {
  const { runPlaywrightActions } = await import('../dist/browser/playwright-actions-demo.js');
  const { startLocalService } = await import('../dist/service/local-service.js');
  const { PlaywrightActionsOwner } = await import('../dist/browser/playwright-actions-owner.js');
  let owners = 0;
  const result = await runPlaywrightActions({ signal: new AbortController().signal }, {
    startService: async options => { const service = await startLocalService(options);
      return { ...service, shutdown: async () => { await service.shutdown(); return false; } }; },
    createOwner: input => { owners++; return new PlaywrightActionsOwner(input); }
  });
  assert.equal(result.cleanup, 'pending'); assert.equal(result.ok, false); assert.equal(owners, 1);
});
