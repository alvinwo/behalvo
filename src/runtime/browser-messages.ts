/** English catalog, following teaching-messages; the application has no locale selector yet. */
const messages={
    invalidFixture:'Choose appointments-a, appointments-b or classes for --synthetic-browser; use an online model and omit --synthetic-operations.',
    synthetic:'SYNTHETIC BROWSER EXPLORATION — select a work item with /work, teach its constraints, then ask to explore. No real website or booking is enabled.',
    inputUsage:'Focus a work item, then use /browser-input {"origin":"http://127.0.0.1:port","purpose":"session-period","quote":"exact owner value"}, or /browser-revoke <input-id>.',
    inputSaved:'Browser input authorized for the exact task revision, destination and purpose. Input ID: ',
    inputRevoked:'Browser input authorization revoked.',
    help:'/browser-input <JSON>         Authorize an exact synthetic input value, origin and purpose\n/browser-revoke <input-id>    Revoke that input authorization',

    upgrade:'Browser learning requires explicit maintenance: npm run storage -- upgrade-browser --db <database> --workspace <workspace> [--key-file <key-file>].',
    upgraded:'Browser learning projection upgraded. No browser or model was run.',
    upgradeFailed:'Browser learning projection upgrade failed. The prior projection was retained.',
    stopped:'Browser exploration stopped. No completion or action is claimed. Existing observations are retained; continue in a new turn for fresh evidence.',
    noBrowser:'No browser is connected for this turn. Historical notes can support recall, but require a fresh observation before use.',
} as const;
export function browserMessage(key:keyof typeof messages):string{return messages[key];}
