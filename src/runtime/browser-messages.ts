/** English catalog, following teaching-messages; the application has no locale selector yet. */
const messages={
    upgrade:'Browser learning requires explicit maintenance: npm run storage -- upgrade-browser --db <database> --workspace <workspace> [--key-file <key-file>].',
    upgraded:'Browser learning projection upgraded. No browser or model was run.',
    upgradeFailed:'Browser learning projection upgrade failed. The prior projection was retained.',
    stopped:'Browser exploration stopped. No completion or action is claimed. Existing observations are retained; continue in a new turn for fresh evidence.',
    noBrowser:'No browser is connected for this turn. Historical notes can support recall, but require a fresh observation before use.',
} as const;
export function browserMessage(key:keyof typeof messages):string{return messages[key];}
