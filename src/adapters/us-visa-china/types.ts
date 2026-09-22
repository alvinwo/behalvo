import type { TrustedExecutionFence } from '../../operations/execution-context.js';

export const US_VISA_CHINA_ADAPTER_ID = 'us-visa-china' as const;
export const US_VISA_CHINA_ADAPTER_VERSION = 1 as const;
export const US_VISA_CHINA_CONTRACT_VERSION = 1 as const;
export const US_VISA_CHINA_STATE_IDS = Object.freeze([
  'login', 'security_question', 'identity', 'group_roster', 'appointment_absence', 'terms',
  'calendar_coverage', 'candidate', 'pre_mutation_review', 'submitted', 'confirmation',
  'authoritative_readback'
] as const);

export type UsVisaChinaStateId = typeof US_VISA_CHINA_STATE_IDS[number];

export interface UsVisaChinaScope {
  bookingType: 'new_group_appointment';
  location: 'Beijing';
  timeZone: 'Asia/Shanghai';
  startDate: '2026-12-15';
  endDate: '2027-01-31';
  eligibleTimes: 'any_offered_working_time';
  selection: 'earliest';
  maximumEffects: 1;
  provider: 'visa-scheduling';
  providerSubject: string;
  resourceId: 'group-appointment';
  identityDigest: string;
  rosterDigest: string;
  termsDigest: string;
}

export interface UsVisaChinaCandidate {
  id: string;
  date: string;
  time: string;
  location: 'Beijing';
  timeZone: 'Asia/Shanghai';
  rosterDigest: string;
  evidenceDigest: string;
}

export interface UsVisaChinaCoverage {
  contractVersion: 1;
  location: 'Beijing';
  timeZone: 'Asia/Shanghai';
  startDate: '2026-12-15';
  endDate: '2027-01-31';
  firstPage: number;
  lastPage: number;
  inspectedPages: number[];
  paginationComplete: true;
  appointmentAbsent: true;
  identityDigest: string;
  rosterDigest: string;
  termsDigest: string;
}

export interface UsVisaChinaBooking {
  referenceDigest: string;
  status: 'booked';
  date: string;
  time: string;
  location: 'Beijing';
  timeZone: 'Asia/Shanghai';
  rosterDigest: string;
}

export type UsVisaChinaPageState =
  | { contractVersion: 1; stateId: 'login'; usernameFieldPresent: boolean; passwordFieldPresent: boolean;
      submitPresent: boolean }
  | { contractVersion: 1; stateId: 'security_question'; answerFieldPresent: boolean; submitPresent: boolean }
  | { contractVersion: 1; stateId: 'identity'; identityDigest: string }
  | { contractVersion: 1; stateId: 'group_roster'; rosterDigest: string; memberCount: number; complete: true }
  | { contractVersion: 1; stateId: 'appointment_absence'; absent: true; complete: true }
  | { contractVersion: 1; stateId: 'terms'; termsDigest: string; decisionRequired: boolean }
  | { contractVersion: 1; stateId: 'calendar_coverage'; location: 'Beijing'; timeZone: 'Asia/Shanghai';
      startDate: '2026-12-15'; endDate: '2027-01-31'; page: number; hasNext: boolean;
      candidatesPresent: boolean }
  | { contractVersion: 1; stateId: 'candidate'; candidate: UsVisaChinaCandidate }
  | { contractVersion: 1; stateId: 'pre_mutation_review'; candidate: UsVisaChinaCandidate;
      rosterDigest: string; appointmentAbsent: true; bookingType: 'new_group_appointment' }
  | { contractVersion: 1; stateId: 'submitted'; intentDigest: string; status: 'submitted' | 'ambiguous' }
  | { contractVersion: 1; stateId: 'confirmation'; booking: UsVisaChinaBooking }
  | { contractVersion: 1; stateId: 'authoritative_readback'; complete: true; booking: UsVisaChinaBooking };

export type UsVisaChinaRecognition =
  | { result: 'recognized'; state: UsVisaChinaPageState }
  | { result: 'contract_changed' };

export interface UsVisaChinaPreflight {
  appointmentAbsent: boolean;
  identityDigest: string;
  rosterDigest: string;
  termsDigest: string;
  candidate: UsVisaChinaCandidate;
}

export interface UsVisaChinaSyntheticPortalPort {
  inspect(): unknown | Promise<unknown>;
  recordDurableIntent(intentId: string, slotId: string): void | Promise<void>;
  gesture(command: unknown): unknown | Promise<unknown>;
}

export interface UsVisaChinaExecutionInput {
  action: unknown;
  portal: UsVisaChinaSyntheticPortalPort;
  expected: { identityDigest: string; rosterDigest: string; termsDigest: string };
  preflight(): UsVisaChinaPreflight | Promise<UsVisaChinaPreflight>;
  recordConfirmation?(booking: UsVisaChinaBooking): void | Promise<void>;
  fence: TrustedExecutionFence;
}

export type UsVisaChinaExecutionResult = {
  status: 'accepted';
  verification: { status: 'satisfied' };
  receipt: UsVisaChinaBooking;
} | {
  status: 'unknown';
  verificationOnly: true;
} | {
  status: 'failed';
  reason: 'contract_changed';
};

export interface UsVisaChinaReadiness {
  adapterId: typeof US_VISA_CHINA_ADAPTER_ID;
  adapterVersion: typeof US_VISA_CHINA_ADAPTER_VERSION;
  liveRegistration: 'disabled';
  discovery: 'not_started' | 'ready_for_owner_review';
  blockers: Array<'authenticated_contract_fixture' | 'current_terms_decision' | 'reviewed_origin' |
    'reviewed_roster' | 'polling_limits' | 'private_connection' | 'active_grant'>;
  report: UsVisaChinaSanitizedDiscoverySummary | null;
}

export interface UsVisaChinaSanitizedDiscoverySummary {
  allowedOrigin: string;
  contractVersion: 1;
  observedStateIds: UsVisaChinaStateId[];
  coverageSemantics: { inclusiveDates: true; contiguousPagination: true; completeEmptyDistinguished: true };
  termsDigest: string;
  ownerDecision: 'allow_configured_monitoring';
}
