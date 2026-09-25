import { exactObject } from '../../operations/validation.js';
import {
  US_VISA_CHINA_CONTRACT_VERSION,
  type UsVisaChinaBooking,
  type UsVisaChinaCandidate,
  type UsVisaChinaPageState,
  type UsVisaChinaRecognition
} from './types.js';

const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error('Visa page contract changed.');
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Visa page contract changed.');
  return value;
}

function page(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100)
    throw new Error('Visa page contract changed.');
  return value as number;
}

function candidate(value: unknown): UsVisaChinaCandidate {
  exactObject(value, ['id', 'date', 'time', 'location', 'timeZone', 'rosterDigest', 'evidenceDigest'], 'visa candidate');
  if (typeof value.id !== 'string' || !IDENTIFIER.test(value.id) || value.location !== 'Beijing' ||
      value.timeZone !== 'Asia/Shanghai' || typeof value.date !== 'string' || typeof value.time !== 'string' ||
      !validDate(value.date) || !validTime(value.time)) throw new Error('Visa page contract changed.');
  return { id: value.id, date: value.date, time: value.time, location: 'Beijing', timeZone: 'Asia/Shanghai',
    rosterDigest: digest(value.rosterDigest), evidenceDigest: digest(value.evidenceDigest) };
}

function booking(value: unknown): UsVisaChinaBooking {
  exactObject(value, ['referenceDigest', 'status', 'date', 'time', 'location', 'timeZone', 'rosterDigest'],
    'visa booking');
  if (value.status !== 'booked' || value.location !== 'Beijing' || value.timeZone !== 'Asia/Shanghai' ||
      typeof value.date !== 'string' || typeof value.time !== 'string' || !validDate(value.date) ||
      !validTime(value.time)) throw new Error('Visa page contract changed.');
  return { referenceDigest: digest(value.referenceDigest), status: 'booked', date: value.date, time: value.time,
    location: 'Beijing', timeZone: 'Asia/Shanghai', rosterDigest: digest(value.rosterDigest) };
}

export function recognizeUsVisaChinaPageState(value: unknown): UsVisaChinaRecognition {
  try { return { result: 'recognized', state: parseUsVisaChinaPageState(value) }; }
  catch { return { result: 'contract_changed' }; }
}

export function parseUsVisaChinaPageState(value: unknown): UsVisaChinaPageState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Visa page contract changed.');
  const item = value as Record<string, unknown>;
  if (item.contractVersion !== US_VISA_CHINA_CONTRACT_VERSION || typeof item.stateId !== 'string')
    throw new Error('Visa page contract changed.');
  const base = { contractVersion: US_VISA_CHINA_CONTRACT_VERSION } as const;
  switch (item.stateId) {
    case 'login':
      exactObject(item, ['contractVersion', 'stateId', 'usernameFieldPresent', 'passwordFieldPresent', 'submitPresent'], 'visa login');
      if (item.usernameFieldPresent !== true || item.passwordFieldPresent !== true || item.submitPresent !== true)
        throw new Error('Visa page contract changed.');
      return { ...base, stateId: 'login', usernameFieldPresent: true,
        passwordFieldPresent: true, submitPresent: true };
    case 'security_question':
      exactObject(item, ['contractVersion', 'stateId', 'answerFieldPresent', 'submitPresent'], 'visa security question');
      if (item.answerFieldPresent !== true || item.submitPresent !== true)
        throw new Error('Visa page contract changed.');
      return { ...base, stateId: 'security_question', answerFieldPresent: true, submitPresent: true };
    case 'identity':
      exactObject(item, ['contractVersion', 'stateId', 'identityDigest'], 'visa identity');
      return { ...base, stateId: 'identity', identityDigest: digest(item.identityDigest) };
    case 'group_roster':
      exactObject(item, ['contractVersion', 'stateId', 'rosterDigest', 'memberCount', 'complete'], 'visa roster');
      if (item.complete !== true || !Number.isSafeInteger(item.memberCount) || (item.memberCount as number) < 1 ||
          (item.memberCount as number) > 20) throw new Error('Visa page contract changed.');
      return { ...base, stateId: 'group_roster', rosterDigest: digest(item.rosterDigest),
        memberCount: item.memberCount as number, complete: true };
    case 'appointment_absence':
      exactObject(item, ['contractVersion', 'stateId', 'absent', 'complete'], 'visa appointment absence');
      if (item.absent !== true || item.complete !== true) throw new Error('Visa page contract changed.');
      return { ...base, stateId: 'appointment_absence', absent: true, complete: true };
    case 'terms':
      exactObject(item, ['contractVersion', 'stateId', 'termsDigest', 'decisionRequired'], 'visa terms');
      return { ...base, stateId: 'terms', termsDigest: digest(item.termsDigest),
        decisionRequired: boolean(item.decisionRequired) };
    case 'calendar_coverage':
      exactObject(item, ['contractVersion', 'stateId', 'location', 'timeZone', 'startDate', 'endDate',
        'page', 'hasNext', 'candidatesPresent'], 'visa calendar coverage');
      if (item.location !== 'Beijing' || item.timeZone !== 'Asia/Shanghai' || item.startDate !== '2026-12-15' ||
          item.endDate !== '2027-01-31') throw new Error('Visa page contract changed.');
      return { ...base, stateId: 'calendar_coverage', location: 'Beijing', timeZone: 'Asia/Shanghai',
        startDate: '2026-12-15', endDate: '2027-01-31', page: page(item.page),
        hasNext: boolean(item.hasNext), candidatesPresent: boolean(item.candidatesPresent) };
    case 'candidate':
      exactObject(item, ['contractVersion', 'stateId', 'candidate'], 'visa candidate page');
      return { ...base, stateId: 'candidate', candidate: candidate(item.candidate) };
    case 'pre_mutation_review':
      exactObject(item, ['contractVersion', 'stateId', 'candidate', 'rosterDigest', 'appointmentAbsent', 'bookingType'],
        'visa pre-mutation review');
      if (item.appointmentAbsent !== true || item.bookingType !== 'new_group_appointment')
        throw new Error('Visa page contract changed.');
      return { ...base, stateId: 'pre_mutation_review', candidate: candidate(item.candidate),
        rosterDigest: digest(item.rosterDigest), appointmentAbsent: true, bookingType: 'new_group_appointment' };
    case 'submitted':
      exactObject(item, ['contractVersion', 'stateId', 'intentDigest', 'status'], 'visa submitted');
      if (item.status !== 'submitted' && item.status !== 'ambiguous') throw new Error('Visa page contract changed.');
      return { ...base, stateId: 'submitted', intentDigest: digest(item.intentDigest), status: item.status };
    case 'confirmation':
      exactObject(item, ['contractVersion', 'stateId', 'booking'], 'visa confirmation');
      return { ...base, stateId: 'confirmation', booking: booking(item.booking) };
    case 'authoritative_readback':
      exactObject(item, ['contractVersion', 'stateId', 'complete', 'booking'], 'visa readback');
      if (item.complete !== true) throw new Error('Visa page contract changed.');
      return { ...base, stateId: 'authoritative_readback', complete: true, booking: booking(item.booking) };
    default: throw new Error('Visa page contract changed.');
  }
}

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

export function validTime(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour! >= 0 && hour! <= 23 && minute! >= 0 && minute! <= 59;
}

export function parseUsVisaChinaCandidate(value: unknown): UsVisaChinaCandidate { return candidate(value); }
