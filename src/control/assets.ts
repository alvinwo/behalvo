import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ControlAssets } from './http-server.js';

const web = (name: string): string => fileURLToPath(new URL(`./web/${name}`, import.meta.url));

export function loadOwnerControlAssets(): ControlAssets {
  return { html: readFileSync(web('index.html'), 'utf8'), javascript: readFileSync(web('app.js'), 'utf8'), css: readFileSync(web('styles.css'), 'utf8') };
}
