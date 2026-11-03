import type { ImmutableIdentity, PatientLinkSnapshot } from '../emr-contract/access-event';
import type { RightsDecision, RightsRequestKind } from './contract';

export interface RightsIntake {
  requestId: string; kind: RightsRequestKind; receivedAt: string; patient: PatientLinkSnapshot;
  recordIds: string[]; statement: string;
}
export interface RightsState {
  kind: 'rights-request'; institutionId: string; request: RightsIntake;
  receivedBy: ImmutableIdentity; recordedAt: string; dueBy: string;
  decision: RightsDecision | null;
  withdrawal?: { evidenceId: string; recordedBy: ImmutableIdentity; recordedAt: string } | null;
  notification: { notifiedAt: string; recipient: string; method: string; evidenceId: string; content: string;
    recordedBy: ImmutableIdentity; recordedAt: string } | null;
}
export function rightsView(state: RightsState, at: string) {
  return { ...state, status: state.withdrawal ? 'Withdrawn' : state.notification ? 'Notified' : state.decision ? 'Decided' : 'Received',
    overdue: (state.withdrawal?.recordedAt ?? state.notification?.notifiedAt ?? at) >= state.dueBy };
}
