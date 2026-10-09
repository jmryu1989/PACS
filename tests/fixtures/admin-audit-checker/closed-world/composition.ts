// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code): the facade that creates the modules of
// writer.ts and callers.ts and owns them (W4-C), as the S9-U0b pacs.service.ts does — an explicit `new` into a private
// readonly field, by a statement of the constructor or where the field is declared; the modules handed to one another and
// the DI service the facade receives handed to them, each by a private readonly parameter property.
import { Prisma } from '@prisma/client';
import { SynAccess, SynAuditWriter, SynDraft } from './writer';
import type { SynCaller, SynClosedPrisma } from './writer';
import { SynCommit, SynHold, SynStudyState, SynWorklist } from './callers';

import { Injectable } from '@nestjs/common';

// An existing DI service: the framework creates it and hands it to the facade.
@Injectable()
export class SynScopeService {
  async require(uid: string, tx: Prisma.TransactionClient) {
    await tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid = ${uid} FOR SHARE`; // @cw:scope-read // expect: proven_non_audit its SQL names no AuditLog
  }
}

@Injectable()
export class SynFacade {
  private readonly accessConcern: SynAccess;
  private readonly auditConcern: SynAuditWriter = new SynAuditWriter(this.prisma); // @cw:audit-field
  private readonly draftConcern: SynDraft;
  private readonly holdConcern: SynHold;
  private readonly stateConcern: SynStudyState;
  private readonly worklistConcern: SynWorklist;
  private readonly commitConcern: SynCommit;

  constructor(private prisma: SynClosedPrisma, private scope: SynScopeService) {
    this.accessConcern = new SynAccess(this.prisma, this.scope); // @cw:access-field
    this.draftConcern = new SynDraft(this.prisma);
    this.holdConcern = new SynHold(this.accessConcern);
    this.stateConcern = new SynStudyState(this.accessConcern, this.auditConcern);
    this.worklistConcern = new SynWorklist(this.auditConcern);
    this.commitConcern = new SynCommit(this.draftConcern); // @cw:last-wiring
  }

  forceRelease(uid: string, c: SynCaller) { return this.holdConcern.forceRelease(uid, c); }
  assign(uid: string, c: SynCaller) { return this.holdConcern.assign(uid, c); }
  peek(uid: string, c: SynCaller) { return this.holdConcern.peek(uid, c); }
  patch(uid: string, body: any, c: SynCaller) { return this.stateConcern.patch(uid, body, c); }
  unmatch(uid: string, c: SynCaller) { return this.stateConcern.unmatch(uid, c); }
  match(uid: string, c: SynCaller) { return this.stateConcern.match(uid, c); }
  arrived(uid: string) { return this.worklistConcern.arrived(uid); } // @cw:arrived-forward
  putDraft(uid: string, c: SynCaller, empty: boolean) { return this.draftConcern.putDraft(uid, c, empty); }
  discardDraft(uid: string, c: SynCaller) { return this.draftConcern.discardDraft(uid, c); }
  forceDiscard(uid: string, c: SynCaller) { return this.draftConcern.forceDiscard(uid, c); }
  commit(uid: string, body: any, c: SynCaller) { return this.commitConcern.commit(uid, body, c); }
}
// end of composition.ts
