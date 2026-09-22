import { createHash } from 'node:crypto';
import { parseBrowserGesture, parseBrowserSnapshot, type BrowserBooking,
  type BrowserGestureCommand, type BrowserPageSnapshot, type BrowserSlot } from '../browser/types.js';

export type SyntheticPortalScenario = 'login' | 'security_question' | 'group_roster' |
  'calendar_empty' | 'calendar_match' | 'slot_race' | 'booking_review' | 'challenge' |
  'session_expired' | 'forbidden' | 'rate_limited' | 'terms_changed' | 'unknown' |
  'confirmation' | 'ambiguous_submission' | 'appointment';

export interface SyntheticPortalDurableState {
  version: 1;
  scenario: SyntheticPortalScenario;
  calendarPage: number;
  selectedSlot: BrowserSlot | null;
  durableIntent: { intentId: string; slotId: string } | null;
  booking: BrowserBooking | null;
  mutationCount: number;
  ambiguousSubmission: boolean;
}

export interface SyntheticPortalStateOptions {
  scenario?: SyntheticPortalScenario;
  ambiguousSubmission?: boolean;
}

const slot: BrowserSlot = { id: 'slot-2027-01-04-0900', date: '2027-01-04', time: '09:00', location: 'Beijing' };
const identityDigest = hash('synthetic-owner');
const subjectDigest = hash('synthetic-account');
const rosterDigest = hash('synthetic-group-roster');
const termsDigest = hash('synthetic-terms');
const evidenceDigest = hash('synthetic-slot-evidence');

export class SyntheticPortalState {
  #scenario: SyntheticPortalScenario;
  #calendarPage = 1;
  #selectedSlot: BrowserSlot | null = null;
  #durableIntent: { intentId: string; slotId: string } | null = null;
  #booking: BrowserBooking | null = null;
  #mutationCount = 0;
  readonly #ambiguousSubmission: boolean;

  constructor(options: SyntheticPortalStateOptions = {}) {
    this.#scenario = options.scenario ?? 'login';
    this.#ambiguousSubmission = options.ambiguousSubmission === true;
    this.#initializeTerminalScenario();
  }

  get mutationCount(): number { return this.#mutationCount; }

  setScenario(scenario: SyntheticPortalScenario): void {
    if (!scenarios.has(scenario)) throw new Error('Invalid synthetic portal scenario.');
    this.#scenario = scenario;
    this.#calendarPage = 1;
    this.#selectedSlot = null;
    this.#durableIntent = null;
    this.#booking = null;
    this.#mutationCount = 0;
    this.#initializeTerminalScenario();
  }

  inspect(): BrowserPageSnapshot {
    let snapshot: BrowserPageSnapshot;
    switch (this.#scenario) {
      case 'login': case 'security_question': case 'challenge': case 'session_expired':
      case 'forbidden': case 'rate_limited': case 'terms_changed': case 'unknown':
        snapshot = { state: this.#scenario }; break;
      case 'group_roster':
        snapshot = { state: 'group_roster', identityDigest, subjectDigest, rosterDigest, termsVersion: 'terms-1' }; break;
      case 'calendar_empty':
        snapshot = { state: 'calendar', page: this.#calendarPage, hasNext: false, candidates: [] }; break;
      case 'calendar_match':
        snapshot = { state: 'calendar', page: this.#calendarPage, hasNext: this.#calendarPage === 1,
          candidates: this.#calendarPage === 1 ? [] : [{ ...slot }] }; break;
      case 'slot_race':
        snapshot = { state: 'calendar', page: this.#calendarPage, hasNext: false,
          candidates: this.#selectedSlot ? [] : [{ ...slot }] }; break;
      case 'booking_review':
        if (!this.#selectedSlot) throw new Error('Synthetic portal state is invalid.');
        snapshot = { state: 'booking_review', slot: { ...this.#selectedSlot }, identityDigest, rosterDigest,
          termsDigest, evidenceDigest, appointmentAbsent: true, bookingType: 'new_group_appointment',
          timeZone: 'Asia/Shanghai' }; break;
      case 'confirmation': case 'appointment':
        if (!this.#booking) throw new Error('Synthetic portal state is invalid.');
        snapshot = this.#scenario === 'appointment'
          ? { state: 'appointment', complete: true, booking: { ...this.#booking } }
          : { state: 'confirmation', booking: { ...this.#booking } };
        break;
      case 'ambiguous_submission':
        if (!this.#durableIntent) throw new Error('Synthetic portal state is invalid.');
        snapshot = { state: 'ambiguous_submission', intentId: this.#durableIntent.intentId }; break;
    }
    return parseBrowserSnapshot(snapshot);
  }

  recordDurableIntent(intentId: string, slotId: string): void {
    exactId(intentId); exactId(slotId);
    if (this.#booking) throw new Error('A synthetic booking is already present.');
    if (!this.#availableSlots().some(candidate => candidate.id === slotId) &&
        !(this.#scenario === 'booking_review' && this.#selectedSlot?.id === slotId))
      throw new Error('Synthetic slot is not currently available.');
    this.#durableIntent = { intentId, slotId };
  }

  gesture(value: BrowserGestureCommand): BrowserPageSnapshot {
    const command = parseBrowserGesture(value);
    if (command.kind === 'calendar.next_page') {
      if (this.#scenario !== 'calendar_match' || this.#calendarPage !== 1)
        throw new Error('Synthetic page state does not allow this gesture.');
      this.#calendarPage = 2;
    } else if (command.kind === 'booking.intent') {
      this.recordDurableIntent(command.intentId, command.slotId);
    } else if (command.kind === 'slot.select') {
      if (!['calendar_match', 'slot_race'].includes(this.#scenario) ||
          !this.#availableSlots().some(candidate => candidate.id === command.slotId))
        throw new Error('Synthetic page state does not allow this gesture.');
      if (this.#scenario === 'slot_race') {
        this.#selectedSlot = { ...slot };
        this.#scenario = 'calendar_empty';
      } else {
        this.#selectedSlot = { ...slot };
        this.#scenario = 'booking_review';
      }
    } else if (command.kind === 'booking.submit') {
      if (this.#booking) throw new Error('A synthetic booking is already present.');
      if (this.#scenario !== 'booking_review' || !this.#selectedSlot ||
          command.slotId !== this.#selectedSlot.id || this.#durableIntent?.intentId !== command.intentId ||
          this.#durableIntent.slotId !== command.slotId)
        throw new Error('Synthetic durable intent does not match the booking gesture.');
      this.#booking = { referenceDigest: hash(`reference:${command.intentId}`), status: 'booked', rosterDigest,
        date: this.#selectedSlot.date, time: this.#selectedSlot.time, location: 'Beijing', timeZone: 'Asia/Shanghai' };
      this.#mutationCount++;
      this.#scenario = this.#ambiguousSubmission ? 'ambiguous_submission' : 'confirmation';
    } else {
      const readback = this.authoritativeReadback();
      if (readback.state === 'appointment') this.#scenario = 'appointment';
      return readback;
    }
    return this.inspect();
  }

  authoritativeReadback(): BrowserPageSnapshot {
    if (!this.#booking) return { state: 'calendar', page: this.#calendarPage, hasNext: false, candidates: [] };
    return parseBrowserSnapshot({ state: 'appointment', complete: true, booking: { ...this.#booking } });
  }

  exportDurableState(): SyntheticPortalDurableState {
    return { version: 1, scenario: this.#scenario, calendarPage: this.#calendarPage,
      selectedSlot: this.#selectedSlot ? { ...this.#selectedSlot } : null,
      durableIntent: this.#durableIntent ? { ...this.#durableIntent } : null,
      booking: this.#booking ? { ...this.#booking } : null, mutationCount: this.#mutationCount,
      ambiguousSubmission: this.#ambiguousSubmission };
  }

  static restore(value: SyntheticPortalDurableState): SyntheticPortalState {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join('\0') !== ['version', 'scenario', 'calendarPage', 'selectedSlot',
          'durableIntent', 'booking', 'mutationCount', 'ambiguousSubmission'].sort().join('\0') ||
        value.version !== 1 || !scenarios.has(value.scenario) ||
        !Number.isSafeInteger(value.calendarPage) || value.calendarPage < 1 || value.calendarPage > 100 ||
        !Number.isSafeInteger(value.mutationCount) || value.mutationCount < 0 || value.mutationCount > 1 ||
        typeof value.ambiguousSubmission !== 'boolean') throw new Error('Invalid synthetic portal state.');
    const restored = new SyntheticPortalState({ scenario: 'login', ambiguousSubmission: value.ambiguousSubmission });
    restored.#scenario = value.scenario;
    restored.#calendarPage = value.calendarPage;
    restored.#selectedSlot = value.selectedSlot ? structuredClone(value.selectedSlot) : null;
    restored.#durableIntent = value.durableIntent ? structuredClone(value.durableIntent) : null;
    restored.#booking = value.booking ? structuredClone(value.booking) : null;
    restored.#mutationCount = value.mutationCount;
    restored.inspect();
    if ((restored.#booking === null) !== (restored.#mutationCount === 0)) throw new Error('Invalid synthetic portal state.');
    return restored;
  }

  #availableSlots(): BrowserSlot[] {
    if (this.#scenario === 'slot_race' && !this.#selectedSlot) return [{ ...slot }];
    if (this.#scenario === 'calendar_match' && this.#calendarPage === 2) return [{ ...slot }];
    return [];
  }

  #initializeTerminalScenario(): void {
    if (this.#scenario === 'booking_review') this.#selectedSlot = { ...slot };
    if (this.#scenario === 'confirmation' || this.#scenario === 'appointment' ||
        this.#scenario === 'ambiguous_submission') {
      this.#durableIntent = { intentId: 'synthetic-intent', slotId: slot.id };
      this.#selectedSlot = { ...slot };
      this.#booking = { referenceDigest: hash('synthetic-reference'), status: 'booked', rosterDigest,
        date: slot.date, time: slot.time, location: 'Beijing', timeZone: 'Asia/Shanghai' };
      this.#mutationCount = 1;
    }
  }
}

const scenarios = new Set<SyntheticPortalScenario>(['login', 'security_question', 'group_roster',
  'calendar_empty', 'calendar_match', 'slot_race', 'booking_review', 'challenge', 'session_expired',
  'forbidden', 'rate_limited', 'terms_changed', 'unknown', 'confirmation', 'ambiguous_submission', 'appointment']);

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function exactId(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error('Invalid synthetic identifier.');
}
