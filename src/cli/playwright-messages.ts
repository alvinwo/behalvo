/** English CLI catalog; the project has no runtime locale selection. */
const messages = {
  usage: 'Usage: npm run browser:playwright -- diagnostic|synthetic-actions\n',
  success: 'Synthetic login verified. Browser and temporary profile closed.\n',
  actions_success: 'Synthetic service workflow verified: one booking, authoritative readback, and replay without effects. Browser and temporary profiles closed.\n',
  versions: 'Playwright {playwright}; Chromium {browser}.\n',
  cancelled: 'Browser run cancelled.\n',
  browser_missing: 'Chromium is not installed. Run: npx playwright install chromium\n',
  unsafe_environment: 'Browser run rejected an ambient browser override or debug setting.\n',
  failure: 'Browser run failed.\n',
  cleanup_pending: 'Browser cleanup is unconfirmed. Do not automatically retry.\n',
  receipt: 'Browser receipt: {path}\n'
} as const;
export function playwrightMessage(key: keyof typeof messages, values: Record<string, string> = {}): string {
  return messages[key].replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '');
}
