import { assertOwner } from '../kernel/policy.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { OperationService } from '../operations/service.js';
import { isOperationCommand } from '../operations/validation.js';

/** One terminal session's literal review receipts; model output can never populate them. */
export class ActionReview {
    readonly #displayed = new Map<string, string>();
    constructor(private readonly store: SqliteStore, private readonly service: OperationService,
        private readonly workspaceId: string, private readonly ownerId: string,
        private readonly clock: () => string = () => new Date().toISOString()) {}

    display(workId: string | undefined, write: (line: string) => void): void {
        const state = this.store.state(this.workspaceId);
        assertOwner(state, this.ownerId);
        if (!workId) throw new Error('Focus durable work with /work <id> before /actions');
        const actions = Object.values(state.actions).filter(action => action.workId === workId && isOperationCommand(action.command));
        if (!actions.length) write('No operation actions for focused work.');
        for (const action of actions) {
            const command = action.command;
            if (!isOperationCommand(command)) continue;
            const connection = state.connections[command.connectionId];
            write(JSON.stringify({ actionId: action.id, workId: action.workId, workTitle: state.works[action.workId]?.title,
                status: action.status, synthetic: command.provider === 'synthetic-accounts',
                label: connection?.label, digest: action.digest, command,
                approvalExpiresAt: action.approval?.expiresAt ?? null, verification: action.verification ?? null }));
            // Record only after the exact command has actually been emitted by the terminal.
            this.#displayed.set(action.id, action.digest);
        }
    }

    approve(args: string[], workId: string | undefined): string {
        if (args.length !== 2) throw new Error('Usage: /approve <action-id> <full-digest>');
        const [actionId, digest] = args as [string, string];
        const state = this.store.state(this.workspaceId);
        assertOwner(state, this.ownerId);
        const action = state.actions[actionId];
        if (!workId || !action || action.workId !== workId || !isOperationCommand(action.command))
            throw new Error('Operation action not found in focused work');
        if (this.#displayed.get(actionId) !== action.digest)
            throw new Error('Run /actions to review this exact command in the current terminal before approval');
        if (digest !== action.digest) throw new Error('Approval requires the exact full digest displayed by /actions');
        const now = Date.parse(this.clock());
        if (!Number.isFinite(now)) throw new Error('Invalid approval clock');
        this.service.approveBatch({ workspaceId: this.workspaceId, ownerId: this.ownerId,
            expiresAt: new Date(now + 600000).toISOString(), approvals: [{ actionId, digest }] });
        this.#displayed.delete(actionId);
        return 'Approved for ten minutes. Request execution and verification in a new owner turn; no inference run was resumed.';
    }
}
