import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = new URL('../src/control/web/', import.meta.url);
const destination = new URL('../dist/control/web/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ['index.html', 'app.js', 'styles.css']) await copyFile(new URL(name, source), new URL(name, destination));
