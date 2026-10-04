/** English CLI catalog; the project has no runtime locale selection. */
const messages = {
  usage: 'Usage: npm run browser:playwright -- diagnostic\n',
  success: 'Synthetic login verified. Browser and temporary profile closed.\n',
  versions: 'Playwright {playwright}; Chromium {browser}.\n',
  cancelled: 'Browser diagnostic cancelled.\n',
  browser_missing: 'Chromium is not installed. Run: npx playwright install chromium\n',
  unsafe_environment: 'Browser diagnostic rejected an ambient browser override or debug setting.\n',
  failure: 'Browser diagnostic failed.\n',
  cleanup_pending: 'Browser cleanup is unconfirmed. Do not automatically retry.\n',
  receipt: 'Diagnostic receipt: {path}\n'
} as const;
export function playwrightMessage(key: keyof typeof messages, values: Record<string, string> = {}): string {
  return messages[key].replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '');
}
