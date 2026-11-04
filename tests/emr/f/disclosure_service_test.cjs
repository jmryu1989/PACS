/* REQ-EMR-16 -> RISK-F-03/04 -> TEST-F-DISCLOSURE-READ.
 * New read route: saved bytes, state, integrity, scope and exact recorded targets.
 * Existing F tests own transitions; this case only verifies the new read boundary.
 */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { fixture, intake, F } = require('./disclosure_harness.cjs');
test('issuance read preserves saved bytes, records only disclosed versions, and enforces authority/integrity', async () => {
  const f = fixture(), input = intake();
  const prepared = await f.controller.prepare({}, input), id = prepared.issuanceId;
  const before = f.issuances.length;
  let read = await f.controller.issuance({}, id);
  assert.equal(read.status.state, 'Prepared'); assert.equal(read.artifact, null);
  assert.equal(f.issuances.length, before, 'read never issues');
  const issued = await f.controller.issue({}, id);
  read = await f.controller.issuance({}, id);
  assert.equal(read.status.state, 'Issued');
  assert.equal(read.artifact, issued.artifact); assert.equal(read.sha256, issued.sha256);
  assert.equal(createHash('sha256').update(Buffer.from(read.artifact, 'base64')).digest('hex'), read.sha256);
  assert.deepEqual(f.records.at(-1).targets, F.disclosureLedgerTargets(issued.issuance));
  const saved = f.copies.get(id); f.copies.delete(id);
  await assert.rejects(f.controller.issuance({}, id), { code: 'FixedCopyIntegrityMismatch' });
  f.copies.set(id, { ...saved, body: Buffer.from('changed') });
  await assert.rejects(f.controller.issuance({}, id), { code: 'FixedCopyIntegrityMismatch' });
  for (const [scopes, code] of [[[], 'AuditorNotDesignated'], [['inspection'], 'AuditScopeNotGranted']])
    await assert.rejects(fixture(scopes).controller.issuance({}, id), { code });
  const foreign = fixture(['disclosure'], 'OTHER-SITE');
  foreign.issuances.push(...f.issuances); foreign.copies.set(id, saved);
  await assert.rejects(foreign.controller.issuance({}, id), { code: 'IssuanceNotFound' });
  assert.equal(foreign.records.length, 0, 'foreign saved bytes are never provided');
});
