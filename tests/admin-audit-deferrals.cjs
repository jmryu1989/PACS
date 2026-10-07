'use strict';

/**
 * The D-NW list: raw SQL sites under api/src whose SQL or values the audit completeness scan cannot prove to be
 * no audit write, set aside by name until each is resolved (tests/admin-audit-nonwrite-deferrals.json).
 *
 * What this guards against is a mistake: a new raw SQL site that nobody looked at. So a site is known by what it is -
 * the file, the declaration it stands in, the candidate kind and how many such sites that declaration has - and not by
 * where it stands. Moving code, or editing another file, changes nothing here. There is no hash of the source tree,
 * of the schema or of the compiler inputs, and no predecessor to rebuild: an unrelated server change does not have to
 * touch the list.
 *
 * The list is all or nothing. If the scan finds a site the list does not name (a new raw site, or one more in a
 * listed declaration), or the list names one the scan no longer finds (resolved or removed: take it off the list),
 * nothing is set aside and the completeness verdict fails on `unresolved` with the difference spelled out.
 * A candidate that is an audit write, or that the scan resolved, is never eligible.
 */

const ELIGIBLE = new Set(['raw call', 'raw SQL naming AuditLog']);
const message = entry => `${entry.file}:${entry.line} ${entry.kind}: ${entry.reason}`;
const keyOf = site => JSON.stringify([site.file, site.within, site.kind]);

/** The declaration a position stands in, outermost first: `PacsService.list`, `auditPage`, `(module)`. */
function within(entry, text, ts) {
  const file = ts.createSourceFile(entry.file, text, ts.ScriptTarget.Latest, true);
  const names = [];
  const descend = node => {
    if (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
        || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      if (node.name) names.push(node.name.getText(file));
    } else if (ts.isConstructorDeclaration(node)) names.push('constructor');
    ts.forEachChild(node, child => {
      if (child.getStart(file) <= entry.start && entry.start < child.getEnd()) descend(child);
    });
  };
  descend(file);
  return names.length ? names.join('.') : '(module)';
}

/** The eligible unresolved candidates of a scan with the declaration each stands in. */
function rawSites(scan, sources) {
  const ts = scan.tools.ts;
  const texts = new Map(sources.map(source => [source.file, source.text.replace(/\r\n/g, '\n')]));
  return scan.candidates
    .filter(entry => entry.status === 'unresolved' && entry.rule === 'F02' && ELIGIBLE.has(entry.kind)
      && !scan.sites.some(site => site.file === entry.file && site.start === entry.start))
    .map(entry => ({ entry, site: { file: entry.file, within: within(entry, texts.get(entry.file), ts), kind: entry.kind } }));
}

/** The sites of a scan in the shape of the list file: one row per (file, declaration, kind) with its count. */
function rawSiteList(scan, sources) {
  const rows = new Map();
  for (const { site } of rawSites(scan, sources)) {
    const key = keyOf(site);
    rows.set(key, { ...site, count: (rows.get(key)?.count ?? 0) + 1 });
  }
  return [...rows.values()].sort((a, b) => keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
}

/**
 * The verdict input after the list: `unresolved` is what still blocks, `deferred` what the list set aside.
 * No list means the ordinary fail-closed verdict; the raw scan is never rewritten.
 */
function listedRawSites(scan, sources, list) {
  if (list === null || list === undefined) return { unresolved: [...scan.unresolved], deferred: [], errors: [] };
  const errors = [];
  const listed = new Map();
  if (list.schema_version !== 4 || !Array.isArray(list.sites)) errors.push('D-NW list: not a schema_version 4 site list');
  else for (const row of list.sites) {
    const ok = row && typeof row.file === 'string' && typeof row.within === 'string' && ELIGIBLE.has(row.kind)
      && Number.isInteger(row.count) && row.count > 0;
    if (!ok || listed.has(keyOf(row))) errors.push('D-NW list: a malformed or repeated row ' + JSON.stringify(row));
    else listed.set(keyOf(row), row);
  }
  const found = rawSites(scan, sources), counts = new Map();
  for (const { site } of found) counts.set(keyOf(site), (counts.get(keyOf(site)) ?? 0) + 1);
  if (!errors.length) {
    for (const [key, count] of counts) {
      const row = listed.get(key), [file, where, kind] = JSON.parse(key);
      if (!row) errors.push(`D-NW list: a new raw SQL site is not on the list: ${file} ${where} (${kind})`);
      else if (count > row.count) errors.push(`D-NW list: ${file} ${where} (${kind}) has ${count} raw SQL sites, the list names ${row.count}`);
    }
    for (const [key, row] of listed) {
      if ((counts.get(key) ?? 0) < row.count)
        errors.push(`D-NW list: ${row.file} ${row.within} (${row.kind}) is listed ${row.count} time(s), the scan finds ${counts.get(key) ?? 0}: take the resolved site off the list`);
    }
  }
  if (errors.length) return { unresolved: [...scan.unresolved, ...errors], deferred: [], errors };
  const set = new Set(found.map(({ entry }) => entry));
  return {
    unresolved: scan.candidates.filter(entry => entry.status === 'unresolved' && !set.has(entry)).map(message),
    deferred: found.map(({ entry, site }) => ({
      ...entry, start: entry.start, within: site.within, status: 'deferred_non_audit', original_status: entry.status,
      disposition: 'D-NW', owner: list.owner, follow_up: list.follow_up,
    })),
    errors: [],
  };
}

module.exports = { listedRawSites, rawSiteList };
