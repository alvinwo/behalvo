import type { Action, DomainEvent, State } from '../kernel/types.js';
import type { MonitoredActionGrant } from './types.js';

/** Build the one allowed contiguous narrowing/reservation/start transition. */
export function monitoredReservationEvents(input: {
  grant: MonitoredActionGrant;
  action: Action;
  attemptId: string;
  observationDigest: string;
  reservedAt: string;
  monitorId?: string;
}): DomainEvent[] {
  const events: DomainEvent[] = [
    { type: 'monitored_action.command_narrowed', data: { grantId: input.grant.id, action: input.action } },
    { type: 'monitored_action.grant_reserved', data: { id: input.grant.id, digest: input.grant.digest,
      revision: input.grant.revision, actionId: input.action.id, attemptId: input.attemptId,
      observationDigest: input.observationDigest, reservedAt: input.reservedAt } },
    { type: 'action.started', data: { id: input.action.id, attemptId: input.attemptId } }
  ];
  if (input.monitorId) events.push({ type: 'monitor.stopped', data: {
    id: input.monitorId, reason: 'grant_reserved', stoppedAt: input.reservedAt
  } });
  return events;
}

/** Monitored allowance consumption is valid only as one contiguous journal transition. */
export function validateMonitoredReservationJournal(events: readonly DomainEvent[], state?: State): void {
  const configuredGrants = new Map<string, string>();
  const armPlans = new Map<string, MonitoredActionGrant['armPlan']>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.type === 'monitored_action.grant_proposed')
      armPlans.set(event.data.grant.id, event.data.grant.armPlan);
    if (event.type === 'monitor.configured')
      configuredGrants.set(event.data.monitor.id, event.data.monitor.grantId);
    if (event.type === 'monitored_action.command_narrowed') {
      const reservation = events[index + 1];
      const start = events[index + 2];
      if (reservation?.type !== 'monitored_action.grant_reserved' ||
          reservation.data.id !== event.data.grantId || reservation.data.actionId !== event.data.action.id ||
          start?.type !== 'action.started' || start.data.id !== event.data.action.id ||
          start.data.attemptId !== reservation.data.attemptId)
        throw new Error('Monitored reservation must atomically include its action start');
    }
    if (event.type === 'monitored_action.grant_reserved') {
      const narrowed = events[index - 1];
      const start = events[index + 1];
      if (narrowed?.type !== 'monitored_action.command_narrowed' ||
          narrowed.data.grantId !== event.data.id || narrowed.data.action.id !== event.data.actionId ||
          start?.type !== 'action.started' || start.data.id !== event.data.actionId ||
          start.data.attemptId !== event.data.attemptId)
        throw new Error('Monitored reservation must atomically include its narrowed action and start');
      const plan = armPlans.get(event.data.id) ?? state?.monitoredActionGrants[event.data.id]?.armPlan;
      const stop = events[index + 2];
      if (plan && (stop?.type !== 'monitor.stopped' || stop.data.id !== plan.monitorId ||
          stop.data.reason !== 'grant_reserved' || stop.data.stoppedAt !== event.data.reservedAt))
        throw new Error('Reviewed reservation must atomically stop its planned monitor');
    }
    if (event.type === 'monitor.stopped' && event.data.reason === 'grant_terminal') {
      let sourceIndex = index - 1;
      while (sourceIndex >= 0) {
        const previous = events[sourceIndex];
        if (previous?.type !== 'monitor.stopped' || previous.data.reason !== 'grant_terminal') break;
        sourceIndex--;
      }
      const source = events[sourceIndex];
      const grantId = configuredGrants.get(event.data.id) ?? state?.monitors[event.data.id]?.grantId;
      if ((source?.type !== 'monitored_action.grant_revoked' && source?.type !== 'monitored_action.grant_expired') ||
          source.data.id !== grantId)
        throw new Error('Monitor terminal stop must be contiguous with its terminal grant event');
    }
  }
}

/** Cross-check the durable allowance and action projections after a complete replay. */
export function validateMonitoredReservationState(state: State): void {
  for (const grant of Object.values(state.monitoredActionGrants)) {
    if (!grant.reservedActionId) continue;
    const action = state.actions[grant.reservedActionId];
    if (!action || !grant.reservationAttemptId || !grant.reservationObservationDigest ||
        action.monitoredGrant?.id !== grant.id || action.monitoredGrant.digest !== grant.digest ||
        action.monitoredGrant.revision !== grant.revision || action.attemptId !== grant.reservationAttemptId ||
        action.key !== `monitor:${grant.id}:${grant.reservationObservationDigest}` ||
        ['proposed', 'approved', 'cancelled'].includes(action.status))
      throw new Error('Invalid monitored reservation projection');
  }
  for (const action of Object.values(state.actions)) {
    if (!action.monitoredGrant) continue;
    const grant = state.monitoredActionGrants[action.monitoredGrant.id];
    if (!grant || grant.reservedActionId !== action.id || grant.reservationAttemptId !== action.attemptId)
      throw new Error('Orphan monitored action projection');
  }
}
