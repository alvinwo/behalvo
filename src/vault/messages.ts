const en = {
  help: '/vault [list|init|add|replace <id>|remove <id>|lock|unlock]  Manage private website logins',
  usage: 'Use /vault, /vault init, /vault add, /vault replace <id>, /vault remove <id>, /vault lock or /vault unlock. Enter credentials only in the hidden prompts.',
  setup: 'No vault configured. Start with --vault <file> --vault-key-file <key-file>. See docs/CREDENTIAL_VAULT.md.',
  unavailable: 'Credential vault unavailable.',
  privateInput: 'An interactive terminal with hidden input is required.',
  init: 'Create a new encrypted vault at the configured location? Type yes to create: ',
  initialized: 'Encrypted vault created and unlocked.',
  saved: 'Login saved.', removed: 'Login removed. Older vault copies may still contain it.',
  locked: 'Vault locked.', unlocked: 'Vault unlocked.', empty: 'No saved logins in this workspace.',
  cancelled: 'Vault operation cancelled.',
  origin: 'Website origin (for example https://example.com): ',
  label: 'Account label (no password or username): ',
  username: 'Username (hidden): ', password: 'Password (hidden): ',
  saveUse: 'Save and use a login for {origin} for this task? Type yes to continue: ',
  use: 'Use saved login {label} on {origin} for this task? Type yes to continue: ',
  choose: 'Choose the account number, or press Enter to skip: ',
  remove: 'Remove saved login {label} for {origin}? Type yes to remove: ',
  configuration: 'Invalid credential vault configuration.',
  unknown: 'Synthetic login outcome is unknown. The browser was closed; no retry was performed.',
  signedIn: 'Synthetic login verified. The browser session is closed.',
  rejected: 'The synthetic website rejected this login. The browser session is closed.',
  skipped: 'Login skipped. The browser session is closed.',
  stopped: 'Login stopped before dispatch. The browser session is closed.',
  unavailableLogin: 'Private login is unavailable. Configure and unlock the vault in an interactive terminal.',
  fixture: 'Synthetic login fixture. This page does not access a real account.',
  loginControl: 'Sign in to the synthetic account'
} as const;
export function vaultMessage(key: keyof typeof en, values: Record<string, string> = {}): string {
  return en[key].replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? '');
}
