/** English message catalog, matching the existing CLI catalog convention. */
const messages = {
    saved: 'Task instructions updated. No action was executed.',
    clarification: 'I need clarification before acting on this task.',
    rejected: 'Task instructions were not changed because the teaching request could not be validated. No action was executed.',
    upgrade: 'Task memory requires an explicit storage upgrade. Stop other Behalvo processes, then run: npm run storage -- upgrade-teachings --db <database> --workspace <workspace> [--key-file <key-file>].',
    upgraded: 'Task memory projection upgraded. No actions were executed.',
    upgradeFailed: 'Task memory upgrade failed. No upgrade was completed.'
} as const;
export function teachingMessage(key: keyof typeof messages): string { return messages[key]; }
