# D-NW: raw SQL sites set aside by name

Ruling that set them aside: S7-U3a-AUDIT-SPEC-D-R-001, option (c). Owner: Fable commander; product work: the
assigned product worker. Follow-up unit: S7-U3a-RAW-PROVENANCE (resolve the sites, then delete this list and its check).
This is explicit debt, not a release approval and not a proof that the sites are safe.

## What is checked

`tests/admin_audit_attribution_test.cjs` scans every file under `api/src` with the TypeScript compiler API.

1. **Audit writes** (the positive control, unchanged): every `auditLog` write and every raw `INSERT INTO "AuditLog"` is
   resolved to its actions by the closed rules W1-W6, and every action has a row in `api/src/admin-audit.ts`; rows nothing
   writes fail too. No audit write can be set aside.
2. **Raw SQL sites**: a raw call whose SQL or values the scan cannot prove (rule F02) is `unresolved`. The sites in
   `tests/admin-audit-nonwrite-deferrals.json` are set aside as `deferred_non_audit`; they stay in the inventory with
   their reasons (`ADMIN_AUDIT_WRITER`, `ADMIN_AUDIT_DEFERRED_NON_AUDIT`).

## The list

One row per declaration: `{ file, within, kind, count }` - the file, the declaration the site stands in
(`PacsService.listStudies.noteRows`), the candidate kind (`raw call` or `raw SQL naming AuditLog`) and how many such sites
that declaration has. A site is known by what it is, not by its line or offset: moving code or editing another file
does not touch the list. The list is bound to no hash of the source tree, of the Prisma schema or of the compiler inputs.

The list is all or nothing (`tests/admin-audit-deferrals.cjs`):

- a raw SQL site the list does not name - in a new declaration, or one more in a listed one - sets nothing aside and the
  completeness verdict fails on `unresolved`, naming it. Fix the site (typed values, fixed SQL fragments) rather than
  listing it; a new row needs the same review as the ruling above;
- a row the scan no longer finds (the site was resolved or removed) fails as well: take the row off the list.

The test prints the scan's own list as `ADMIN_AUDIT_RAW_SITES`; the file equals it when it is in step.

## State

27 sites in 23 rows, the same 27 the ruling set aside (their positions moved with S7-U5; their declarations did not):
18 with SQL fragments (`Prisma.sql` / `Prisma.join` values the scan does not follow) and 9 with request-derived `any`
values. `study-access.service.ts` `StudyAccessService.write` writes non-audit tables: "non-audit" does not mean
"read-only". Resolving them is S7-U3a-RAW-PROVENANCE and is not part of S7-U5.

## History

Until S7-U5 this file was sealed to the whole `api/src` source set, the TypeScript version, `tsconfig.json`, the package
lock and `schema.prisma`, with a reviewed predecessor reconstruction (SPEC-F) and per-site identity proofs for one file
(SPEC-G). Every server change, related or not, had to re-pin it. Commander decision D557 and the 2026-10-04 waste audit
removed the seal: what a development tool has to catch here is a mistake - a new raw SQL site nobody looked at - not a
forged hash.
