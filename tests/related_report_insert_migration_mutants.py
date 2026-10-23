"""W5-API (O4 R1, review W5A-04): the receipt migration's terminal guard and its NULL-closed state CHECK, each taken away by a
migration mutant on hosted PostgreSQL.

For every variant - the real migration first, as the control - a new database of the given postgres:16-alpine container
receives the variant's exact bytes, one receipt in each state (the product transfer's synthetic rows) and the restored-product
probe set (ops_product_transfer_fixture.RECEIPT_PROBES, each judged by the SQLSTATE its statement ends with). The control must
apply and answer every probe as the contract does. Each mutant must apply and fail the probe it names:
  M17  both CREATE TRIGGER statements of the guard removed (the function stays): the UPDATE of an applied row is accepted
  M18  the state CHECK without its COALESCE and without the refused clause's "reason" IS NOT NULL: a refused row with an SQL
       NULL reason is accepted (the CHECK's NULL passes; no other clause or constraint still closes it - the catalog's
       definition is recorded)
Records under <out>/<variant>/: migration.sql (the applied bytes), apply.log, probes.json (states, differences, sha256,
catalog); <out>/summary.json, also printed. Exit 0 only when the control passes and both mutants are killed.

usage: related_report_insert_migration_mutants.py <postgres container> <new output directory>
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ops_product_transfer_fixture as transfer  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT/'api/prisma/migrations/20261016120000_related_report_insert_receipt/migration.sql'
GUARD_TRIGGERS = ('CREATE TRIGGER "ReportDraftInsertReceipt_guard_row" BEFORE UPDATE OR DELETE ON "ReportDraftInsertReceipt"\n'
                  '  FOR EACH ROW EXECUTE FUNCTION "report_draft_insert_receipt_guard"();\n'
                  'CREATE TRIGGER "ReportDraftInsertReceipt_guard_truncate" BEFORE TRUNCATE ON "ReportDraftInsertReceipt"\n'
                  '  FOR EACH STATEMENT EXECUTE FUNCTION "report_draft_insert_receipt_guard"();\n')
MUTANTS = {
    'M17-terminal-guard-triggers-removed': dict(kills='terminal_applied_update', edits=[(GUARD_TRIGGERS, '')]),
    'M18-state-check-lets-sql-null-through': dict(kills='null_reason_check', edits=[
        ('CONSTRAINT "ReportDraftInsertReceipt_state_check" CHECK (COALESCE(\n',
         'CONSTRAINT "ReportDraftInsertReceipt_state_check" CHECK ((\n'),
        ('OR ("state" = \'refused\' AND "appliedRevision" IS NULL AND "reason" IS NOT NULL\n',
         'OR ("state" = \'refused\' AND "appliedRevision" IS NULL\n'),
        ('"reason" = \'INSERT_DISCARDED\'),\n        false))\n);', '"reason" = \'INSERT_DISCARDED\')))\n);')]),
}
CATALOG = ('SELECT jsonb_build_object('
           '\'triggers\', (SELECT count(*) FROM pg_trigger WHERE tgrelid = \'"ReportDraftInsertReceipt"\'::regclass AND NOT tgisinternal),'
           '\'state_check\', (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = \'ReportDraftInsertReceipt_state_check\'))')


def variant_bytes(base, edits):
    text = base.decode('utf-8')
    for find, replace in edits:
        if text.count(find) != 1:
            raise SystemExit(f'mutant anchor found {text.count(find)} times: {find[:60]!r}')
        text = text.replace(find, replace)
    return text.encode('utf-8')


def run(container, args, data=None):
    return subprocess.run(['docker', 'exec', '-i', container, *args], input=data, capture_output=True, timeout=60)


def query(container, db, sql):
    done = run(container, ['psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db, '-c', sql])
    if done.returncode:
        raise SystemExit(f'{db}: query failed: ' + done.stderr.decode('utf-8', 'replace'))
    return json.loads(done.stdout.decode('utf-8').strip())


def judge(container, out, name, sql_bytes, kills):
    folder = out/name
    folder.mkdir()
    (folder/'migration.sql').write_bytes(sql_bytes)
    db = 'w5_' + name.split('-')[0].lower()
    made = run(container, ['createdb', '-U', 'postgres', db])
    applied = run(container, ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db, '-f', '-'], sql_bytes)
    (folder/'apply.log').write_bytes(b'$ createdb ' + db.encode() + b' -> ' + str(made.returncode).encode() + b'\n' + made.stdout +
        made.stderr + b'$ psql -f - (migration.sql) -> ' + str(applied.returncode).encode() + b'\n' + applied.stdout + applied.stderr)
    record = dict(variant=name, database=db, sha256=hashlib.sha256(sql_bytes).hexdigest(), bytes=len(sql_bytes),
                  applied=made.returncode == 0 and applied.returncode == 0, kills=kills)
    if record['applied']:
        rows = json.dumps(transfer.insert_receipt_rows('2.25.4242.20'))
        seed = ('INSERT INTO "ReportDraftInsertReceipt" SELECT * FROM json_populate_recordset(NULL::"ReportDraftInsertReceipt", '
                + transfer.sql_literal(rows) + '::json); SELECT to_jsonb(count(*)) FROM "ReportDraftInsertReceipt"')
        record['seeded'] = query(container, db, seed)
        record['catalog'] = query(container, db, CATALOG)
        record['states'] = query(container, db, transfer.receipt_probe_sql())
        record['differences'] = transfer.receipt_probe_differences(record['states'])
    if kills is None:
        record['verdict'] = 'pass' if record['applied'] and record.get('seeded') == 3 and not record['differences'] else 'control-failed'
    elif not record['applied'] or record.get('seeded') != 3:
        record['verdict'] = 'broken'
    else:
        record['verdict'] = 'killed' if kills in record['differences'] else 'survived'
    (folder/'probes.json').write_text(json.dumps(record, indent=1, sort_keys=True) + '\n', encoding='utf-8')
    return record


def main():
    container, out = sys.argv[1], Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=False)
    base = MIGRATION.read_bytes()
    results = [judge(container, out, 'control-real-migration', base, None)]
    if results[0]['verdict'] == 'pass':
        for name, mutant in MUTANTS.items():
            results.append(judge(container, out, name, variant_bytes(base, mutant['edits']), mutant['kills']))
    summary = dict(migration=MIGRATION.relative_to(ROOT).as_posix(), migration_sha256=hashlib.sha256(base).hexdigest(),
                   results=[{key: r.get(key) for key in ('variant', 'sha256', 'applied', 'kills', 'verdict', 'differences', 'catalog')}
                            for r in results])
    summary['ok'] = (results[0]['verdict'] == 'pass' and len(results) == 1 + len(MUTANTS)
                     and all(r['verdict'] == 'killed' for r in results[1:]))
    (out/'summary.json').write_text(json.dumps(summary, indent=1, sort_keys=True) + '\n', encoding='utf-8')
    print(json.dumps(summary, indent=1, sort_keys=True))
    return 0 if summary['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
