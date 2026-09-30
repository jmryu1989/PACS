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

const SPEC_F = 'S7-U3a-AUDIT-SPEC-F-R-001';
const SPEC_G = 'S7-U1c-SPEC-G-B-R-001';
const CRITICAL = 'api/src/critical-result.service.ts';
const textHash = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const isSpecG = policy => policy.repin.ruling === SPEC_G;

// Positions locate AST nodes; they are never the identity used across revisions.
// Reject ambiguous structural anchors instead of guessing by order or proximity.
function deferralIdentity(entry, sources, ts) {
  assert.equal(entry.file, CRITICAL, 'SPEC-G file');
  assert.equal(entry.kind, 'raw call', 'SPEC-G kind');
  assert.equal(entry.rule, 'F02', 'SPEC-G rule');
  const text = sources.find(source => source.file === entry.file).text.replace(/\r\n/g, '\n');
  const file = ts.createSourceFile(entry.file, text, ts.ScriptTarget.Latest, true);
  assert.equal(file.parseDiagnostics.length, 0, 'SPEC-G syntax');
  const matches = [];
  const visit = node => {
    if (ts.isTaggedTemplateExpression(node) && node.getStart(file) === entry.start) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(matches.length, 1, 'SPEC-G call not found');
  const call = matches[0], anchor = [];
  assert.equal(file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1, entry.line, 'SPEC-G line');
  assert.ok(ts.isPropertyAccessExpression(call.tag) && call.tag.name.text === '$queryRaw', 'SPEC-G call shape');
  for (let node = call; node.parent; node = node.parent) {
    const parent = node.parent;
    if (ts.isClassDeclaration(parent) || ts.isMethodDeclaration(parent)
        || ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) {
      assert.ok(parent.name, 'SPEC-G unnamed anchor');
      anchor.push([ts.SyntaxKind[parent.kind], parent.name.getText(file)]);
    }
    if (ts.isIfStatement(parent)) {
      assert.ok(node === parent.thenStatement || node === parent.elseStatement, 'SPEC-G conditional call');
      anchor.push(['IfStatement', parent.expression.getText(file), node === parent.thenStatement ? 'then' : 'else']);
    }
  }
  return {
    identity: fingerprint([entry.file, entry.kind, entry.rule, entry.reason, anchor.reverse(),
      ts.SyntaxKind[call.kind], call.tag.getText(file)]),
    call_sha256: textHash(call.getText(file)),
  };
}

function specGInventory(raw, sources, scan, previousRaw, previousSources, previous, policy) {
  const repin = policy.repin;
  assert.deepEqual(previousRaw.map(position), repin.entries, 'SPEC-G previous entries changed');
  const outside = entries => entries.filter(entry => entry.file !== CRITICAL)
    .map(entry => [...position(entry), entry.rule, entry.reason]);
  assert.deepEqual(outside(raw), outside(previousRaw), 'SPEC-G other inventory changed');
  const identify = (entries, input, result) => {
    const selected = entries.filter(entry => entry.file === CRITICAL);
    assert.equal(selected.length, 3, 'SPEC-G requires the three reviewed calls');
    const found = selected.map(entry => deferralIdentity(entry, input, result.tools.ts));
    const map = new Map(found.map(item => [item.identity, item]));
    assert.equal(map.size, found.length, 'SPEC-G ambiguous identity');
    return map;
  };
  const before = identify(previousRaw, previousSources, previous);
  const after = identify(raw, sources, scan);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'SPEC-G identity or diagnosis changed');
  assert.ok(Array.isArray(repin.site_proofs) && repin.site_proofs.length === 3, 'SPEC-G provenance required');
  const seen = new Set();
  for (const proof of repin.site_proofs) {
    assert.ok(proof && before.has(proof.identity) && !seen.has(proof.identity), 'SPEC-G missing or duplicate proof');
    seen.add(proof.identity);
    assert.equal(proof.before_call_sha256, before.get(proof.identity).call_sha256, 'SPEC-G prior call changed');
    assert.equal(proof.after_call_sha256, after.get(proof.identity).call_sha256, 'SPEC-G current call changed');
    // These are review inputs, NOT a boolean assertion that the checker proved provenance.
    for (const field of ['sql', 'values', 'dependencies']) {
      assert.ok(typeof proof[field] === 'string' && proof[field].trim().length > 0, 'SPEC-G incomplete ' + field);
    }
    assert.ok(Array.isArray(proof.evidence) && proof.evidence.length > 0, 'SPEC-G evidence required');
    for (const evidence of proof.evidence) {
      assert.ok(evidence && typeof evidence.ref === 'string' && evidence.ref.trim().length > 0
        && /^[0-9a-f]{64}$/.test(evidence.sha256), 'SPEC-G invalid evidence reference');
    }
  }
}

// Rebuild the reviewed predecessor without Git, network access or a writable checkout.
// Its whole-corpus hash authenticates every restored byte, including unchanged files.
function repinSources(sources, policy) {
  const repin = policy.repin;
  assert.ok([SPEC_F, SPEC_G].includes(repin.ruling), 'repin authority');
  assert.equal(repin.source_sha, policy.baseline_source_sha, 'repin baseline');
  assert.ok(/^[0-9a-f]{40}$/.test(repin.source_sha), 'invalid baseline SHA');
  assert.equal(repin.typescript, policy.typescript, 'repin compiler changed');
  assert.equal(fingerprint(policy.context), repin.context_sha256, 'repin compiler inputs changed');
  assert.equal(fingerprint(isSpecG(policy) ? repin.entries : policy.entries), repin.entries_sha256, 'repin entries changed');
  if (!isSpecG(policy)) assert.equal(policy.unresolved_sha256, repin.unresolved_sha256, 'repin inventory pin changed');
  assert.ok(Array.isArray(repin.before) && repin.before.length > 0, 'empty repin');
  const previous = new Map(sources.map(source => [source.file, source]));
  assert.equal(previous.size, sources.length, 'duplicate source');
  const seen = new Set(), deferredFiles = new Set([
    ...policy.entries, ...(isSpecG(policy) ? repin.entries : []),
  ].map(pin => pin[0]));
  if (isSpecG(policy)) assert.ok(repin.before.some(source => source.file === CRITICAL), 'SPEC-G transition required');
  for (const source of repin.before) {
    assert.ok(source && typeof source.file === 'string' && typeof source.text === 'string', 'invalid prior source');
    assert.ok(previous.has(source.file) && !seen.has(source.file), 'missing or duplicate prior source');
    assert.ok(!deferredFiles.has(source.file) || isSpecG(policy) && source.file === CRITICAL,
      'cannot repin a deferral-bearing file');
    assert.notEqual(source.text.replace(/\r\n/g, '\n'),
      previous.get(source.file).text.replace(/\r\n/g, '\n'), 'unchanged repin source');
    seen.add(source.file);
    previous.set(source.file, source);
  }
  const restored = [...previous.values()].map(source =>
    ({ file: source.file, text: source.text.replace(/\r\n/g, '\n') }))
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  assert.equal(sourceFingerprint(restored), repin.sources_sha256, 'previous source corpus changed');
  return restored;
}

/**
 * D-NW is a temporary disposition, never a W1-W6 proof. The caller must supply
 * reviewed policy explicitly. No policy means the ordinary fail-closed verdict.
 * Validate the whole input before deferring anything; leave the raw scan intact.
 */
function nonWriteDeferrals(scan, sources, policy, context, scanPrevious) {
  const unchanged = () => ({ unresolved: [...scan.unresolved], deferred: [], errors: [] });
  if (policy === null || policy === undefined) return unchanged();
  try {
    assert.equal(policy.schema_version, 3, 'policy version');
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
    const previousSources = repinSources(sources, policy);
    assert.equal(typeof scanPrevious, 'function', 'previous scan is required');
    const previous = scanPrevious(previousSources);
    assert.equal(previous.typescript, scan.typescript, 'previous compiler changed');
    assert.deepEqual([...previous.files].sort(), previousSources.map(source => source.file).sort(),
      'previous scan/source set differs');
    const previousRaw = previous.candidates.filter(entry => entry.status === 'unresolved');
    assert.deepEqual(previous.unresolved, previousRaw.map(message), 'previous raw inventory differs from verdict');
    assert.equal(unresolvedFingerprint(previousRaw), policy.repin.unresolved_sha256, 'previous inventory changed');
    if (isSpecG(policy)) specGInventory(raw, sources, scan, previousRaw, previousSources, previous, policy);
    else assert.deepEqual(raw.map(entry => [...position(entry), entry.rule, entry.reason]),
      previousRaw.map(entry => [...position(entry), entry.rule, entry.reason]), 'repin inventory differs');
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

module.exports = { nonWriteDeferrals, sourceFingerprint, unresolvedFingerprint, repinSources, deferralIdentity };
