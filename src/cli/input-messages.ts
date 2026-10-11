/** English catalog; follows the existing application message helpers. */
const messages = {
  hint: 'Use /help for commands or /paste for a multiline prompt.',
  help: '/paste                        Compose multiple lines; /send submits, /cancel discards',
  start: 'Multiline prompt: paste or enter text. Type /send alone to submit, /cancel to discard. Prefix either marker with \\ to include it literally.',
  continuation: '... > ',
  cancelled: 'Draft discarded. Nothing was sent.',
  empty: 'Empty draft. Nothing was sent.',
  oversized: 'Draft exceeds 64 KiB and will be discarded. Type /send or /cancel to return to the prompt.',
} as const;
export function inputMessage(key: keyof typeof messages): string { return messages[key]; }
