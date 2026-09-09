import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { OperationRegistry, OperationService, Operator, SqliteStore } from './index.js';
import {
  CONTACT_RESOURCE,
  SUBSCRIPTION_RESOURCE,
  SyntheticContactUpdateHandler,
  SyntheticOperationsProvider,
  SyntheticSubscriptionCancellationHandler
} from './operations/demo-handlers.js';

export interface OperationsDemoResult {
  mode: 'synthetic-operations';
  realExternalEffects: 0;
  verifiedOperations: number;
  unknownBlocked: boolean;
  replayMatches: boolean;
}

function advancingClock(start: string): () => string {
  let milliseconds = Date.parse(start);
  return () => new Date(milliseconds++).toISOString();
}

export async function runOperationsDemo(dbPath: string): Promise<OperationsDemoResult> {
  const clock = advancingClock('2026-09-09T12:00:00.000Z');
  const remote = new SyntheticOperationsProvider(clock);
  remote.seedContact('customer-ada', { email: 'ada@old.example.test', locale: 'en-GB' });
  remote.seedSubscription('account-grace', {
    plan: 'synthetic-monthly', status: 'active', cancellationReason: null
  });

  const registry = new OperationRegistry();
  registry.register(new SyntheticContactUpdateHandler(remote));
  registry.register(new SyntheticSubscriptionCancellationHandler(remote));

  let store = new SqliteStore(dbPath);
  try {
    store.createWorkspace('personal', 'owner');
    const operator = new Operator(store, clock);
    operator.createWork('personal', 'owner', {
      id: 'account-maintenance',
      title: 'Synthetic account maintenance',
      goal: 'Verify requested changes on explicitly bound synthetic subjects',
      threadId: 'local-demo'
    });
    const service = new OperationService(store, registry, clock);

    service.registerConnection({
      workspaceId: 'personal', ownerId: 'owner',
      connection: {
        id: 'contact-connection', provider: remote.provider,
        subject: 'customer-ada', label: 'Synthetic customer profile'
      }
    });
    service.registerConnection({
      workspaceId: 'personal', ownerId: 'owner',
      connection: {
        id: 'subscription-connection', provider: remote.provider,
        subject: 'account-grace', label: 'Synthetic subscription account'
      }
    });

    const contact = await service.prepare({
      workspaceId: 'personal', ownerId: 'owner', workId: 'account-maintenance',
      key: 'contact-update-initial', connectionId: 'contact-connection',
      operationId: 'contact.update', operationVersion: '1', resourceId: CONTACT_RESOURCE,
      arguments: { email: 'ada@new.example.test' }
    });
    const cancellation = await service.prepare({
      workspaceId: 'personal', ownerId: 'owner', workId: 'account-maintenance',
      key: 'subscription-cancellation', connectionId: 'subscription-connection',
      operationId: 'subscription.cancel', operationVersion: '1', resourceId: SUBSCRIPTION_RESOURCE,
      arguments: { reason: 'Synthetic demonstration complete' }
    });
    service.approveBatch({
      workspaceId: 'personal', ownerId: 'owner', expiresAt: '2026-09-09T13:00:00.000Z',
      approvals: [
        { actionId: contact.id, digest: contact.digest },
        { actionId: cancellation.id, digest: cancellation.digest }
      ]
    });
    await service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: contact.id });
    await service.execute({ workspaceId: 'personal', ownerId: 'owner', actionId: cancellation.id });
    await service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: contact.id });
    await service.verify({ workspaceId: 'personal', ownerId: 'owner', actionId: cancellation.id });

    const uncertain = await service.prepare({
      workspaceId: 'personal', ownerId: 'owner', workId: 'account-maintenance',
      key: 'contact-update-uncertain', connectionId: 'contact-connection',
      operationId: 'contact.update', operationVersion: '1', resourceId: CONTACT_RESOURCE,
      arguments: { email: 'ada@uncertain.example.test' }
    });
    service.approveBatch({
      workspaceId: 'personal', ownerId: 'owner', expiresAt: '2026-09-09T13:00:00.000Z',
      approvals: [{ actionId: uncertain.id, digest: uncertain.digest }]
    });
    remote.loseNextContactResponse();
    const uncertainResult = await service.execute({
      workspaceId: 'personal', ownerId: 'owner', actionId: uncertain.id
    });
    if (uncertainResult.status !== 'unknown') throw new Error('Synthetic lost response did not become unknown');
    const submissionsAfterUnknown = remote.submissionCount;

    let unknownBlocked = false;
    try {
      await service.prepare({
        workspaceId: 'personal', ownerId: 'owner', workId: 'account-maintenance',
        key: 'contact-update-blocked', connectionId: 'contact-connection',
        operationId: 'contact.update', operationVersion: '1', resourceId: CONTACT_RESOURCE,
        arguments: { email: 'ada@replacement.example.test' }
      });
    } catch (error) {
      if (!(error instanceof Error) || !/barrier|unresolved|scope/i.test(error.message)) throw error;
      unknownBlocked = true;
    }
    if (!unknownBlocked) throw new Error('Unknown operation did not block replacement preparation');
    if (remote.submissionCount !== submissionsAfterUnknown)
      throw new Error('Rejected replacement preparation dispatched an operation');

    const submissionsBeforeReadback = remote.submissionCount;
    const settled = await service.verify({
      workspaceId: 'personal', ownerId: 'owner', actionId: uncertain.id
    });
    if (settled.status !== 'accepted' || settled.verification?.status !== 'satisfied')
      throw new Error('Trusted readback did not settle the unknown operation');
    if (remote.submissionCount !== submissionsBeforeReadback)
      throw new Error('Readback resubmitted the uncertain operation');

    await service.prepare({
      workspaceId: 'personal', ownerId: 'owner', workId: 'account-maintenance',
      key: 'contact-update-after-settlement', connectionId: 'contact-connection',
      operationId: 'contact.update', operationVersion: '1', resourceId: CONTACT_RESOURCE,
      arguments: { email: 'ada@replacement.example.test' }
    });

    const beforeRestart = store.state('personal');
    const verifiedOperations = Object.values(beforeRestart.actions)
      .filter(action => action.verification?.status === 'satisfied').length;
    store.close();
    store = new SqliteStore(dbPath);
    const reopened = store.state('personal');
    store.rebuild('personal');
    const replayMatches = isDeepStrictEqual(beforeRestart, reopened) &&
      isDeepStrictEqual(beforeRestart, store.state('personal'));

    return {
      mode: 'synthetic-operations', realExternalEffects: 0,
      verifiedOperations, unknownBlocked, replayMatches
    };
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'behalvo-operations-demo-'));
  try {
    const result = await runOperationsDemo(join(directory, 'operations.db'));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch(error => {
    process.stderr.write(`Operations demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
