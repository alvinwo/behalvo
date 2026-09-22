import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseBrowserGesture, type BrowserGestureCommand, type BrowserPageSnapshot,
  type BrowserSlot } from '../browser/types.js';
import { SyntheticPortalState } from './state.js';

export interface SyntheticPortalServer {
  origin: string;
  state: SyntheticPortalState;
  close(): Promise<void>;
}

export async function startSyntheticPortal(input: { state?: SyntheticPortalState; port?: number } = {}):
  Promise<SyntheticPortalServer> {
  const state = input.state ?? new SyntheticPortalState();
  const port = input.port ?? 43117;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid synthetic portal port.');
  let exactOrigin = '';
  const server = createServer((request, response) => {
    void handle(request, response, state, exactOrigin).catch(() => safeError(response, 400));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Synthetic portal failed to bind.'); }
  exactOrigin = `http://127.0.0.1:${address.port}`;
  return { origin: exactOrigin, state, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(new Error('Synthetic portal failed to close.')) : resolve());
  }) };
}

async function handle(request: IncomingMessage, response: ServerResponse, state: SyntheticPortalState,
  origin: string): Promise<void> {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");
  if (request.headers.host !== origin.slice('http://'.length)) return safeError(response, 400);
  const path = new URL(request.url ?? '/', origin).pathname;
  if (request.method === 'GET' && path === '/api/state') return json(response, 200, state.inspect());
  if (request.method === 'POST' && path === '/api/gesture') {
    if (request.headers.origin !== origin) return safeError(response, 403);
    const body = await readBody(request, 8 * 1024);
    return json(response, 200, state.gesture(parseBrowserGesture(JSON.parse(body))));
  }
  if (request.method === 'POST' && path === '/api/intent') {
    if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json')
      return safeError(response, 403);
    const value = JSON.parse(await readBody(request, 8 * 1024)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join('\0') !== ['intentId', 'slotId'].sort().join('\0'))
      throw new Error('Invalid synthetic intent.');
    const item = value as Record<string, unknown>;
    if (typeof item.intentId !== 'string' || typeof item.slotId !== 'string')
      throw new Error('Invalid synthetic intent.');
    state.recordDurableIntent(item.intentId, item.slotId);
    return json(response, 200, state.inspect());
  }
  if (request.method === 'POST' && path === '/gesture') {
    if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/x-www-form-urlencoded')
      return safeError(response, 403);
    state.gesture(parseFormGesture(await readBody(request, 8 * 1024)));
    response.writeHead(303, { location: '/', 'content-length': 0 }); response.end(); return;
  }
  if (request.method === 'GET' && path === '/') {
    const snapshot = state.inspect();
    const status = snapshot.state === 'forbidden' ? 403 : snapshot.state === 'rate_limited' ? 429 : 200;
    const encoded = Buffer.from(render(snapshot, state.exportDurableState().durableIntent), 'utf8');
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': encoded.length });
    response.end(encoded); return;
  }
  safeError(response, 404);
}

function render(snapshot: BrowserPageSnapshot, intent: { intentId: string; slotId: string } | null): string {
  const attributes: string[] = [`data-behalvo-page-state="${attribute(snapshot.state)}"`];
  const controls: string[] = [];
  if (snapshot.state === 'group_roster') attributes.push(
    `data-behalvo-identity-digest="${snapshot.identityDigest}"`,
    `data-behalvo-subject-digest="${snapshot.subjectDigest}"`,
    `data-behalvo-roster-digest="${snapshot.rosterDigest}"`,
    `data-behalvo-terms-version="${attribute(snapshot.termsVersion)}"`);
  if (snapshot.state === 'calendar') {
    attributes.push(`data-behalvo-page="${snapshot.page}"`, `data-behalvo-has-next="${snapshot.hasNext}"`);
    if (snapshot.hasNext) controls.push(form({ kind: 'calendar.next_page' },
      'data-behalvo-gesture="calendar.next_page"', 'Next'));
    for (const candidate of snapshot.candidates) controls.push(slotForm(candidate), intentForm(candidate));
  }
  if (snapshot.state === 'booking_review') {
    attributes.push(`data-behalvo-identity-digest="${snapshot.identityDigest}"`,
      `data-behalvo-roster-digest="${snapshot.rosterDigest}"`,
      `data-behalvo-terms-digest="${snapshot.termsDigest}"`,
      `data-behalvo-evidence-digest="${snapshot.evidenceDigest}"`,
      'data-behalvo-appointment-absent="true"',
      'data-behalvo-booking-type="new_group_appointment"',
      'data-behalvo-time-zone="Asia/Shanghai"');
    controls.push(slotMarkup(snapshot.slot, 'data-behalvo-review-slot'));
    if (intent?.slotId === snapshot.slot.id) controls.push(form({ kind: 'booking.submit',
      slotId: snapshot.slot.id, intentId: intent.intentId },
    `data-behalvo-gesture="booking.submit" data-behalvo-slot-id="${attribute(snapshot.slot.id)}" ` +
      `data-behalvo-intent-id="${attribute(intent.intentId)}"`, 'Submit'));
  }
  if (snapshot.state === 'confirmation' || snapshot.state === 'appointment') {
    bookingAttributes(attributes, snapshot.booking);
    if (snapshot.state === 'appointment') attributes.push('data-behalvo-complete="true"');
  }
  if (snapshot.state === 'ambiguous_submission')
    attributes.push(`data-behalvo-intent-id="${attribute(snapshot.intentId)}"`);
  if (snapshot.state === 'confirmation' || snapshot.state === 'ambiguous_submission' || snapshot.state === 'appointment')
    controls.push(form({ kind: 'appointment.readback' },
      'data-behalvo-gesture="appointment.readback"', 'Read appointment'));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic scheduling portal</title></head>` +
    `<body><main ${attributes.join(' ')}><h1>Synthetic scheduling portal</h1>${controls.join('')}</main></body></html>`;
}

function slotForm(slot: BrowserSlot): string {
  return form({ kind: 'slot.select', slotId: slot.id },
    `data-behalvo-gesture="slot.select" ${slotAttributes(slot)}`, 'Select');
}

function intentForm(slot: BrowserSlot): string {
  return `<form method="post" action="/gesture"><input type="hidden" name="kind" value="booking.intent">` +
    `<input type="hidden" name="slotId" value="${attribute(slot.id)}">` +
    `<input type="hidden" name="intentId" value="" data-behalvo-intent-input="${attribute(slot.id)}">` +
    `<button type="submit" data-behalvo-gesture="booking.intent" ` +
    `data-behalvo-intent-slot="${attribute(slot.id)}">Record intent</button></form>`;
}

function slotMarkup(slot: BrowserSlot, marker = ''): string {
  return `<div ${marker} ${slotAttributes(slot)}>Synthetic slot</div>`;
}

function slotAttributes(slot: BrowserSlot): string {
  return `data-behalvo-slot-id="${attribute(slot.id)}" data-behalvo-date="${slot.date}" ` +
    `data-behalvo-time="${slot.time}" data-behalvo-location="${slot.location}"`;
}

function bookingAttributes(attributes: string[], booking: Extract<BrowserPageSnapshot,
  { state: 'confirmation' | 'appointment' }>['booking']): void {
  attributes.push(`data-behalvo-reference-digest="${booking.referenceDigest}"`,
    `data-behalvo-roster-digest="${booking.rosterDigest}"`, `data-behalvo-date="${booking.date}"`,
    `data-behalvo-time="${booking.time}"`, `data-behalvo-status="${booking.status}"`,
    `data-behalvo-location="${booking.location}"`, `data-behalvo-time-zone="${booking.timeZone}"`);
}

function form(command: BrowserGestureCommand, buttonAttributes: string, label: string): string {
  const fields = Object.entries(command).map(([key, value]) =>
    `<input type="hidden" name="${attribute(key)}" value="${attribute(value)}">`).join('');
  return `<form method="post" action="/gesture">${fields}<button type="submit" ${buttonAttributes}>${label}</button></form>`;
}

function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function parseFormGesture(body: string): BrowserGestureCommand {
  const fields = new URLSearchParams(body);
  const entries = [...fields.entries()];
  if (entries.some(([key], index) => entries.findIndex(([candidate]) => candidate === key) !== index))
    throw new Error('Invalid synthetic gesture.');
  return parseBrowserGesture(Object.fromEntries(entries));
}

async function readBody(request: IncomingMessage, maximum: number): Promise<string> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maximum) throw new Error('Synthetic request is too large.');
    chunks.push(bytes);
  }
  if (total < 1) throw new Error('Synthetic request is empty.');
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  response.end(body);
}

function safeError(response: ServerResponse, status: number): void {
  if (response.headersSent) { response.destroy(); return; }
  json(response, status, { error: 'Synthetic portal request was rejected.' });
}
