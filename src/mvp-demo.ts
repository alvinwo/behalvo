import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeModelGateway } from './model/fake-gateway.js';
import { openLocalAgent } from './cli/local-app.js';

export interface MvpDemoResult {
  firstReply: string;
  secondReply: string;
  workPhase: string;
  workThreadIds: string[];
  departureDate: string;
  rawOwnerMessage: string;
  actionCount: number;
  journalCount: number;
}

export async function runMvpDemo(dbPath: string): Promise<MvpDemoResult> {
  const firstGateway = new FakeModelGateway(
    [{ provider: 'offline', model: 'demo' }],
    () => ({
      text: JSON.stringify({
        reply: 'I will track your Maui preparation.',
        workProposals: [{ id: 'maui-trip', title: 'Prepare for Maui', goal: 'Be ready before departure' }],
        factProposals: [{
          id: 'maui-departure', subject: 'maui-trip', predicate: 'departure_date', value: '2026-09-12',
          validFrom: '2026-09-07T00:00:00.000Z'
        }]
      })
    })
  );

  const first = openLocalAgent({ dbPath, workspaceId: 'personal', ownerId: 'owner', gateways: [firstGateway] });
  await first.registry.select('offline', 'demo');
  const firstTurn = await first.service.runOwnerTurn({
    workspaceId: 'personal', ownerId: 'owner', threadId: 'thread-before-restart', externalId: 'owner-turn-1',
    text: 'I am going to Maui on September 12.', model: { provider: 'offline', model: 'demo' }
  });
  first.close();

  const secondGateway = new FakeModelGateway(
    [{ provider: 'offline', model: 'demo' }],
    request => {
      if (!request.prompt.includes('Prepare for Maui') || !request.prompt.includes('2026-09-12'))
        throw new Error('Restarted context did not contain durable Maui state');
      if (request.prompt.includes('I am going to Maui on September 12.'))
        throw new Error('New thread unexpectedly loaded the old raw transcript');
      return {
        text: JSON.stringify({
          reply: 'Your Maui preparation is still open and departs on 2026-09-12.',
          workProposals: [], factProposals: []
        })
      };
    }
  );
  const second = openLocalAgent({ dbPath, workspaceId: 'personal', ownerId: 'owner', gateways: [secondGateway] });
  await second.registry.select('offline', 'demo');
  const secondTurn = await second.service.runOwnerTurn({
    workspaceId: 'personal', ownerId: 'owner', threadId: 'thread-after-restart', externalId: 'owner-turn-2',
    text: 'What is the status of that trip?', model: { provider: 'offline', model: 'demo' }, workId: 'maui-trip'
  });

  const state = second.store.state('personal');
  const ownerRaw = second.store.threadMessages('personal', 'thread-before-restart', 20)
    .find(record => record.event.type === 'message.received' && record.event.data.senderRole === 'owner');
  if (!ownerRaw || ownerRaw.event.type !== 'message.received')
    throw new Error('Original owner message was not retained');
  const result: MvpDemoResult = {
    firstReply: firstTurn.turn.reply,
    secondReply: secondTurn.turn.reply,
    workPhase: state.works['maui-trip']!.phase,
    workThreadIds: [...state.works['maui-trip']!.threadIds],
    departureDate: state.facts['maui-departure']!.value,
    rawOwnerMessage: second.store.readArtifact('personal', ownerRaw.event.data.artifactId),
    actionCount: Object.keys(state.actions).length,
    journalCount: second.store.journal('personal').length
  };
  second.close();
  return result;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'personal-operator-mvp-demo-'));
  try {
    const result = await runMvpDemo(join(dir, 'agent.db'));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch(error => {
    process.stderr.write(`MVP demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
