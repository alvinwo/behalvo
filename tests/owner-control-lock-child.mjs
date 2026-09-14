import { acquireLocalProcessLock } from '../dist/storage/process-lock.js';
import { openLocalAgent } from '../dist/index.js';

const [kind, dbPath] = process.argv.slice(2);
let close;
if (kind === 'lock') {
    const lock = acquireLocalProcessLock(dbPath);
    close = () => lock.release();
} else if (kind === 'local' || kind === 'local-synthetic') {
    const gateway = { async listModels() { return [{ provider: 'fake', model: 'one' }]; },
        async complete() { return { text: '{"reply":"unused","workProposals":[],"factProposals":[]}' }; } };
    const app = openLocalAgent({ dbPath,
        workspaceId: kind === 'local-synthetic' ? 'owner-control-demo' : 'child',
        ownerId: 'owner', gateways: [gateway], syntheticOperations: kind === 'local-synthetic' });
    close = () => app.close();
} else {
    throw new Error('Unknown child mode');
}
process.stdout.write('READY\n');
process.stdin.resume();
process.stdin.once('end', () => { close(); });
