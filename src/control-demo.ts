import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { loadOwnerControlAssets } from './control/assets.js';
import { initializeOwnerControlDemo } from './control/demo-fixture.js';
import { startOwnerControlServer } from './control/http-server.js';
import { openOwnerControl } from './control/local-app.js';
import { openSyntheticOperations } from './operations/local-synthetic.js';
import { OperationRegistry } from './operations/registry.js';
import { OperationService } from './operations/service.js';
import { acquireLocalProcessLock } from './storage/process-lock.js';
import { SqliteStore } from './storage/sqlite-store.js';

export interface OwnerControlDemoResult {
  mode: 'local-owner-control';
  realModelCalls: 0;
  realExternalEffects: 0;
  authenticatedDecisions: number;
  rejectedApprovalReplays: number;
  verifiedSyntheticActions: number;
  cancelledActions: number;
  journalReplaysMatch: boolean;
}

interface ApiResponse {
  status: number;
  // The demo validates the fields it consumes at each fixed acceptance step.
  body: any;
}

async function api(
  origin: string,
  path: string,
  method: string,
  token: string,
  body: unknown
): Promise<ApiResponse> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: response.status === 204 ? undefined : await response.json()
  };
}

export async function runOwnerControlDemo(): Promise<OwnerControlDemoResult> {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-owner-control-demo-'));
  const dbPath = join(directory, 'owner-control.db');
  let app: ReturnType<typeof openOwnerControl> | undefined;
  let server: Awaited<ReturnType<typeof startOwnerControlServer>> | undefined;

  try {
    const fixture = await initializeOwnerControlDemo(dbPath);
    app = openOwnerControl({ dbPath: fixture.dbPath, workspaceId: fixture.workspaceId });
    server = await startOwnerControlServer({
      app,
      bootstrapDirectory: join(directory, 'bootstrap'),
      assets: loadOwnerControlAssets()
    });

    const bootstrap = JSON.parse(readFileSync(server.bootstrapPath, 'utf8')) as { token: string };
    const paired = await api(
      server.origin,
      '/api/session/bootstrap',
      'POST',
      bootstrap.token,
      {}
    );
    if (paired.status !== 200) throw new Error('Bootstrap exchange failed.');
    const token = paired.body.token as string;

    const list = await api(server.origin, '/api/actions', 'GET', token, undefined);
    if (list.status !== 200 || list.body.items.length !== 2) {
      throw new Error('Action listing failed.');
    }

    const contactReview = await api(
      server.origin,
      `/api/actions/${fixture.approveActionId}/review`,
      'POST',
      token,
      {}
    );
    if (contactReview.status !== 200) throw new Error('Contact review failed.');
    const approved = await api(
      server.origin,
      `/api/actions/${fixture.approveActionId}/approve`,
      'POST',
      token,
      {
        reviewToken: contactReview.body.reviewToken,
        digest: contactReview.body.action.digest
      }
    );
    if (approved.status !== 200 || approved.body.status !== 'approved') {
      throw new Error('Contact approval failed.');
    }

    const replay = await api(
      server.origin,
      `/api/actions/${fixture.approveActionId}/approve`,
      'POST',
      token,
      {
        reviewToken: contactReview.body.reviewToken,
        digest: contactReview.body.action.digest
      }
    );
    if (replay.status !== 409) throw new Error('Approval replay was accepted.');

    const cancellationReview = await api(
      server.origin,
      `/api/actions/${fixture.cancelActionId}/review`,
      'POST',
      token,
      {}
    );
    if (cancellationReview.status !== 200) throw new Error('Cancellation review failed.');
    const cancelled = await api(
      server.origin,
      `/api/actions/${fixture.cancelActionId}/cancel`,
      'POST',
      token,
      {
        reviewToken: cancellationReview.body.reviewToken,
        digest: cancellationReview.body.action.digest
      }
    );
    if (cancelled.status !== 200 || cancelled.body.status !== 'cancelled') {
      throw new Error('Cancellation failed.');
    }

    const logout = await api(server.origin, '/api/session/logout', 'POST', token, {});
    if (logout.status !== 204) throw new Error('Logout failed.');
    const revoked = await api(server.origin, '/api/actions', 'GET', token, undefined);
    if (revoked.status !== 401) throw new Error('Logged-out session remained active.');

    const during = new SqliteStore(fixture.dbPath, { readOnly: true });
    try {
      if (during.journal(fixture.workspaceId)
        .some(record => record.event.type === 'action.started')) {
        throw new Error('Owner control executed an operation.');
      }
    } finally {
      during.close();
    }

    await server.close();
    server = undefined;
    app.close();
    app = undefined;

    const lock = acquireLocalProcessLock(fixture.dbPath);
    let store: SqliteStore | undefined;
    let provider: ReturnType<typeof openSyntheticOperations> | undefined;
    try {
      store = new SqliteStore(lock.dbPath);
      const registry = new OperationRegistry();
      const operations = new OperationService(
        store,
        registry,
        undefined,
        fixture.workspaceId
      );
      provider = openSyntheticOperations(store, registry, operations, fixture);

      await operations.execute({
        workspaceId: fixture.workspaceId,
        ownerId: fixture.ownerId,
        actionId: fixture.approveActionId
      });
      const verified = await operations.verify({
        workspaceId: fixture.workspaceId,
        ownerId: fixture.ownerId,
        actionId: fixture.approveActionId
      });
      if (verified.verification?.status !== 'satisfied') {
        throw new Error('Approved action did not verify.');
      }

      let cancellationBlocked = false;
      try {
        const attempted = await operations.execute({
          workspaceId: fixture.workspaceId,
          ownerId: fixture.ownerId,
          actionId: fixture.cancelActionId
        });
        cancellationBlocked = attempted.status === 'cancelled';
      } catch {
        cancellationBlocked = true;
      }
      if (!cancellationBlocked) throw new Error('Cancelled action executed.');

      const before = store.state(fixture.workspaceId);
      const started = store.journal(fixture.workspaceId)
        .filter(record => record.event.type === 'action.started');
      if (started.length !== 1) throw new Error('Expected exactly one started action.');
      store.rebuild(fixture.workspaceId);
      const rebuilt = store.state(fixture.workspaceId);
      if (!isDeepStrictEqual(before, rebuilt)) {
        throw new Error('Journal rebuild did not reproduce current state.');
      }
      store.close();
      store = new SqliteStore(lock.dbPath);
      const reopened = store.state(fixture.workspaceId);
      if (!isDeepStrictEqual(before, reopened)) {
        throw new Error('Reopened journal state did not match current state.');
      }

      return {
        mode: 'local-owner-control',
        realModelCalls: 0,
        realExternalEffects: 0,
        authenticatedDecisions: 2,
        rejectedApprovalReplays: 1,
        verifiedSyntheticActions: 1,
        cancelledActions: 1,
        journalReplaysMatch: true
      };
    } finally {
      provider?.close();
      store?.close();
      lock.release();
    }
  } finally {
    if (server) await server.close();
    app?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOwnerControlDemo()
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(() => {
      process.stderr.write('Owner control demo failed.\n');
      process.exitCode = 1;
    });
}
