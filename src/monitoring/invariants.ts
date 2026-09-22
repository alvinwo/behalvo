import type { DomainEvent, State } from '../kernel/types.js';

/** Monitored allowance consumption is valid only as one contiguous journal transition. */
export function validateMonitoredReservationJournal(events: readonly DomainEvent[], state?: State): void {
  const configuredGrants = new Map<string, string>();
  for (const event of events) if (event.type === 'monitor.configured')
    configuredGrants.set(event.data.monitor.id, event.data.monitor.grantId);
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
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
    }
    if (event.type === 'monitor.stopped' && event.data.reason === 'grant_terminal') {
      let sourceIndex = index - 1;
      while (sourceIndex >= 0) {
        const previous = events[sourceIndex];
        if (previous?.type !== 'monitor.stopped' || previous.data.reason !== 'grant_terminal') break;
        sourceIndex--;
      }
      const source = events[sourceIndex];
      const grantId = state?.monitors[event.data.id]?.grantId ?? configuredGrants.get(event.data.id);
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
