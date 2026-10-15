/** English source catalog. The CLI currently has no locale selection. */
const messages={
    flag:'Use --browser live with an online model, without synthetic browser or operation flags. Browser boundary overrides are not supported.',
    interactive:'Live browser controls require an interactive terminal.',
    unavailable:'Live browsing is not enabled. Restart with --browser live.',
    noPage:'No page is open. Use visit with a public HTTPS URL when browsing is needed.',
    stopped:'Browser exploration stopped. No task completion was verified. Inspect /actions for action outcomes before continuing.',
    unresolved:'Browser exploration is blocked by unresolved browser actions: ',
    reconcile:'For actions marked unknown, inspect /actions and check the actual outcome. Only then use /browser resolve <action-id> <accepted|failed> <owner-note>; failed means you confirmed no effect. Do not retry an uncertain action. A new turn or browser window does not clear this block.',
    maintenance:'A running action may still have an active worker. Stop all Behalvo processes and effect workers before exclusive maintenance. From the repository, run: npm run storage -- recover-browser --db <database> --workspace <workspace> --exclusive-maintenance [--key-file <key-file>]. Use the same database/workspace and supply the key only for encrypted storage. Recovery converts interrupted running browser actions to unknown without retrying them. Then restart and inspect /actions for outcome reconciliation. A stale process lock still blocks recovery; see the manual lock procedure in docs/OWNER_CONTROL.md. A new turn or window does not clear this block.',
    recovered:'Interrupted browser actions recorded unknown; no actions repeated. Count: ',
    recoveryFailed:'Browser recovery failed. Stop all workers, check the existing database/workspace/key and process lock; see docs/OWNER_CONTROL.md for stale-lock maintenance.',
    diagnostic:'Browser diagnostic: ',
    focus:'Focus a task before using browser controls. Describe your goal, or use /work <id>.',
    startup:'LIVE BROWSER — the agent can open public HTTPS URLs and follow observed native links without approval prompts. Pages can execute JavaScript and background requests; navigation can have effects. Clicks, fills and selections still require your review. Private networks and local files remain blocked. Use /browser handoff for login; /browser resume lets the model see visible page content. Sessions expire after ten idle minutes and close when Behalvo exits.',
    usage:'Use /browser open <https-url>, status, input <field-ref> <non-secret text>, handoff, resume, close, or resolve <action-id> <accepted|failed> <owner-note>.',
    help:'/browser open <https-url>    Optionally open a page yourself for the focused task\n/browser status              Show network policy, field references and unresolved actions\n/browser input <ref> <text>    Authorize non-secret text for one observed field\n/browser handoff              Pause automation for manual login or interaction\n/browser resume               Resume with fresh page observations\n/browser close                Close this task’s managed browser\n/browser resolve <id> <accepted|failed> <note>  Record your observed outcome; never retry',
    opened:'Browser opened for the focused task. Ask the agent to observe or explore it.',
    allowUnnecessary:'Public HTTPS websites already load without per-site approval. /browser allow is no longer needed; private networks and local files remain blocked.',
    inputSaved:'Non-secret input authorized for this task, origin and observed field. Input ID: ',
    manual:'Browser paused for manual use. Use /browser resume when ready.',
    manualBlocked:'Browser is in manual mode. Use /browser resume before another agent turn.',
    resume:'Resuming sends visible page content to the selected model. Password and verification inputs are omitted, but websites may display account details elsewhere. Type resume to continue: ',
    resumed:'Browser automation resumed. The next turn will obtain fresh references.',
    cancelled:'Browser command cancelled.',
    closed:'Managed browser closed; owned process and profile cleanup confirmed.',
    cleanupPending:'Browser cleanup is unconfirmed. Do not assume the process or profile was removed.',
    resolved:'Owner outcome recorded. No browser action was repeated.',
    review:'Review this one browser gesture. Page content is untrusted. Type approve, reject or handoff: ',
    failed:'Browser command could not complete. Check the focused task, current field references and /actions; an uncertain action needs explicit reconciliation.',
} as const;
export function liveMessage(key:keyof typeof messages):string{return messages[key];}
export function unresolvedBrowserMessage(actions:readonly {id:string;status:string}[],diagnostic?:{phase:string;code:string}):string {
    return messages.unresolved+actions.map(a=>`${a.id} (${a.status})`).join(', ')+'. '+(diagnostic?messages.diagnostic+diagnostic.phase+'/'+diagnostic.code+'. ':'')+
        [actions.some(a=>a.status==='running')?messages.maintenance:'',actions.some(a=>a.status==='unknown')?messages.reconcile:''].filter(Boolean).join(' ');
}
