"""CD-09 real CLI/PG boundary, synthetic data only.

REQ-EMR-17, REQ-EMR-19 -> RISK-H-06 -> TEST-CD09-LEDGER-LIVE, TEST-CD09-S01/S02/S04/S05/S09 (PostgreSQL part).
The shipped retention entry, under the retention login, against a fixture database migrated by the same image:
native report units destroyed with their versions, signatures, signing operations and head; retained, held,
released-hold and unsigned units untouched; drafts and the shared StudyState untouched; the deleting fence, the ACL
and the all-or-nothing deletion step. Images (Orthanc, derived copies) are CD-09b, so every run is incomplete (exit 1).
Run through scripts/run-tests.py with the existing PgLedgerFixture admission.
"""
import hashlib
import json
from pathlib import Path
import secrets
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
import pg_ledger_restore_test as pg

FIXTURE = ROOT / 'tests/emr/retention/signed_report.cjs'
KID = 'kid-cd09-synthetic'


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


class RetentionFixture(pg.PgLedgerFixture):
    def retention_url(self):
        password = secrets.token_hex(24)
        self.sql(f"ALTER ROLE kin_emr_retention LOGIN PASSWORD '{password}'")
        # Only a role on this fixture's isolated DB; never the API credential.
        return self.runtime_url.replace('kin_runtime:' + self.runtime_password, 'kin_emr_retention:' + password)

    def run_entry(self, url):
        result = self.image_command(['node', '/app/dist/emr-retention/entry.js'], {'DATABASE_URL': url})
        return result, (json.loads(result.stdout) if result.stdout.strip() else None)

    def scalar(self, statement, role=None):
        return self.sql(statement, role).stdout.strip()

    def signed(self, reports):
        """Signs with the image's own compiled canonical payload; the private key never leaves the run."""
        spec = dict(kid=KID, doctorId='SYNTHETIC-doctor', institutionId='SYNTHETIC-hospital',
                    registeredAt='2014-01-01T00:00:00.000Z', reports=reports)
        result = self.command(self.image_args(['node', '/app/signed_report.cjs', json.dumps(spec)], {},
                                              mounts=[(FIXTURE, '/app/signed_report.cjs')]), check=False)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        return json.loads(result.stdout)

    def seed_report(self, uid, versions, signed_at, *, sign=True, head=True):
        """One study's native report: StudyState, every version, its signed approval and signing operation."""
        reports = [dict(uid=uid, versions=[dict(version=i + 1, action=a, reason='SYNTHETIC reason' if a == 'reset' else None,
                                                signedAt=signed_at[i]) for i, a in enumerate(versions)])]
        out = self.signed(reports)
        statements = [f"""INSERT INTO emr_signing.doctor_key(kid,institution_id,doctor_id,status,registration)
          VALUES ('{KID}','SYNTHETIC-hospital','SYNTHETIC-doctor','active',{literal(json.dumps(out['registration']))}::jsonb)
          ON CONFLICT (kid) DO NOTHING;""",
                      f"""INSERT INTO "StudyState"(uid,"updatedAt") VALUES ({literal(uid)}, now());"""]
        for i, action in enumerate(versions):
            statements.append(f"""INSERT INTO "ReportVersion"(uid,version,action,findings,conclusion,recommendation,reason,author)
              VALUES ({literal(uid)},{i + 1},{literal(action)},'SYNTHETIC finding {i}','SYNTHETIC conclusion {i}','',
                {literal('SYNTHETIC reason') if action == 'reset' else 'NULL'},'SYNTHETIC-doctor');""")
        if sign:
            for approval in out['approvals']:
                outcome = json.dumps(approval['outcome'])
                statements.append(f"""INSERT INTO emr_signing.signed_version(record_id,version_id,kid,outcome)
                  VALUES ({literal(uid)},{literal(approval['versionId'])},'{KID}',{literal(outcome)}::jsonb);
                  INSERT INTO emr_signing.operation(operation_id,fingerprint,outcome)
                  VALUES ({literal(approval['outcome']['operationId'])},'SYNTHETIC',{literal(outcome)}::jsonb);""")
        if head:
            statements.append(f"""INSERT INTO "Report"(uid,findings,conclusion,recommendation,version,"updatedAt")
              VALUES ({literal(uid)},'SYNTHETIC head','SYNTHETIC head','',{len(versions)},now());""")
        self.sql('\n'.join(statements))

    def report_rows(self, uid):
        """Every stored byte of one unit, for exact before/after comparison."""
        q = literal(uid)
        return self.scalar(f"""SELECT md5(concat_ws('|',
          (SELECT string_agg(row_to_json(v)::text, ',' ORDER BY id) FROM "ReportVersion" v WHERE uid={q}),
          (SELECT string_agg(row_to_json(s)::text, ',' ORDER BY version_id) FROM emr_signing.signed_version s WHERE record_id={q}),
          (SELECT string_agg(row_to_json(o)::text, ',' ORDER BY operation_id) FROM emr_signing.operation o WHERE outcome->>'recordId'={q}),
          (SELECT row_to_json(r)::text FROM "Report" r WHERE uid={q})))""")

    def remaining(self, uid):
        q = literal(uid)
        return self.scalar(f"""SELECT (SELECT count(*) FROM "ReportVersion" WHERE uid={q}) || ',' ||
          (SELECT count(*) FROM emr_signing.signed_version WHERE record_id={q}) || ',' ||
          (SELECT count(*) FROM emr_signing.operation WHERE outcome->>'recordId'={q}) || ',' ||
          (SELECT count(*) FROM "Report" WHERE uid={q})""")


class RetentionWorkerLedgerLive(RetentionFixture):
    def test_shipped_entry_expiry_hold_retry_and_incomplete_status(self):
        url = self.retention_url()
        expired, held, future = (str(uuid.uuid4()) for _ in range(3))
        for identity, at in [(expired, '2020-01-01'), (held, '2020-01-01'), (future, '2099-01-01')]:
            self.sql(f"SELECT emr_access.record_failure('{identity}',NULL,'{identity}',"
                     f"'{at}','ledger-unreachable')", 'kin_runtime')
        hold = str(uuid.uuid4())
        body = json.dumps(dict(holdId=hold, recordId=held, release=None,
                               basis='synthetic hold', actorId='fixture', at='2020-01-01T00:00:00Z'))
        self.sql(f"SELECT emr_access.place_hold('{hold}','{held}','{body}')", 'kin_runtime')
        first, result = self.run_entry(url)
        self.assertEqual(first.returncode, 1, first.stderr)
        self.assertEqual(result['status'], 'incomplete')
        self.assertEqual(result['open'], ['image-destruction'])
        self.assertEqual(result['ledger']['deletedFailures'], 1)
        self.assertEqual(result['ledger']['retainedByDutyOrHold'], 1)
        remaining = self.sql("SELECT failure_id FROM emr_access.failure_entry ORDER BY failure_id").stdout.split()
        self.assertEqual(set(remaining), {held, future})
        self.assertEqual(self.sql(f"SELECT count(*) FROM emr_access.disposal_fact WHERE failure_id='{expired}'")
                         .stdout.strip(), '1')
        second, again = self.run_entry(url)
        self.assertEqual(second.returncode, 1, second.stderr)
        self.assertEqual(again['ledger']['deletedFailures'], 0)
        # A failed read must not produce a successful JSON run or erase more rows.
        refused, output = self.run_entry(self.runtime_url)
        self.assertEqual(refused.returncode, 1)
        self.assertIsNone(output)
        self.assertEqual(set(self.sql("SELECT failure_id FROM emr_access.failure_entry").stdout.split()),
                         {held, future})


class RetentionWorkerReportLive(RetentionFixture):
    def test_expired_units_destroyed_others_untouched_acl_and_repeat(self):
        url = self.retention_url()
        # CD09-S04: the retention login reaches the deletion only through the owner's functions.
        self.assertNotEqual(self.sql('DELETE FROM "ReportVersion";', 'kin_emr_retention', check=False).returncode, 0)
        self.assertNotEqual(self.sql('DELETE FROM emr_signing.signed_version;', 'kin_emr_retention', check=False).returncode, 0)
        self.assertNotEqual(self.sql('SELECT count(*) FROM emr_signing.private_key;', 'kin_emr_retention', check=False).returncode, 0)
        self.assertIn('RetentionExecutionRequired', self.sql(
            f"SELECT emr_access.delete_operational_rows('{uuid.uuid4()}');", 'kin_emr_retention', check=False).stderr)
        for statement in [f"SELECT emr_access.delete_operational_rows('{uuid.uuid4()}');",
                          "SELECT * FROM emr_access.register_retention_units('report', ARRAY['x']);",
                          "INSERT INTO emr_access.retention_journal(operation_id,kind,phase,disposal_unit_id,occurred_at,body) "
                          f"VALUES ('{uuid.uuid4()}','operational-deletion','started','disposal:{uuid.uuid4()}',now(),'{{}}');"]:
            self.assertIn('permission denied', self.sql(statement, 'kin_runtime', check=False).stderr, statement)

        old = ['2015-03-02T01:00:00.000Z', '2015-03-02T02:00:00.000Z']
        expired, recent, held, released, unsigned = (f'1.2.826.0.1.3680043.9.{n}' for n in range(5))
        self.seed_report(expired, ['approve', 'addendum'], old)
        self.seed_report(recent, ['approve'], ['2025-06-01T00:00:00.000Z'])
        self.seed_report(held, ['approve'], old[:1])
        self.seed_report(released, ['approve'], old[:1])
        self.seed_report(unsigned, ['approve'], old[:1], sign=False)
        for record, release in [(held, False), (released, True)]:
            hold = 'SYNTHETIC-hold-' + record[-1]
            body = json.dumps(dict(holdId=hold, recordId=record, release=None, basis='synthetic', actorId='fixture', at='2016-01-01T00:00:00.000Z'))
            self.sql(f"SELECT emr_access.place_hold({literal(hold)},{literal(record)},{literal(body)})", 'kin_runtime')
            if release:
                self.sql(f"SELECT emr_access.release_hold({literal(hold)},{literal(json.dumps(dict(json.loads(body), release=dict(holdId=hold))))})", 'kin_runtime')
        # CD09-S09: drafts end in place in the product; a live draft and a cleared marker of the same study survive.
        self.sql(f"""INSERT INTO "ReportDraft"(uid,author,findings,conclusion,recommendation,present,"updatedAt") VALUES
          ({literal(expired)},'SYNTHETIC-other','SYNTHETIC live draft','','',true,now()),
          ({literal(expired)},'SYNTHETIC-doctor','','','',false,now());""")
        kept = {uid: self.report_rows(uid) for uid in (recent, held, released, unsigned)}
        drafts = self.scalar(f'SELECT md5(string_agg(row_to_json(d)::text, \',\' ORDER BY author)) FROM "ReportDraft" d')

        run, result = self.run_entry(url)
        self.assertEqual(run.returncode, 1, run.stderr)
        self.assertEqual(result['status'], 'incomplete', result)
        self.assertEqual(result['failure'], None)
        self.assertEqual(result['open'], ['image-destruction'])
        self.assertEqual(result['uncovered'], [])
        # Expired in 2020 and destroyed only now: the completion is recorded late, with the missing reason flagged.
        self.assertEqual(result['statutory'], dict(due=1, destroyed=1, retained=1, held=1, overdue=1, delayReasonMissing=1,
                                                   unsupported={'released-hold-history': 1, 'report-version-unsigned': 1}))
        self.assertEqual(result['purpose'], dict(live=1, cleared=1, inconsistent=0))
        # CD09-S01: no operational row of the expired unit is left; the receipt and the set completion agree.
        self.assertEqual(self.remaining(expired), '0,0,0,0')
        self.assertEqual(self.scalar(f'SELECT count(*) FROM "StudyState" WHERE uid={literal(expired)}'), '1')
        self.assertEqual(self.scalar(f'SELECT md5(string_agg(row_to_json(d)::text, \',\' ORDER BY author)) FROM "ReportDraft" d'), drafts)
        for uid, before in kept.items():
            self.assertEqual(self.report_rows(uid), before, uid)
        journal = json.loads(self.scalar("SELECT json_agg(json_build_object('phase',phase,'op',operation_id,'unit',disposal_unit_id,"
                                         "'body',body) ORDER BY sequence) FROM emr_access.retention_journal"))
        self.assertEqual([j['phase'] for j in journal], ['started', 'completed'])
        self.assertEqual(len({j['op'] for j in journal}), 1)
        completed = journal[1]['body']
        self.assertEqual((completed['formatVersion'], completed['kind'], completed['method'], completed['partCount'], completed['timeliness']),
                         (2, 'operational-deletion', 'operational-store-deletion', 2, 'overdue'))
        self.assertEqual(completed['delayReasonStatus'], 'missing')
        self.assertNotIn('1.2.826', json.dumps(journal), 'the destruction ledger names no study')
        self.assertEqual(self.scalar("SELECT count(*) || ',' || bool_and(confirmed_at IS NOT NULL) FROM emr_access.retention_commit"), '1,t')
        self.assertEqual(self.scalar(f"""SELECT count(*) FROM emr_access.retention_unit WHERE record_id={literal(expired)}"""), '0')
        self.assertEqual(self.scalar("SELECT count(*) FROM emr_access.retention_unit"), '4')
        self.assertEqual(self.scalar("SELECT count(*) FROM emr_access.retention_execution"), '0')
        units = self.scalar("SELECT string_agg(disposal_unit_id, ',' ORDER BY record_id) FROM emr_access.retention_unit")

        # A repeated run finds nothing more to do, mints no new unit ID and journals nothing.
        again, second = self.run_entry(url)
        self.assertEqual(again.returncode, 1, again.stderr)
        self.assertEqual((second['statutory']['due'], second['statutory']['destroyed'], second['reconcile']['resumed']), (0, 0, 0))
        self.assertEqual(self.scalar("SELECT count(*) FROM emr_access.retention_journal"), '2')
        self.assertEqual(self.scalar("SELECT string_agg(disposal_unit_id, ',' ORDER BY record_id) FROM emr_access.retention_unit"), units)
        # CD09-P06 on the real catalog: a table no adapter reads yet is named, never read as empty.
        self.sql("""INSERT INTO "WorklistColumns"(institution,subject,revision,value,"updatedAt")
          VALUES ('SYNTHETIC-hospital','SYNTHETIC-user',1,NULL,now());""")
        third, census = self.run_entry(url)
        self.assertEqual(third.returncode, 1, third.stderr)
        self.assertEqual(census['uncovered'], ['public."WorklistColumns"'])


class RetentionWorkerFenceLive(RetentionFixture):
    def started_body(self, operation, unit):
        return dict(formatVersion=2, kind='operational-deletion', revision=1, operationId=operation, phase='started',
                    occurredAt='2026-01-01T00:00:00.000Z', day='2026-01-01', disposalUnitId=unit, classes=['imageReport'],
                    clauseIds=['medical-rules:15.1.6'], partCount=1, expiryDay='2020-03-01', extensionUsed=False,
                    dueDay='2020-03-06', timeliness='overdue', method='operational-store-deletion', justifiedDelay=None,
                    delayReasonStatus='missing', basis='privacy-act-21-and-decree-16-1-1')

    def begin(self, uid, targets, operation=None):
        operation = operation or str(uuid.uuid4())
        unit = self.scalar(f"SELECT disposal_unit_id FROM emr_access.register_retention_units('report', ARRAY[{literal(uid)}])", 'kin_emr_retention')
        self.sql(f"""SELECT emr_access.begin_retention_execution('{operation}', ARRAY[{literal(unit)}], ARRAY[{literal(uid)}],
          '2020-03-01T15:00:00Z', 'SYNTHETIC-revision', {literal(json.dumps(targets))}::jsonb)""", 'kin_emr_retention')
        return operation, unit

    def targets(self, uid):
        rows = json.loads(self.scalar(f"""SELECT json_build_object(
          'versions', (SELECT json_agg(id ORDER BY id) FROM "ReportVersion" WHERE uid={literal(uid)}),
          'signed', (SELECT json_agg(version_id ORDER BY version_id) FROM emr_signing.signed_version WHERE record_id={literal(uid)}),
          'operations', (SELECT json_agg(operation_id ORDER BY operation_id) FROM emr_signing.operation WHERE outcome->>'recordId'={literal(uid)}))"""))
        return ([dict(schema='emr_signing', table='signed_version', key=dict(record_id=uid, version_id=v)) for v in rows['signed']] +
                [dict(schema='emr_signing', table='operation', key=dict(operation_id=o)) for o in rows['operations']] +
                [dict(schema='public', table='ReportVersion', key=dict(id=i)) for i in rows['versions']] +
                [dict(schema='public', table='Report', key=dict(uid=uid))])

    def test_fence_rollback_abandon_and_resume(self):
        url = self.retention_url()
        old = ['2015-03-02T01:00:00.000Z', '2015-03-02T02:00:00.000Z']
        fenced, partial, unstarted = '1.2.826.0.1.3680043.8.1', '1.2.826.0.1.3680043.8.2', '1.2.826.0.1.3680043.8.3'
        for uid in (fenced, partial, unstarted):
            self.seed_report(uid, ['approve', 'addendum'], old)
        # A target outside the closed list, of another record, or without its full key is refused before any fence.
        for bad, code in [([dict(schema='public', table='StudyState', key=dict(uid=fenced))], 'RetentionStoreUnsupported'),
                          ([dict(schema='public', table='Report', key=dict(uid=partial))], 'RetentionTargetNotOwned'),
                          ([dict(schema='emr_signing', table='signed_version', key=dict(record_id=fenced))], 'CompletePrimaryKeyRequired')]:
            stderr = self.sql(f"""SELECT emr_access.begin_retention_execution('{uuid.uuid4()}',
              ARRAY[(SELECT disposal_unit_id FROM emr_access.register_retention_units('report', ARRAY[{literal(fenced)}]))], ARRAY[{literal(fenced)}],
              '2020-03-01T15:00:00Z','SYNTHETIC',{literal(json.dumps(bad))}::jsonb)""", 'kin_emr_retention', check=False).stderr
            self.assertIn(code, stderr)
        operation, unit = self.begin(fenced, self.targets(fenced))
        # CD09-S05: while the set is being deleted no writer adds a version, signature, head change or hold to it.
        before = self.report_rows(fenced)
        for statement in [f"""INSERT INTO "ReportVersion"(uid,version,action,findings,conclusion,recommendation,author)
                              VALUES ({literal(fenced)},3,'addendum','SYNTHETIC late','','','SYNTHETIC-doctor');""",
                          f"""UPDATE "Report" SET findings='SYNTHETIC late' WHERE uid={literal(fenced)};""",
                          f"""INSERT INTO emr_signing.signed_version(record_id,version_id,kid,outcome)
                              VALUES ({literal(fenced)},'9','{KID}','{{}}'::jsonb);"""]:
            self.assertIn('RetentionDeleting', self.sql(statement, check=False).stderr, statement)
        hold_body = json.dumps(dict(holdId='SYNTHETIC-late-hold', recordId=fenced, release=None, basis='synthetic', actorId='fixture', at='2026-01-01T00:00:00.000Z'))
        self.assertIn('RetentionDeleting', self.sql(f"SELECT emr_access.place_hold('SYNTHETIC-late-hold',{literal(fenced)},{literal(hold_body)})",
                                                    'kin_runtime', check=False).stderr)
        self.assertEqual(self.report_rows(fenced), before)
        # Without its started journal the deletion step refuses and rolls back.
        self.assertIn('DestructionStartJournalRequired', self.sql(f"SELECT emr_access.delete_operational_rows('{operation}')",
                                                                  'kin_emr_retention', check=False).stderr)
        self.assertEqual(self.report_rows(fenced), before)
        self.sql(f"""INSERT INTO emr_access.retention_journal(operation_id,kind,phase,revision,disposal_unit_id,occurred_at,body)
          VALUES ('{operation}','operational-deletion','started',1,{literal(unit)},'2026-01-01T00:00:00Z',
          {literal(json.dumps(self.started_body(operation, unit)))}::jsonb)""", 'kin_emr_retention')

        # CD09-S04: a set whose fixed targets miss a stored row fails as a whole; nothing of it is deleted.
        short = [t for t in self.targets(partial) if not (t['table'] == 'ReportVersion')] + [self.targets(partial)[-2]]
        partial_op, partial_unit = self.begin(partial, short)
        self.sql(f"""INSERT INTO emr_access.retention_journal(operation_id,kind,phase,revision,disposal_unit_id,occurred_at,body)
          VALUES ('{partial_op}','operational-deletion','started',1,{literal(partial_unit)},'2026-01-01T00:00:00Z',
          {literal(json.dumps(self.started_body(partial_op, partial_unit)))}::jsonb)""", 'kin_emr_retention')
        partial_before = self.report_rows(partial)
        self.assertIn('OperationalRowRemains', self.sql(f"SELECT emr_access.delete_operational_rows('{partial_op}')",
                                                        'kin_emr_retention', check=False).stderr)
        self.assertEqual(self.report_rows(partial), partial_before, 'the failed step is rolled back entirely')
        # An execution whose started journal never became durable deleted nothing and is released.
        self.begin(unstarted, self.targets(unstarted))

        # The entry resumes the started set first; the failing set then stops the run before any new judgement.
        run, result = self.run_entry(url)
        self.assertEqual(run.returncode, 1, run.stderr)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['failure'], 'OperationalRowRemains')
        self.assertEqual(result['reconcile']['resumed'], 1)
        self.assertEqual(self.remaining(fenced), '0,0,0,0')
        self.assertEqual(self.report_rows(partial), partial_before)
        self.assertEqual(self.remaining(unstarted), '2,2,2,1', 'no new judgement after an unfinished set')
        phases = self.scalar(f"SELECT string_agg(phase, ',' ORDER BY sequence) FROM emr_access.retention_journal WHERE operation_id='{operation}'")
        self.assertEqual(phases, 'started,completed')
        self.assertEqual(self.scalar(f"SELECT string_agg(phase, ',' ORDER BY sequence) FROM emr_access.retention_journal WHERE operation_id='{partial_op}'"),
                         'started,failed')
        self.assertEqual(self.scalar(f"SELECT count(*) FROM emr_access.retention_execution WHERE operation_id='{partial_op}'"), '1',
                         'the failed set stays fenced')
        # The next run never releases a started set: it retries the same fixed plan, fails again, and the record
        # stays fenced; nothing is skipped ahead of it.
        again, second = self.run_entry(url)
        self.assertEqual(again.returncode, 1)
        self.assertEqual((second['status'], second['failure']), ('failed', 'OperationalRowRemains'))
        self.assertEqual(self.report_rows(partial), partial_before)
        self.assertEqual(self.remaining(unstarted), '2,2,2,1')
