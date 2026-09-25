import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { publishPrivateFile } from './private-files.js';
import { monitorInstallationState, monitorStorageIdentity, setMonitorInstallationActive, validateStorage } from './sqlite-schema.js';
import { verifyEncryptedDatabase } from './sqlite-validation.js';

/** @internal Creates and verifies one encrypted standalone SQLite snapshot. */
export async function backupEncryptedStore(
  sourceDb: DatabaseSync,
  encryptionKey: Uint8Array,
  destination: string
): Promise<void> {
  await publishPrivateFile(destination, async stagedPath => {
    await sqliteBackup(sourceDb, stagedPath);
    const writable = new DatabaseSync(stagedPath);
    try {
      const cipher = validateStorage(writable, encryptionKey);
      if (!cipher) throw new Error('Encrypted storage is required.');
      if (monitorInstallationState(writable, cipher)) {
        writable.exec('BEGIN IMMEDIATE');
        try {
          setMonitorInstallationActive(writable, cipher, false, true, monitorStorageIdentity(stagedPath));
          writable.exec('COMMIT');
        } catch (error) {
          writable.exec('ROLLBACK');
          throw error;
        }
      }
    } finally {
      writable.close();
    }
    const snapshot = new DatabaseSync(stagedPath, { readOnly: true });
    try {
      const cipher = validateStorage(snapshot, encryptionKey);
      if (!cipher) throw new Error('Encrypted storage is required.');
      verifyEncryptedDatabase(snapshot, cipher);
    } finally {
      snapshot.close();
    }
  }, { sqlite: true });
}
