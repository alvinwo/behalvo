/** English source catalog. The CLI currently has no locale selection. */
const messages={
    flag:'Use --browser live with an online model, without synthetic browser or operation flags. Browser boundary overrides are not supported.',
    interactive:'Live browser controls require an interactive terminal.',
    unavailable:'Live browsing is not enabled. Restart with --browser live.',
    focus:'Focus a task before using browser controls. Describe your goal, or use /work <id>.',
    startup:'LIVE BROWSER — opening an HTTPS site grants its web application permission to run within that exact origin, including JavaScript and background requests. Agent gestures require your review. Use /browser handoff for login; /browser resume lets the model see visible page content. Sessions expire after ten idle minutes and close when Behalvo exits.',
    usage:'Use /browser open <https-url>, allow <https-origin>, status, input <field-ref> <non-secret text>, handoff, resume, close, or resolve <action-id> <accepted|failed> <owner-note>.',
    help:'/browser open <https-url>    Open an isolated browser for the focused task\n/browser status              Show origins, field references and unresolved actions\n/browser allow <https-origin> Allow one additional exact website origin\n/browser input <ref> <text>    Authorize non-secret text for one observed field\n/browser handoff              Pause automation for manual login or interaction\n/browser resume               Resume with fresh page observations\n/browser close                Close this task’s managed browser\n/browser resolve <id> <accepted|failed> <note>  Record your observed outcome; never retry',
    opened:'Browser opened for the focused task. Ask the agent to observe or explore it.',
    allowed:'Exact origin allowed. Its web application may now run and make background requests.',
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
