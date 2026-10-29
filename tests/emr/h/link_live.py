"""H_LINK: real held backup, daily restore, server-key recovery and existing expiry.

Synthetic PostgreSQL and owned volumes only. Medical Rules art.15(1) periods
remain owned by emr-contract; restore invokes the ordinary H/B expiry sweep.
REQ-EMR-17 -> RISK-H-04 (expired restore) / RISK-H-05 (key lifetime) -> TEST-H-LINK;
REQ-EMR-19 -> RISK-EMR-LOSS (emr_audit, emr_image counts) -> TEST-H-LINK.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
sys.path.insert(0, str(ROOT / 'scripts'))
import pg_ledger_restore_test as pg
import ops_backup as ops


class ImageDeliveryRetention(pg.PgLedgerFixture):
    """H-04: expiry through the shipped PG boundary, including #244 details.

    A retained terminal/hold and a second delivery keep their shared manifest.
    Receipts retain only their existing retry binding after payload expiry.
    """
    def scalar(self, sql):
        return self.sql(sql).stdout.strip()

    def event(self, action, at='2020-01-01T00:00:00Z', related=None):
        event, operation, attempt = (str(uuid.uuid4()) for _ in range(3))
        payload = json.dumps(dict(eventId=event, occurredAt=at, userId={'synthetic': True},
            action=action, result='prepared' if action == 'provide-prepared' else 'succeeded',
            relatedEventId=related, targets=[dict(kind='image', recordId=dict(status='known', value=event),
            versionId=dict(status='known', value='synthetic-version'))]))
        literal = "'" + payload.replace("'", "''") + "'"
        self.sql(f"SELECT emr_access.admit_operation('{operation}','{attempt}',{literal},'열람')", 'kin_runtime')
        self.sql(f"SELECT emr_access.append_operation('{operation}','{attempt}',{literal},'열람',NULL,NULL,NULL)", 'kin_runtime')
        return event

    def expire(self, event, check=True):
        entry = self.scalar(f"SELECT entry_id FROM emr_access.access_entry WHERE event_id='{event}'")
        return self.sql(f"SELECT emr_access.expire_entry('{entry}')", 'kin_emr_retention', check=check)

    def test_delivery_details_follow_last_retained_access_record(self):
        first = self.event('provide-prepared')
        terminal = self.event('transfer-ended', related=first)
        second = self.event('provide-prepared')
        live = self.event('provide-prepared', at='2099-01-01T00:00:00Z')
        manifest = hashlib.sha256(first.encode()).hexdigest()
        self.sql(f"INSERT INTO emr_image.source_manifest(body_sha256,study_uid,body) VALUES ('{manifest}','2.25.701',"
            f"'{{\"studyUid\":\"2.25.701\",\"sha256\":\"{manifest}\"}}')")
        for delivery in (first, second, live):
            self.sql(f"INSERT INTO emr_image.preparation(event_id,delivery_event_id,request_id,study_uid,"
                f"source_manifest_body,response_manifest,staging_copies) VALUES ('{uuid.uuid4()}','{delivery}',"
                f"'synthetic-request','2.25.701','{manifest}','{{}}','[]')")
            # No preparation for this response: failed preparation's late copy observation.
            self.sql(f"INSERT INTO emr_image.observation(event_id,delivery_event_id,request_id,kind,body,retained_after) "
                f"VALUES ('{uuid.uuid4()}','{delivery}','synthetic-failed-request','copies','[]','SyntheticWriteRefused')")
        hold = str(uuid.uuid4())
        fact = dict(holdId=hold, recordId=terminal, basis='synthetic hold', actorId='fixture',
            at='2020-01-01T00:00:00Z', release=None)
        self.sql(f"SELECT emr_access.place_hold('{hold}','{terminal}','{json.dumps(fact)}')", 'kin_runtime')
        self.expire(first)
        self.assertNotEqual(self.expire(terminal, check=False).returncode, 0)
        self.assertEqual(self.scalar(f"SELECT count(*) FROM emr_image.preparation WHERE delivery_event_id='{first}'"), '1')
        self.assertEqual(self.scalar(f"SELECT count(*) FROM emr_image.observation WHERE delivery_event_id='{first}'"), '1')
        self.assertNotEqual(self.expire(live, check=False).returncode, 0)
        fact['release'] = dict(actorId='fixture', at='2020-01-02T00:00:00Z', reason='synthetic resolution')
        self.sql(f"SELECT emr_access.release_hold('{hold}','{json.dumps(fact)}')", 'kin_runtime')
        self.expire(terminal)
        self.assertEqual(self.scalar(f"SELECT count(*) FROM emr_image.preparation WHERE delivery_event_id='{first}'"), '0')
        self.assertEqual(self.scalar(f"SELECT count(*) FROM emr_image.observation WHERE delivery_event_id='{first}'"), '0')
        self.assertEqual(self.scalar(f"SELECT count(*) FROM emr_image.source_manifest WHERE body_sha256='{manifest}'"), '1')
        self.expire(second)
        self.assertEqual(self.scalar(f"SELECT count(*) FROM emr_image.preparation WHERE delivery_event_id='{live}'"), '1')
        # Advance the fixture clock fact, never the product's period or hold rules.
        self.sql(f"UPDATE emr_access.access_entry SET occurred_at='2020-01-01' WHERE event_id='{live}'")
        sweep = json.loads(self.scalar("SELECT emr_access.restore_expiry_sweep('{}')"))
        self.assertEqual(sweep['deletedEntries'], 1)
        self.assertEqual(self.scalar(f"SELECT count(*) FROM emr_image.source_manifest WHERE body_sha256='{manifest}'"), '0')
        self.assertEqual(self.scalar(f"SELECT count(*) FROM emr_access.entry_receipt WHERE event_id IN ('{first}','{terminal}','{second}','{live}')"), '4')
        self.assertEqual(self.scalar(f"SELECT count(*) FROM emr_access.disposal_fact d JOIN emr_access.entry_receipt r USING(entry_id) "
            f"WHERE r.event_id IN ('{first}','{terminal}','{second}','{live}')"), '4')


class RetentionBackupLink(pg.PgLedgerFixture):
    admin_user = 'kin'
    database_name = 'kin'
    disk_storage = True

    def test_capture_restore_relocation_and_expiry(self):
        evidence = ROOT / 'tmp/emr-h-link' / self.token
        evidence.mkdir(parents=True)
        scratch = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='h-link-')))
        config = ROOT
        from urllib.parse import urlsplit
        # A fresh synthetic checkout has no .env. Exclusive creation cannot replace a real installation's inputs.
        with (config / '.env').open('x', encoding='utf8') as stream:
            stream.write('POSTGRES_PASSWORD=' + urlsplit(self.witness_url).password
                + '\nKIN_EMR_RUNTIME_PASSWORD=' + self.runtime_password + '\n')
        self.addCleanup((config / '.env').unlink)
        self.sql('CREATE DATABASE keycloak')
        self.command(['docker', 'exec', self.container, 'psql', '-X', '-U', 'kin', '-d', 'keycloak',
                      '-c', "CREATE TABLE synthetic_realm(id text); INSERT INTO synthetic_realm VALUES ('H_LINK')"])
        secret = scratch / 'live.key'
        secret.write_bytes(secrets.token_bytes(32))
        generated = self.image_command(['node', '-e', """
const c=require('/app/dist/emr-signature/server-crypto'),crypto=require('node:crypto');
const pair=c.generateServerKeyPair(),kid=crypto.randomUUID();
console.log(JSON.stringify({kid,publicKey:pair.publicKey,
 wrapped:c.wrapServerPrivateKey(pair.privateKey,kid,'synthetic-wrap',Buffer.from(process.env.H_WRAP,'hex'))}));
"""], {'H_WRAP': secret.read_bytes().hex()})
        self.assertEqual(generated.returncode, 0, generated.stderr)
        key = json.loads(generated.stdout)
        literal = lambda value: "'" + json.dumps(value).replace("'", "''") + "'"
        self.sql(f"""INSERT INTO emr_signing.doctor_key VALUES
          ('{key['kid']}','synthetic-hospital','synthetic-doctor','active',{literal({'publicKey':key['publicKey']})});
          INSERT INTO emr_signing.private_key VALUES ('{key['kid']}',{literal(key['wrapped'])});
          INSERT INTO emr_signing.key_history(kid,event) VALUES ('{key['kid']}','{{"action":"registered"}}');
          INSERT INTO emr_audit.fixed_copy VALUES ('synthetic-issuance',decode('000102ff','hex'),
            '{hashlib.sha256(bytes([0,1,2,255])).hexdigest()}');
          INSERT INTO emr_audit.issuance_event(issuance_id,institution_id,body)
            VALUES ('synthetic-issuance','synthetic-hospital','{{"synthetic":true}}');
          INSERT INTO emr_image.preparation(event_id,study_uid,source_manifest,response_manifest,staging_copies)
            VALUES ('{uuid.uuid4()}','SYNTHETIC-H','{{"sha256":"source-bytes"}}','{{"format":"original"}}','[]');
          INSERT INTO emr_image.observation(event_id,kind,body)
            VALUES ('{uuid.uuid4()}','copies','{{"synthetic":true}}');""")
        expired, held = str(uuid.uuid4()), str(uuid.uuid4())
        for failure in (expired, held):
            self.sql(f"SELECT emr_access.record_failure('{failure}',NULL,'{failure}','2020-01-01','ledger-unreachable')", 'kin_runtime')
        # Existing retention suite supplies the full lawful hold graph; this failure hold is a stored actual constraint.
        hold = str(uuid.uuid4())
        body = dict(holdId=hold,recordId=held,release=None,basis='synthetic hold',
                    actorId='fixture',at='2020-01-01T00:00:00Z')
        self.sql(f"SELECT emr_access.place_hold('{hold}','{held}',{literal(body)})", 'kin_runtime')
        custody_config = scratch / 'custody.json'
        custody_config.write_text(json.dumps({'backup_root':str(scratch / 'custody'),
                                              'files':{'synthetic-wrap':str(secret)}}))
        containers = {'db': self.container}
        volumes = {'pg': self.container + '-data'}
        for role, target in [('orthanc','/var/lib/orthanc/db'), ('emr_state',ops.EMR_STATE)]:
            volume = self.container + '-' + role
            self.command(['docker','volume','create','--label','kin.b2r='+self.token,volume])
            self.created_volumes.append(volume)
            volumes[role] = volume
        index = scratch / 'index'
        with sqlite3.connect(index) as db:
            db.execute('CREATE TABLE AttachedFiles(uuid TEXT, compressedSize INTEGER)')
        orthanc = os.environ.get('KIN_TEST_ORTHANC_IMAGE','orthancteam/orthanc:24.12.0')
        created = []
        def cleanup_writers():
            for name in created:
                self.command(['docker','rm','-f','-v',name])
        self.addCleanup(cleanup_writers)
        for role in ops.WRITER_ROLES:
            name = self.container + '-' + role
            args = ['docker','create','--name',name,'--label','kin.b2r='+self.token,'--network','none']
            if role == 'api': args += ['-v',volumes['emr_state']+':'+ops.EMR_STATE]
            if role == 'orthanc': args += ['-v',volumes['orthanc']+':/var/lib/orthanc/db']
            image = self.image if role == 'api' else orthanc if role == 'orthanc' else 'postgres:16-alpine'
            self.command(args + ['--entrypoint','sleep',image,'infinity'])
            created.append(name)
            containers[role] = name
        self.command(['docker','cp',str(index),containers['orthanc']+':/var/lib/orthanc/db/index'])
        # The real API image's recovery reader owns its empty failure-spool directory.
        uid = self.image_command(['id','-u'],{}).stdout.strip()
        gid = self.image_command(['id','-g'],{}).stdout.strip()
        self.command(['docker','run','--rm','--network','none','-v',volumes['emr_state']+':/state',
                      '--entrypoint','chown','postgres:16-alpine',uid+':'+gid,'/state'])
        resources = {'containers':containers,'volumes':volumes}
        with patch.object(ops,'ROOT',config), patch.dict(os.environ,{'KIN_EMR_WRAPPING_CUSTODY':str(custody_config)}):
            held_snapshot = ops.capture_held(scratch / 'backups', resources, shape='post', label='h-link')
        manifest = json.loads((held_snapshot / 'manifest.json').read_text())
        self.assertTrue(manifest['complete'])
        self.assertGreater(ops.signing_key_count(manifest), 0)
        # First restore the actual held capture with its per-table value comparison.
        ops.rehearse(held_snapshot)
        held_result = json.loads(sorted(held_snapshot.glob('rehearsal-*.json'))[-1].read_text())
        self.assertTrue(held_result['success'])
        self.assertEqual(held_result['wrapping_custody']['keys'],1)
        # Exercise the daily catalog-replay consumer with the same actual captured dumps.
        # backup() makes private daily folders; rotation refuses a group/world-readable root or set.
        (scratch / 'daily').mkdir(mode=0o700)
        daily = scratch / 'daily' / ('20261026-000000-' + self.token[:8])
        daily.mkdir(mode=0o700)
        daily_manifest = {k:manifest[k] for k in ('format','complete','created_utc','git_sha','postgres_image',
                          'orthanc_image','running_images','emr','wrapping_custody')}
        # backup() records the cluster role catalog (not a held capture's per-object catalog.json).
        daily_manifest['role_catalog'] = ops.role_catalog(self.container)
        daily_manifest['counts'] = {d:ops.counts(self.container,d,'kin') for d in ('kin','keycloak')}
        for table in ('emr_audit.fixed_copy','emr_image.preparation','emr_signing.private_key'):
            self.assertEqual(daily_manifest['counts']['kin'][table],1)
        for name in ops.backup_components(daily_manifest):
            shutil.copyfile(held_snapshot / name, daily / name)
        daily_manifest['sha256'] = {n:ops.digest(daily / n) for n in ops.backup_components(daily_manifest)}
        daily_manifest['bytes'] = {n:(daily / n).stat().st_size for n in ops.backup_components(daily_manifest)}
        ops.write_json(daily / 'manifest.json',daily_manifest)
        source_hash = ops.digest(daily / 'kin.dump')
        moved = scratch / 'fresh-host-custody'
        shutil.move(manifest['wrapping_custody']['directory'],moved)
        secret.unlink()
        # The RED main lacks this operator-selected path; the final tree must restore on the new host path.
        ops.rehearse(daily, wrapping_source=moved)
        result = json.loads(sorted(daily.glob('rehearsal-*.json'))[-1].read_text())
        self.assertTrue(result['success'])
        self.assertEqual(result['cleanup_failures'],[])
        self.assertEqual(result['wrapping_custody']['keys'],1)
        self.assertEqual(result['emr']['expiry_sweep']['deletedFailures'],1)
        self.assertEqual(result['emr']['expiry_sweep']['retainedByDutyOrHold'],1)
        self.assertEqual(ops.digest(daily / 'kin.dump'),source_hash)
        self.assertEqual(self.sql('SELECT count(*) FROM emr_access.failure_entry').stdout.strip(),'2')
        ops.write_json(evidence / 'held-result.json',held_result)
        ops.write_json(evidence / 'daily-result.json',result)
        # A loss in either new schema must fail the actual daily restore before expiry/business use.
        for table in ('emr_audit.fixed_copy','emr_image.preparation'):
            daily_manifest['counts']['kin'][table] += 1
            ops.write_json(daily / 'manifest.json',daily_manifest)
            with self.assertRaisesRegex(RuntimeError,'row counts differ'):
                ops.rehearse(daily, wrapping_source=moved)
            daily_manifest['counts']['kin'][table] -= 1
        ops.write_json(daily / 'manifest.json',daily_manifest)
        latest = daily.parent / ('20261026-000001-' + self.token[:8])
        shutil.copytree(daily,latest)
        rotation_root = scratch / 'rotation-custody'
        custody_config.write_text(json.dumps({'backup_root':str(rotation_root),
            'files':{'synthetic-wrap':str(moved / 'wrap-0.key')}}))
        with patch.object(ops,'ROOT',config), patch.dict(os.environ,{'KIN_EMR_WRAPPING_CUSTODY':str(custody_config)}):
            for folder in (daily,latest):
                saved = json.loads((folder / 'manifest.json').read_text())
                ops.capture_wrapping_custody(folder,saved,self.container)
                ops.write_json(folder / 'manifest.json',saved)
            rotation = ops.rotate(daily.parent,keep=1)
        self.assertEqual(rotation['status'],'complete')
        self.assertEqual(rotation['deleted'],[daily.name])
        self.assertFalse((rotation_root / daily.name).exists())
        self.assertTrue((rotation_root / latest.name / 'wrap-0.key').is_file())
        self.assertTrue((latest / 'kin.dump').is_file())
        ops.write_json(evidence / 'rotation-result.json',rotation)
        ops.write_json(evidence / 'source-preserved.json',{'dump_sha256':source_hash,
                       'source_failure_rows':2,'f_link_12_missing_rows_refused':True})


if __name__ == '__main__':
    unittest.main(verbosity=2)
