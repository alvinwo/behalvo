import type { State, WorkItem } from '../kernel/types.js';
/** English messages for durable task continuity. */
const messages = {
    upgrade: 'Task continuity requires an explicit storage upgrade. Stop other Behalvo processes, then run: npm run storage -- upgrade-continuity --db <database> --workspace <workspace> [--key-file <key-file>].',
    upgraded: 'Task continuity upgraded. No actions were executed.',
    upgradeFailed: 'Task continuity upgrade failed. No upgrade was completed.',
    stoppedSummary: 'The turn stopped before a final progress report was available.',
    stoppedNextStep: 'Review recorded action outcomes and current instructions before continuing.',
    rejected: 'I could not validate the task instructions, so I stopped before acting. Please clarify the task or correction.',
    interrupted: 'Task instructions may have been saved, but this turn did not finish. Continue to resume using the saved instructions.'
} as const;
export function taskMessage(key: keyof typeof messages): string {return messages[key];}
export function taskStatusLines(state: State, work: WorkItem): string[] {
    const progress=state.taskContinuity?.progress[work.id];const lines:string[]=[];
    if(progress){
        lines.push(`  Advisory progress${progress.workRevision!==work.revision?' (stale; task changed)':''}: ${progress.summary}`);
        lines.push(`  Next step: ${progress.nextStep}`);
        if(progress.blocker)lines.push(`  Blocker: ${progress.blocker}`);
    }
    const actions=Object.values(state.actions).filter(a=>a.workId===work.id);
    if(actions.length)lines.push(`  Recorded actions: ${actions.map(a=>`${a.id} [${a.status}]`).join(', ')}`);
    return lines;
}
