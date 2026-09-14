import { loadStorageKeyFile } from '../dist/storage/key-file.js';
import { PiCredentialFileStore } from '../dist/model/pi-auth-store.js';
import { ModelSettingsStore } from '../dist/cli/model-settings.js';

function send(message) {
  if (process.send) process.send(message);
}

function waitForRelease() {
  return new Promise(resolve => {
    const listener = message => {
      if (message?.kind !== 'release') return;
      process.off('message', listener);
      resolve();
    };
    process.on('message', listener);
  });
}

async function main(command) {
  const encryptionKey = loadStorageKeyFile(command.keyPath);
  try {
    if (command.kind === 'settings-write') {
      await new ModelSettingsStore(command.settingsPath, { encryptionKey }).write(command.workspace, {
        provider: 'synthetic', model: command.workspace
      });
    } else {
      const store = new PiCredentialFileStore(command.authPath, { encryptionKey });
      if (command.kind === 'auth-add') {
        await store.modify(command.provider, async () => ({
          type: 'api_key', env: { SYNTHETIC_PROVIDER: command.provider }
        }));
      } else if (command.kind === 'auth-delete') {
        await store.delete(command.provider);
      } else if (command.kind === 'auth-refresh') {
        await store.modify(command.provider, async current => {
          send({ kind: 'entered', access: current?.type === 'oauth' ? current.access : undefined });
          if (command.hold) await waitForRelease();
          if (current?.type !== 'oauth') throw new Error('synthetic fixture expected oauth');
          if (current.expires === 2) return undefined;
          return { ...current, access: 'synthetic-refreshed', refresh: 'synthetic-rotated', expires: 2 };
        });
      }
    }
    send({ kind: 'done' });
  } finally {
    encryptionKey.fill(0);
  }
}

process.once('message', command => {
  main(command).then(
    () => process.exit(0),
    () => {
      process.stderr.write('private model-state synthetic child failed\n');
      process.exit(1);
    }
  );
});
send({ kind: 'ready' });
