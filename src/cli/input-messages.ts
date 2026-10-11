/** English catalog; follows the existing application message helpers. */
const messages = {
  hint: 'Use /help for commands. Paste directly; Enter sends, Ctrl+J adds a newline.',
  help: 'Multiline input: paste directly; Enter sends; Ctrl+J, Alt+Enter or supported Shift+Enter adds a newline; Ctrl+C clears the draft.',
  keys: 'Enter send · Ctrl+J / Alt+Enter newline · Ctrl+C clear · Ctrl+D exit',
  oversized: 'Draft exceeds 64 KiB. Press Ctrl+C to clear it and try a shorter prompt.',
  loggingDisabled: 'Disable PI_TUI_WRITE_LOG, PI_TUI_DEBUG and PI_TUI_DEBUG_REDRAW before starting the interactive editor.',
  busy: 'An input prompt is already active.',
} as const;
export function inputMessage(key: keyof typeof messages): string { return messages[key]; }
