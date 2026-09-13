import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Hold a real SQLite write lock in another process; return only once acquired. */
export function holdSqliteWriteLock(dbPath, milliseconds) {
    const ready = `${dbPath}.${randomUUID()}.ready`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { DatabaseSync } from 'node:sqlite';
        import { writeFileSync } from 'node:fs';
        const db = new DatabaseSync(process.argv[1]);
        db.exec('BEGIN IMMEDIATE');
        writeFileSync(process.argv[2], 'ready');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[3]));
        db.exec('COMMIT');
        db.close();
    `, dbPath, ready, String(milliseconds)], { stdio: 'ignore' });
    const until = Date.now() + 5000;
    while (!existsSync(ready)) {
        if (Date.now() >= until) { child.kill(); throw new Error('SQLite lock test child did not become ready'); }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
    unlinkSync(ready);
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`SQLite lock test child exited ${code}`)));
    });
}
