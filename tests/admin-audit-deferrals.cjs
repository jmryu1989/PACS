'use strict';
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const position = entry => [entry.file, entry.line, entry.start, entry.kind];
const message = entry => `${entry.file}:${entry.line} ${entry.kind}: ${entry.reason}`;
const sourceFingerprint = sources => fingerprint(sources.map(source =>
  [source.file, source.text.replace(/\r\n/g, '\n')]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const unresolvedFingerprint = entries => fingerprint(entries.map(entry =>
  [...position(entry), entry.rule, entry.reason]));

/**
 * D-NW is a temporary disposition, never a W1-W6 proof. The caller must supply
 * reviewed policy explicitly. No policy means the ordinary fail-closed verdict.
 * Validate the whole input before deferring anything; leave the raw scan intact.
 */
function nonWriteDeferrals(scan, sources, policy, context) {
  const unchanged = () => ({ unresolved: [...scan.unresolved], deferred: [], errors: [] });
  if (policy === null || policy === undefined) return unchanged();
  try {
    assert.equal(policy.schema_version, 1, 'policy version');
    assert.equal(policy.ruling, 'S7-U3a-AUDIT-SPEC-D-R-001', 'policy authority');
    assert.ok(typeof policy.owner === 'string' && policy.owner.length, 'policy owner');
    assert.ok(typeof policy.follow_up === 'string' && policy.follow_up.length, 'product follow-up');
    assert.equal(policy.typescript, scan.typescript, 'compiler changed');
    assert.deepEqual(context, policy.context, 'compiler inputs changed');
    assert.equal(new Set(sources.map(source => source.file)).size, sources.length, 'duplicate source');
    assert.deepEqual([...scan.files].sort(), sources.map(source => source.file).sort(), 'scan/source set differs');
    assert.equal(sourceFingerprint(sources), policy.sources_sha256, 'source corpus changed');

    const raw = scan.candidates.filter(entry => entry.status === 'unresolved');
    assert.deepEqual(scan.unresolved, raw.map(message), 'raw inventory differs from verdict');
    assert.equal(unresolvedFingerprint(raw), policy.unresolved_sha256, 'unresolved inventory changed');
    assert.ok(Array.isArray(policy.entries) && policy.entries.length > 0, 'empty policy');
    const selected = new Set(), keys = new Set();
    for (const pin of policy.entries) {
      assert.ok(Array.isArray(pin) && pin.length === 4, 'invalid position pin');
      const key = JSON.stringify(pin);
      assert.ok(!keys.has(key), 'duplicate position pin');
      keys.add(key);
      const matches = raw.filter(entry => JSON.stringify(position(entry)) === key);
      assert.equal(matches.length, 1, 'missing or ambiguous position pin');
      const [entry] = matches;
      assert.ok(entry.rule === 'F02' && ['raw call', 'raw SQL naming AuditLog'].includes(entry.kind),
        'only the reviewed F02 non-write candidates may be deferred');
      assert.ok(!scan.sites.some(site => site.file === entry.file && site.start === entry.start),
        'a resolved writer cannot be deferred');
      selected.add(entry);
    }
    // The ruling covers the complete hash-pinned raw set, never a valid subset.
    assert.ok(selected.size === raw.length && raw.every(entry => selected.has(entry)),
      'deferral entries must cover the complete unresolved inventory');
    return {
      unresolved: raw.filter(entry => !selected.has(entry)).map(message),
      deferred: [...selected].map(entry => ({
        ...entry, start: entry.start, status: 'deferred_non_audit', original_status: entry.status,
        disposition: 'D-NW', ruling: policy.ruling, owner: policy.owner, follow_up: policy.follow_up,
      })),
      errors: [],
    };
  } catch (error) {
    const reason = 'D-NW input rejected: ' + error.message;
    return { unresolved: [...scan.unresolved, reason], deferred: [], errors: [reason] };
  }
}

module.exports = { nonWriteDeferrals, sourceFingerprint, unresolvedFingerprint };
