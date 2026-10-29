import { randomUUID } from 'node:crypto';
import type { Caller } from '../pacs/access';
import type { PacsStudyState } from '../pacs/study-state';
import type { PacsTechNote } from '../pacs/tech-note';
import { ClinicalRoutes, clinicalRoutes } from './routes';

/** PACS projections and the clinical record share the request's transaction.
 * Route selection belongs with the clinical runtime, outside the public facade. */
export class PacsClinicalRoutes {
  constructor(private readonly studyState: PacsStudyState, private readonly notes: PacsTechNote,
    private readonly clinical?: ClinicalRoutes) {}

  async patchState(uid: string, body: any, c: Caller, request?: object) {
    return this.clinical && request
      ? this.clinical.workflow(request, workflow => this.studyState.patchState(uid, body, c, workflow))
      : this.studyState.patchState(uid, body, c);
  }

  async removeState(uid: string, c: Caller, request?: object) {
    return this.clinical && request
      ? this.clinical.workflow(request, workflow => this.studyState.removeState(uid, c, workflow))
      : this.studyState.removeState(uid, c);
  }

  async techNote(uid: string, c: Caller, before?: string, request?: object) {
    // The current note serves its one version and a history page the versions it lists; a note version is its
    // D sequence (the write's baseVersion is the unit revision). Retained versions not returned are not 열람.
    return clinicalRoutes(this.clinical).read(request, 'tech-note', uid,
      tx => this.notes.techNote(uid, c, before, tx),
      value => !value.note && !value.items?.length,
      before === undefined ? 'GET studies/:uid/tech-note' : 'GET studies/:uid/tech-note/history',
      value => value.note ? [value.note.version] : (value.items ?? []).map(item => item.version));
  }

  async saveTechNote(uid: string, body: any, c: Caller, request: object) {
    await this.notes.prepareWrite(uid, body, c);
    // Older pages have no attempt ID. Give this operation its own identity while
    // preserving the projection's legacy null attempt and version-conflict rule.
    const onlineBody = body && typeof body === 'object' && !('attemptId' in body) ? { ...body, attemptId: randomUUID() } : body;
    const result = await clinicalRoutes(this.clinical).write(request,
      { surface: 'tech-note.write', studyId: uid, recordId: uid, body: onlineBody },
      tx => this.notes.saveTechNote(uid, body, c, tx));
    // The stored receipt identifies the original attempt. The editor also needs
    // today's head so a delayed retry cannot roll its version basis back.
    // Read it through the clinical boundary so the provided head is recorded.
    if (result.emr.replayed) {
      const current = await clinicalRoutes(this.clinical).read(request, 'tech-note', uid,
        tx => this.notes.techNote(uid, c, undefined, tx), undefined, 'POST studies/:uid/tech-note',
        value => value.note ? [value.note.version] : []);
      return { ...result, latestNote: current.note };
    }
    return result;
  }
}
