// Test-owned fixture of tests/admin_audit_attribution_test.cjs (not product code): the modules that call the helpers of
// writer.ts from another file (pacs/hold.ts, study-state.ts, worklist.ts, report-commit.ts), each holding what
// composition.ts hands it in a private readonly parameter property. No line here is a candidate; the actions written in
// writer.ts are read from these calls.
import type { SynAccess, SynAuditWriter, SynCaller, SynDraft } from './writer';

export class SynHold {
  constructor(private readonly access: SynAccess) {}

  async forceRelease(uid: string, c: SynCaller) {
    return this.access.scopeWrite(uid, c, async (tx, audit) => {
      await audit(c.actor, 'hold.force-release', uid); // @cw:release-call
    });
  }

  async assign(uid: string, c: SynCaller) {
    return this.access.scopeWrite(uid, c, async (tx, audit) => { await audit(c.actor, 'study.assign', uid); }); // @cw:assign-call
  }

  // A callback that never writes: the scope's audit function is not even its parameter.
  async peek(uid: string, c: SynCaller) {
    return this.access.scopeWrite(uid, c, async tx => tx.studyState.findMany({ where: { uid } })); // @cw:peek
  }
}

export class SynStudyState {
  constructor(private readonly access: SynAccess, private readonly audit: SynAuditWriter) {}

  async patch(uid: string, body: any, c: SynCaller) {
    return this.access.scopeWrite(uid, c, async (tx, audit) => {
      await audit(c.actor, 'state.patch', uid); // @cw:patch-call
    });
  }

  async unmatch(uid: string, c: SynCaller) {
    return this.access.scopeWrite(uid, c, async (tx, audit) => { await audit(c.actor, 'unmatch', uid); });
  }

  async match(uid: string, c: SynCaller) {
    await this.audit.audit(c.actor, 'match', uid); // @cw:match-call
  }
}

export class SynWorklist {
  constructor(private readonly audit: SynAuditWriter) {}

  async arrived(uid: string) {
    await this.audit.audit('system', 'study.arrived', uid); // @cw:arrived-call
  }
}

export class SynCommit {
  constructor(private readonly draft: SynDraft) {}

  // The request names the action; the guard before the transaction limits it inside the callback (W2 iv).
  async commit(uid: string, body: any, c: SynCaller) {
    const action = body?.action;
    if (!['save', 'approve'].includes(action)) throw new Error(`unknown action: ${action}`); // @cw:commit-guard
    return this.draft.draftTransaction(uid, c, async (tx, audit) => {
      await audit(c.actor, `report.${action}`, uid); // @cw:commit-call
    });
  }
}
// end of callers.ts
