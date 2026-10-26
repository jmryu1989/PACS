import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ViewingSetTarget } from '../multi-study-view.service';
import { LocalReadResponse, LocalReadSource } from './local-read';

// Keep W9's existing retry explanation when the shared recorder refuses it.
const W9_UNAVAILABLE = Object.freeze({ code: 'W9_AUDIT_UNAVAILABLE',
  message: '열람 기록을 저장하지 못했습니다. 잠시 후 Retry로 다시 시도하세요.' });

/** W9 describes its admitted source snapshot; A1 records it under the Guard's
 * request work before selecting the serialized response. Client correlation
 * fields never supply the actor, event time or server request identity. */
@Injectable()
export class ViewingSetAccess {
  select(targets: readonly ViewingSetTarget[], body: (refs: ReadonlyMap<string, string>) => unknown,
    signal: AbortSignal): LocalReadResponse {
    const refs = new Map(targets.map(target => [target.uid, randomUUID()]));
    const known = (value: string) => ({ status: 'known' as const, value });
    const unobserved = { status: 'unresolved' as const, reason: 'not-observed' as const };
    const sources: LocalReadSource[] = targets.map(target => ({
      eventId: refs.get(target.uid)!, managingInstitution: target.managingInstitutionId,
      cause: 'user-view', context: target.context,
      path: ['members', target.ordinal, 'metadata'],
      target: { kind: 'study-metadata', studyId: known(target.uid), recordId: known(target.uid),
        versionId: unobserved, sourcePatientId: known(target.patientId),
        sourceInstitution: target.metadata.institutionName ? known(target.metadata.institutionName) : unobserved },
    }));
    return new LocalReadResponse(body(refs), sources, signal, W9_UNAVAILABLE);
  }
}
