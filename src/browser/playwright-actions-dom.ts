import type { ElementHandle, Page } from 'playwright';
import { parseBrowserGesture, parseBrowserSnapshot, type BrowserGestureCommand, type BrowserPageSnapshot } from './types.js';
import { PlaywrightDiagnosticError } from './playwright-errors.js';

export async function capturePlaywrightSource(page: Page): Promise<{
  root: ElementHandle<HTMLElement>; snapshot: BrowserPageSnapshot
}> {
  if (await page.locator('[data-behalvo-page-state]').count() !== 1) throw new PlaywrightDiagnosticError('page_rejected');
  const root = await page.$('main[data-behalvo-page-state]');
  if (!root) throw new PlaywrightDiagnosticError('page_rejected');
  try {
    const raw = await root.evaluate(root => {
      const fail = (): never => { throw new Error('page_rejected'); };
      if (!root.isConnected || root.ownerDocument !== document) fail();
      const attr = (name: string, element: Element = root): string => {
        const value = element.getAttribute(`data-behalvo-${name}`);
        if (value === null || value.length > 256) fail(); return value!;
      };
      const boolean = (name: string): boolean => {
        const value = attr(name); if (value !== 'true' && value !== 'false') fail(); return value === 'true';
      };
      const one = (selector: string): Element => {
        const values = root.querySelectorAll(selector); if (values.length !== 1) fail(); return values[0]!;
      };
      const slot = (element: Element) => ({ id: attr('slot-id', element), date: attr('date', element),
        time: attr('time', element), location: attr('location', element) });
      const state = attr('page-state');
      if (state === 'calendar') {
        const elements = [...root.querySelectorAll('button[data-behalvo-gesture="slot.select"]')];
        if (elements.length > 64 || new Set(elements.map(e => attr('slot-id', e))).size !== elements.length) fail();
        const hasNext = boolean('has-next'); one('button[data-behalvo-gesture="calendar.first_page"]');
        if (root.querySelectorAll('button[data-behalvo-gesture="calendar.next_page"]').length !== (hasNext ? 1 : 0)) fail();
        const intents = [...root.querySelectorAll('button[data-behalvo-gesture="booking.intent"]')];
        if (intents.length !== elements.length || elements.some(e =>
          intents.filter(i => i.getAttribute('data-behalvo-intent-slot') === attr('slot-id', e)).length !== 1)) fail();
        if (!/^[1-9][0-9]{0,2}$/.test(attr('page')) || attr('contract-version') !== '1') fail();
        return { state, contractVersion: 1, location: attr('location'), timeZone: attr('time-zone'),
          startDate: attr('start-date'), endDate: attr('end-date'), identityDigest: attr('identity-digest'),
          subjectDigest: attr('subject-digest'), rosterDigest: attr('roster-digest'), termsDigest: attr('terms-digest'),
          termsVersion: attr('terms-version'), appointmentAbsent: boolean('appointment-absent'),
          page: Number(attr('page')), hasNext, candidates: elements.map(e => ({ ...slot(e), evidenceDigest: attr('evidence-digest', e) })) };
      }
      if (state === 'group_roster') return { state, identityDigest: attr('identity-digest'),
        subjectDigest: attr('subject-digest'), rosterDigest: attr('roster-digest'), termsVersion: attr('terms-version') };
      if (state === 'booking_review') return { state, slot: slot(one('[data-behalvo-review-slot]')),
        identityDigest: attr('identity-digest'), rosterDigest: attr('roster-digest'), termsDigest: attr('terms-digest'),
        evidenceDigest: attr('evidence-digest'), appointmentAbsent: boolean('appointment-absent'),
        bookingType: attr('booking-type'), timeZone: attr('time-zone') };
      if (state === 'confirmation' || state === 'appointment') return { state,
        ...(state === 'appointment' ? { complete: boolean('complete') } : {}), booking: {
          referenceDigest: attr('reference-digest'), status: attr('status'), rosterDigest: attr('roster-digest'),
          date: attr('date'), time: attr('time'), location: attr('location'), timeZone: attr('time-zone') } };
      if (state === 'ambiguous_submission') return { state, intentId: attr('intent-id') };
      return { state };
    });
    if (Buffer.byteLength(JSON.stringify(raw)) > 32_768) throw new PlaywrightDiagnosticError('page_rejected');
    return { root: root as ElementHandle<HTMLElement>, snapshot: parseBrowserSnapshot(raw) };
  } catch { await root.dispose().catch(() => {}); throw new PlaywrightDiagnosticError('page_rejected'); }
}

export interface PreparedPlaywrightForm {
  root: ElementHandle<HTMLElement>;
  form: ElementHandle<HTMLFormElement>;
  button: ElementHandle<HTMLButtonElement>;
}
export async function preparePlaywrightForm(root: ElementHandle<HTMLElement>, input: BrowserGestureCommand): Promise<PreparedPlaywrightForm> {
  const command = parseBrowserGesture(input);
  let selector = `button[data-behalvo-gesture="${command.kind}"]`;
  if ('slotId' in command) selector += command.kind === 'booking.intent'
    ? `[data-behalvo-intent-slot="${command.slotId}"]` : `[data-behalvo-slot-id="${command.slotId}"]`;
  if (command.kind === 'booking.submit') selector += `[data-behalvo-intent-id="${command.intentId}"]`;
  const buttons = await root.$$(selector);
  if (buttons.length !== 1) {
    await Promise.allSettled(buttons.map(b => b.dispose())); throw new PlaywrightDiagnosticError('page_rejected');
  }
  const button = buttons[0]! as ElementHandle<HTMLButtonElement>;
  try {
    const handle = await button.evaluateHandle(button => button.form);
    const form = handle.asElement() as ElementHandle<HTMLFormElement> | null;
    if (!form) { await handle.dispose(); throw new PlaywrightDiagnosticError('page_rejected'); }
    return { root, form, button };
  } catch { await button.dispose().catch(() => {}); throw new PlaywrightDiagnosticError('page_rejected'); }
}

/** Fixed code only; the exact browser request still requires a separate route permit. */
export async function activatePlaywrightForm(prepared: PreparedPlaywrightForm, command: BrowserGestureCommand,
  dispatchToken: string): Promise<void> {
  await prepared.form.evaluate((form, { root, button, command, dispatchToken }) => {
    const fail = (): never => { throw new Error('page_rejected'); };
    if (!root.isConnected || root.ownerDocument !== document ||
        document.querySelectorAll('[data-behalvo-page-state]').length !== 1 ||
        document.querySelector('main[data-behalvo-page-state]') !== root ||
        !root.contains(form) || !root.contains(button) || !form.isConnected || form.ownerDocument !== document || button.form !== form || !button.isConnected ||
        form.method !== 'post' || form.action !== 'http://127.0.0.1:43117/gesture' ||
        form.enctype !== 'application/x-www-form-urlencoded' || !['', '_self'].includes(form.target) ||
        button.type !== 'submit' || button.disabled || ['formaction', 'formmethod', 'formtarget', 'formenctype']
          .some(name => button.hasAttribute(name))) fail();
    const entries = [...new FormData(form).entries()];
    const expected = Object.entries(command);
    if (entries.length !== expected.length || new Set(entries.map(([key]) => key)).size !== entries.length ||
        expected.some(([key, value]) => entries.find(([field]) => field === key)?.[1] !==
          (command.kind === 'booking.intent' && key === 'intentId' ? '' : value))) fail();
    if (command.kind === 'booking.intent') {
      const inputs = form.querySelectorAll<HTMLInputElement>('input[name="intentId"]');
      if (inputs.length !== 1) fail(); inputs[0]!.value = command.intentId;
    }
    const token = document.createElement('input'); token.type = 'hidden';
    token.name = '_behalvo_dispatch'; token.value = dispatchToken; form.append(token);
    form.requestSubmit(button);
  }, { root: prepared.root, button: prepared.button, command, dispatchToken });
}
