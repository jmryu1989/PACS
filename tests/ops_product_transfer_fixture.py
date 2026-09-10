"""Hosted CI product-schema synthetic restore; no live PACS data or credentials."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import traceback
import uuid

import ops_combined_transfer_fixture as combined
import ops_product_transfer_worker as worker

orth, pg = combined.orth, combined.pg
image_transfer, inventory = combined.image_transfer, combined.inventory
require, command, record = combined.require, combined.command, combined.record
LIMITS = combined.LIMITS
# The 32-table catalog plus synthetic rows now exceeds 128 KiB (136,191
# bytes measured). Keep producer, bounded copy and parser on one finite cap.
RECEIPT_LIMIT = 256*1024
QUERY_LIMIT = 256*1024
PROFILE = 'synthetic-product-v1'
MIGRATIONS = ['api/prisma/migrations/0_init/migration.sql',
              'api/prisma/migrations/20260907040000_viewer_history/migration.sql',
              'api/prisma/migrations/20260908020000_workspace_layout/migration.sql',
              'api/prisma/migrations/20260908081500_connect_gate/migration.sql',
              'api/prisma/migrations/20260908120000_manual_sr/migration.sql',
              'api/prisma/migrations/20260908180000_viewer_jobs/migration.sql',
              'api/prisma/migrations/20260908200000_manual_sr_recovery/migration.sql',
              'api/prisma/migrations/20260909060000_saved_filter_organization/migration.sql',
              'api/prisma/migrations/20260909100000_tech_note_revision/migration.sql',
              'api/prisma/migrations/20260909180000_worklist_columns/migration.sql',
              'api/prisma/migrations/20260909220000_favorite_workspace/migration.sql',
              'api/prisma/migrations/20260909233000_study_tags/migration.sql',
              'api/prisma/migrations/20260910000500_reader_assignment/migration.sql',
              'api/prisma/migrations/20260910013000_reading_preferences/migration.sql',
              'api/prisma/migrations/20260910023000_reading_appearance/migration.sql',
              'api/prisma/migrations/20260910044500_workspace_shortcuts/migration.sql',
              'api/prisma/migrations/20260910090000_filter_folders/migration.sql',
              'api/prisma/migrations/20260910100000_shared_filters/migration.sql',
              'api/prisma/migrations/20260910110000_study_consultation/migration.sql']
TABLES = sorted(['AuthSession', 'Institution', 'StudyState', 'Report', 'ReportVersion',
                 'ReportDraft', 'Order', 'UserFilter', 'ReadingTemplate', 'AuditLog',
                 'ViewerItem', 'ViewerRevision', 'ViewerStorageBudget', 'ViewerRequest', 'WorkspaceLayout', 'WorklistColumns',
                 'TransferBasis', 'ProcessingAgreement', 'Transfer', 'ViewerJob', 'ViewerJobRevision', 'ManualSr', 'TechNoteRevision',
                 'FavoriteWorkspace', 'StudyTagCatalog', 'ReaderAssignment', 'ReadingPreferences', 'ReadingAppearance', 'WorkspaceShortcuts', 'UserFilterCollection', 'SharedFilterLibrary', 'StudyConsultation'])
SEQUENCES = ['AuditLog_id_seq', 'ReadingTemplate_id_seq', 'ReportVersion_id_seq', 'UserFilter_id_seq']
STAMP = '2026-09-06T00:00:00.123'
PRODUCT_FIELDS = {'migrations', 'study_uid', 'catalog', 'rows', 'sequences'}


class ProductMismatch(ValueError):
    """A successful engine observation differed from its expected product data."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def uid_contract(value):
    require(type(value) is str and len(value) <= 64 and re.fullmatch(r'[0-9]+(?:\.[0-9]+)+', value))


def migration_sources():
    names = command(['git', 'ls-tree', '-r', '--name-only', 'HEAD', 'api/prisma/migrations']).decode().splitlines()
    require([name for name in names if name.endswith('/migration.sql')] == MIGRATIONS)
    values = [command(['git', 'show', 'HEAD:'+path]) for path in MIGRATIONS]
    require(all(0 < len(raw) <= 128*1024 for raw in values))
    return values


def migration_records():
    return [dict(path=path, sha256=image_transfer.sha(raw)) for path, raw in zip(MIGRATIONS, migration_sources())]


def expected_rows(uid):
    uid_contract(uid)
    rows = {name: [] for name in TABLES}
    rows['ReadingAppearance'] = [dict(institution='SYNTHETIC-hospital',subject='SYNTHETIC-sub',revision=3,sizes=dict(version=3,list=16,current=18,prior=20,
        fonts=dict(version=1,list='sans',current='mono',prior='serif'),colors=dict(version=1,list='warm',current='white',prior='cool'),dock=dict(version=1,placement='top',panel=1)),updatedAt=STAMP)]
    rows['ReadingPreferences'] = [dict(institution='SYNTHETIC-hospital',subject='SYNTHETIC-sub',revision=2,autoNote=True,updatedAt=STAMP)]
    shortcuts = dict(list='Digit1',image='Digit2',prior='Digit3',report='KeyR',context='Digit5',
        note='Digit6',tools='Digit7',nativeTools='Digit9',previous='ArrowLeft',next='ArrowRight')
    rows['WorkspaceShortcuts'] = [dict(institution=institution,subject=subject,revision=revision,
        bindings=dict(shortcuts,report=report),updatedAt=STAMP) for institution,subject,revision,report in
        [('SYNTHETIC-hospital','SYNTHETIC-sub',2,'KeyR'), ('SYNTHETIC-tele','SYNTHETIC-sub',3,'KeyT'),
         ('SYNTHETIC-hospital','SYNTHETIC-other',4,'KeyY')]]
    rows['TechNoteRevision'] = [dict(studyUid=uid, version=1, text='SYNTHETIC tech note', reason='', author='SYNTHETIC-tech', authorSub='SYNTHETIC-sub', institutionId='SYNTHETIC-hospital', createdAt=STAMP)]
    rows['Institution'] = [dict(id='SYNTHETIC-'+kind, name='SYNTHETIC '+kind, type=kind,
        dicomNames='SYNTHETIC', createdAt=STAMP) for kind in ('hospital', 'tele')]
    rows['StudyState'] = [dict(uid=uid, institutionId='SYNTHETIC-hospital', teleInstitutionId='SYNTHETIC-tele',
        origin='dicom', rs='R', holdReason=None, ss='Verified', em='N', ts='none', matched='U', ward='',
        reqHosp='SYNTHETIC', repDoc='SYNTHETIC-reader', confirm=None, preDoc=None, preReviewer=None,
        ov=None, orig=None, orderOid=None, holder=None, heldAt=None, updatedAt=STAMP, createdAt=STAMP)]
    rows['Report'] = [dict(uid=uid, findings='SYNTHETIC findings\n합성', conclusion='SYNTHETIC conclusion',
        recommendation='', version=2, updatedBy='SYNTHETIC-reader', updatedAt=STAMP)]
    rows['ReportVersion'] = [dict(id=number, uid=uid, version=number, action='Save',
        findings='SYNTHETIC history '+str(number), conclusion='', recommendation='', reason=None,
        author='SYNTHETIC-reader', at=STAMP) for number in (1, 2)]
    rows['ReportDraft'] = [dict(uid=uid, author='SYNTHETIC-reader'+str(number),
        findings='SYNTHETIC private '+str(number), conclusion='', recommendation='', baseVersion=2,
        updatedAt=STAMP) for number in (1, 2)]
    rows['UserFilter'] = [dict(id=1, owner='SYNTHETIC-reader', name='SYNTHETIC saved search',
        mode='Radiology', isDefault=True, quick='SYNTHETIC', days=-1, cols='{}', sortKey='date',
        sortDir=-1, folder='SYNTHETIC/CT', description='SYNTHETIC follow-up', ordinal=7, createdAt=STAMP)]
    rows['UserFilterCollection'] = [dict(owner='SYNTHETIC-reader', revision=3, folders=[
        dict(path='SYNTHETIC/Empty', description='SYNTHETIC empty folder', ordinal=2)])]
    rows['SharedFilterLibrary'] = [dict(institution='SYNTHETIC-owner', revision=4,
        folders=[dict(path='SYNTHETIC/Shared', description='Shared metadata', ordinal=3)],
        filters=[dict(id=805, name='SYNTHETIC shared search', mode='Radiology', quick='', days=-1,
            cols={'mod':'CT'}, sortKey='date', sortDir=-1, folder='SYNTHETIC/Shared', description='Shared criteria', ordinal=2)],
        updatedBy='SYNTHETIC-reader', updatedAt=STAMP)]
    item_id = '00000000-0000-4000-8000-000000000001'
    snapshot = dict(schemaVersion=1, kind='key', seriesUid=uid+'.1', sopUid=uid+'.2',
                    frame=1, title='SYNTHETIC key', description='', hidden=True)
    # PostgreSQL jsonb::text uses a space after separators for this ASCII snapshot.
    rows['ViewerItem'] = [dict(id=item_id, studyUid=uid, authorSub='SYNTHETIC-sub', authorActor='SYNTHETIC-reader',
        revision=2, hidden=True, snapshot=snapshot, createdAt=STAMP, updatedAt=STAMP)]
    snapshots = [{**snapshot, 'hidden': False}, snapshot]
    rows['ViewerRevision'] = [dict(itemId=item_id, revision=n+1, snapshot=value,
        action='create' if n==0 else 'hide', reason='' if n==0 else 'SYNTHETIC reason',
        actor='SYNTHETIC-reader', payloadBytes=len(json.dumps(value).encode()), at=STAMP) for n,value in enumerate(snapshots)]
    rows['ViewerStorageBudget'] = [dict(studyUid=uid, itemCount=1, revisionCount=2,
        payloadBytes=sum(row['payloadBytes'] for row in rows['ViewerRevision']))]
    rows['ViewerRequest'] = [dict(authorSub='SYNTHETIC-sub', requestId='00000000-0000-4000-8000-00000000000'+str(n),
        fingerprint=str(n)*64, itemId=item_id, revision=n) for n in (1,2)]
    layout = dict(version=2, mode='auto', portrait=dict(top=280), landscape=dict(main=720),
        reading=dict(version=1,reportWidth=540,imageHeight=390,relatedHeight=None,
            relatedListHeight=180,relatedHidden=True))
    rows['WorkspaceLayout'] = [dict(institution='SYNTHETIC-'+kind, subject='SYNTHETIC-sub', revision=revision,
        value=value, updatedAt=STAMP) for kind,revision,value in
        [('hospital', 2, json.dumps(layout, separators=(',', ':'))), ('tele', 3, None)]]
    columns = dict(version=1, modes={mode:dict(order=['id','name','age'],hidden=['age']) for mode in ('Radiology','Technician')})
    rows['WorklistColumns'] = [dict(institution='SYNTHETIC-'+kind, subject='SYNTHETIC-sub', revision=revision,
        value=value, updatedAt=STAMP) for kind,revision,value in
        [('hospital', 2, json.dumps(columns, separators=(',', ':'))), ('tele', 3, None)]]
    basis_id, agreement_id, transfer_id = ['00000000-0000-4000-8000-00000000010'+str(n) for n in (1,2,3)]
    job_id='00000000-0000-4000-8000-000000000201'
    job_snapshot=dict(version=1,studies=[uid],rows=1,cols=1,active=0,cells=[dict(study=uid,series=uid+'.1',sop=uid+'.2',frame=1,
        sourceDigest='a'*32,camera=dict(focalPoint=[1,2,0],position=[1,2,1000],viewUp=[0,-1,0],viewPlaneNormal=[0,0,1],parallelScale=128,rotation=0,flipHorizontal=False,flipVertical=False),
        properties=dict(voiRange=dict(lower=-1000,upper=-1),VOILUTFunction='LINEAR',invert=False))])
    rows['ViewerJob']=[dict(id=job_id,studyUid=uid,authorSub='SYNTHETIC-sub',authorActor='SYNTHETIC-reader',studies=[uid],fingerprint='a'*64,
        snapshot=job_snapshot,title='SYNTHETIC job',description='SYNTHETIC description',hidden=True,revision=2,createdAt=STAMP,updatedAt=STAMP)]
    rows['ViewerJobRevision']=[dict(jobId=job_id,revision=n,title='SYNTHETIC job',description='SYNTHETIC description',hidden=n==2,
        reason='' if n==1 else 'SYNTHETIC hide',actor='SYNTHETIC-reader',at=STAMP) for n in (1,2)]
    # Include ownership, replay receipts and saved-view references in the exact
    # dump comparison, rather than accepting empty newly added product tables.
    rows['FavoriteWorkspace']=[dict(institution='SYNTHETIC-hospital',subject='SYNTHETIC-sub',revision=3,
        value=json.dumps([dict(id='00000000-0000-4000-8000-000000000501',name='SYNTHETIC folder',uids=[uid],views={uid:job_id})]),
        lastRequest='00000000-0000-4000-8000-000000000502',lastFingerprint='b'*64,updatedAt=STAMP)]
    rows['StudyTagCatalog']=[dict(institution='SYNTHETIC-hospital',ownerSub=owner,revision=n,
        value=json.dumps([dict(id='00000000-0000-4000-8000-00000000060'+str(n),name='SYNTHETIC tag '+str(n),uids=[uid])]),
        lastRequest=None if n==1 else '00000000-0000-4000-8000-000000000603',
        lastFingerprint=None if n==1 else 'c'*64,updatedAt=STAMP) for n,owner in [(1,'SYNTHETIC-sub'),(2,'')]]
    rows['StudyConsultation']=[dict(id='00000000-0000-4000-8000-000000000901',studyUid=uid,
        institutionId='SYNTHETIC-hospital',requesterSub='SYNTHETIC-sub',requesterActor='SYNTHETIC-reader',
        recipientSub='SYNTHETIC-consultant',recipientActor='SYNTHETIC-consultant',recipientName='SYNTHETIC consultant',
        reason='SYNTHETIC request',reply='SYNTHETIC reply',cancelReason=None,state='Completed',revision=3,
        changedBy='SYNTHETIC-consultant',creationFingerprint='e'*64,
        lastRequest='00000000-0000-4000-8000-000000000902',lastFingerprint='f'*64,createdAt=STAMP,updatedAt=STAMP)]
    rows['ReaderAssignment']=[dict(studyUid=uid,institutionId='SYNTHETIC-hospital',revision=4,
        readerSub='SYNTHETIC-sub',readerActor='SYNTHETIC-reader',readerName='SYNTHETIC reader',changedBy='SYNTHETIC-admin',
        lastRequest='00000000-0000-4000-8000-000000000701',lastFingerprint='d'*64,updatedAt=STAMP)]
    # Exercise bytea/JSON receipts, pending intent and expired tombstones in the
    # actual dump/restore. These bytes are a synthetic DB marker, not a DICOM.
    rows['ManualSr']=[dict(id='00000000-0000-4000-8000-00000000030'+str(n),studyUid=uid,
        authorSub='SYNTHETIC-sub',authorActor='SYNTHETIC-reader',requestId='00000000-0000-4000-8000-00000000040'+str(n),
        fingerprint=str(n)*64,selection=[dict(id=item_id,revision=2)],sha256='a'*64,createdAt=STAMP,
        dataset=None if n==3 else dict(SOPInstanceUID=uid+'.'+str(n)),dicom=None if n==3 else '\\x'+('01'*132),
        attemptedAt=STAMP if n<3 else None,nextCheckAt=STAMP if n==1 else None,
        storedAt=STAMP if n==2 else None,orthancId='SYNTHETIC-stored' if n==2 else None) for n in (1,2,3)]
    rows['TransferBasis'] = [dict(id=basis_id,studyUid=uid,institutionId='SYNTHETIC-hospital',kind='PATIENT_CONSENT',
        reference='SYNTHETIC consent reference',obtainedAt=STAMP,expiresAt=None,recordedBy='SYNTHETIC-admin',recordedAt=STAMP,
        revokedBy=None,revokedAt=None,revokeReason=None)]
    rows['ProcessingAgreement'] = [dict(id=agreement_id,fromInstitutionId='SYNTHETIC-hospital',toInstitutionId='SYNTHETIC-tele',
        kind='CONTRACT',reference='SYNTHETIC agreement reference',validFrom=STAMP,validTo=None,status='active',
        recordedBy='SYNTHETIC-admin',recordedAt=STAMP,terminatedBy=None,terminatedAt=None,terminationReason=None)]
    rows['Transfer'] = [dict(id=transfer_id,studyUid=uid,fromInstitutionId='SYNTHETIC-hospital',toInstitutionId='SYNTHETIC-tele',
        basisId=basis_id,agreementId=agreement_id,status='OPEN',sourcePatientKey='SYNTHETIC-hospital|SYNTHETIC-patient',
        requestedBy='SYNTHETIC-tech',requestedAt=STAMP,expiresAt='2026-10-06T00:00:00.123',decidedBy=None,decidedAt=None,
        decisionReason=None,localPatientId=None,importRequestedAt=None,importRequestedBy=None,importedAt=None)]
    return rows


def expected_sequences():
    return {name: dict(last_value=2 if name == 'ReportVersion_id_seq' else 1,
                       is_called=name in ('ReportVersion_id_seq', 'UserFilter_id_seq')) for name in SEQUENCES}


def sql_literal(text):
    return "'"+text.replace("'", "''")+"'"


def psql(name, db, sql):
    require(db in {'kin', 'keycloak', 'foreign_source', 'foreign_restore'})
    with tempfile.TemporaryDirectory(prefix='kin-ci-product-query-') as folder:
        target = Path(folder)/'query.json'
        orth.bounded_output(['docker', 'exec', name, 'psql', '-XqAt', '-U', 'postgres', '-d', db,
            '-v', 'ON_ERROR_STOP=1', '-c', "SET timezone='UTC'; SET datestyle='ISO, YMD'; "+sql],
            target, QUERY_LIMIT, timeout=30)
        return target.read_bytes().strip()


def execute(name, db, sql):
    # A fixed final marker gives bounded_output nonempty output even for DDL.
    require(psql(name, db, sql+"; SELECT 'SYNTHETIC-OK';") == b'SYNTHETIC-OK')


def create_product(name, db, uid):
    command(['docker', 'exec', name, 'createdb', '-U', 'postgres', db])
    for raw in migration_sources():
        execute(name, db, raw.decode())
    data = expected_rows(uid)
    for table in ('Institution', 'StudyState', 'Report', 'ReportVersion', 'ReportDraft', 'UserFilter',
                  'ViewerItem', 'ViewerRevision', 'ViewerStorageBudget', 'ViewerRequest', 'WorkspaceLayout', 'WorklistColumns',
                  'TransferBasis', 'ProcessingAgreement', 'Transfer', 'ViewerJob', 'ViewerJobRevision', 'ManualSr', 'TechNoteRevision',
                  'FavoriteWorkspace', 'StudyTagCatalog', 'ReaderAssignment', 'ReadingPreferences', 'ReadingAppearance', 'WorkspaceShortcuts', 'UserFilterCollection', 'SharedFilterLibrary', 'StudyConsultation'):
        rows = data[table]
        for row in rows:
            # SERIAL must actually run; explicit values would hide setval loss.
            fields = [key for key in row if not (table in ('ReportVersion', 'UserFilter') and key == 'id')]
            quoted = ','.join('"'+key+'"' for key in fields)
            execute(name, db, 'INSERT INTO "'+table+'" ('+quoted+') SELECT '+quoted+
                ' FROM json_populate_record(NULL::"'+table+'", '+sql_literal(json.dumps(row))+')')


CATALOG_SQL = """
SELECT jsonb_build_object(
 'tables',(SELECT jsonb_agg(c.relname ORDER BY c.relname COLLATE "C") FROM pg_class c
   JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')),
 'columns',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.table_name COLLATE "C",x.ordinal_position)
   FROM (SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,
     character_maximum_length,numeric_precision,numeric_scale,datetime_precision,is_identity,is_generated
     FROM information_schema.columns WHERE table_schema='public') x),
 'constraints',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.table_name COLLATE "C",x.name COLLATE "C")
   FROM (SELECT c.relname AS table_name,k.conname AS name,k.contype::text AS kind,
     pg_get_constraintdef(k.oid,true) AS definition FROM pg_constraint k
     JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public') x),
 'indexes',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.tablename COLLATE "C",x.indexname COLLATE "C")
   FROM (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public') x),
 'sequence_settings',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.sequencename COLLATE "C")
   FROM (SELECT sequencename,data_type::text,start_value,min_value,max_value,increment_by,cycle,cache_size
     FROM pg_sequences WHERE schemaname='public') x))
"""


def catalog_contract(value):
    require(type(value) is dict and set(value) == {'tables', 'columns', 'constraints', 'indexes', 'sequence_settings'})
    require(value['tables'] == TABLES)
    # The additive appearance table takes the product above 256 columns. Keep
    # byte/output budgets and exact catalog comparison; bound other lists as before.
    require(all(type(value[key]) is list and 0 < len(value[key]) <= (512 if key == 'columns' else 256) for key in value))
    require(sorted(item['sequencename'] for item in value['sequence_settings']) == SEQUENCES)


def observe(name, db):
    catalog = inventory.parse(psql(name, db, CATALOG_SQL))
    catalog_contract(catalog)
    rows = {table: inventory.parse(psql(name, db,
        'SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"), \'[]\'::jsonb) FROM "'+table+'" t'))
        for table in TABLES}
    sequences = {seq: inventory.parse(psql(name, db,
        'SELECT jsonb_build_object(\'last_value\',last_value,\'is_called\',is_called) FROM "'+seq+'"')) for seq in SEQUENCES}
    return dict(catalog=catalog, rows=rows, sequences=sequences)


def sorted_rows(rows):
    return {key: sorted(value, key=canonical) for key, value in rows.items()}


def verify_product(name, db, expected):
    actual = observe(name, db)
    for key in ('catalog', 'rows', 'sequences'):
        left, right = actual[key], expected[key]
        if key == 'rows':
            left, right = sorted_rows(left), sorted_rows(right)
        if canonical(left) != canonical(right):
            raise ProductMismatch('Synthetic product '+key+' mismatch')
    return actual


def product_contract(product):
    require(type(product) is dict and set(product) == PRODUCT_FIELDS)
    uid_contract(product['study_uid'])
    require(product['migrations'] == migration_records())
    catalog_contract(product['catalog'])
    require(canonical(sorted_rows(product['rows'])) == canonical(sorted_rows(expected_rows(product['study_uid']))))
    require(canonical(product['sequences']) == canonical(expected_sequences()))


def relation(snapshot):
    return dict(keycloak_rows=3, keycloak_rows_sha256=image_transfer.sha(combined.expected_rows(snapshot)))


def parse_receipt(raw, expected, expected_product, context):
    require(type(expected) is str and inventory.HEX.fullmatch(expected) and len(raw) <= RECEIPT_LIMIT
            and image_transfer.sha(raw) == expected)
    body = inventory.parse(raw)
    require(type(body) is dict and set(body) == combined.FIELDS | {'profile', 'product'}
            and type(body['schema']) is int and body['schema'] == 2 and body['profile'] == PROFILE)
    # Validate the unchanged C12L envelope separately; v2 is never accepted by
    # its v1 consumer, even though the bounded artifact filenames are identical.
    legacy = {key: body[key] for key in combined.FIELDS}
    legacy['schema'] = 1
    require(canonical(body['relation']) == canonical(relation(body['snapshot'])))
    legacy['relation'] = combined.relation(body['snapshot'])
    legacy_raw = canonical(legacy)
    combined.parse_receipt(legacy_raw, image_transfer.sha(legacy_raw), legacy['relation']['rows_sha256'], context)
    require(type(expected_product) is str and inventory.HEX.fullmatch(expected_product)
            and image_transfer.sha(canonical(body['product'])) == expected_product)
    product_contract(body['product'])
    return body


def build_orthanc(token):
    with tempfile.TemporaryDirectory(prefix='kin-ci-product-image-') as folder:
        folder = Path(folder)
        image_transfer.write(folder/'worker.py', Path(worker.__file__).read_bytes())
        image_transfer.write(folder/'base.py', Path(orth.worker.__file__).read_bytes())
        image_transfer.write(folder/'Dockerfile', ('FROM '+orth.BASE+'\nCOPY --chmod=0444 worker.py /fixture.py\n'
            'COPY --chmod=0444 base.py /ops_orthanc_transfer_worker.py\nUSER 65534:65534\n'
            'ENTRYPOINT ["python3"]\nCMD '+json.dumps(orth.CMD)+'\n'
            'LABEL kin.ci.orthanc="'+token+'" kin.ci.base="'+orth.BASE+'"\n').encode())
        command(['docker', 'build', '--pull', '--platform=linux/amd64', '--network=none',
            '--iidfile', str(folder/'iid'), '-t', combined.tags(token)['orthanc'], str(folder)], timeout=240)
        identity = (folder/'iid').read_text().strip()
        require(inventory.IMAGE.fullmatch(identity))
        return identity


def keycloak_rows(name, snapshot):
    actual = psql(name, 'keycloak', combined.SELECT)+b'\n'
    require(actual == combined.expected_rows(snapshot))
    return dict(count=3, sha256=image_transfer.sha(actual))


def restore(name, db, path):
    command(['docker', 'exec', name, 'createdb', '-U', 'postgres', db])
    with path.open('rb') as incoming:
        command(['docker', 'exec', '-i', name, 'pg_restore', '-U', 'postgres', '-d', db,
            '--no-owner', '--no-privileges', '--exit-on-error'], stdin=incoming, timeout=120)


def constraint_probes(name, product):
    uid = sql_literal(product['study_uid'])
    sql = '''BEGIN; DO $$ BEGIN
      BEGIN INSERT INTO "ReportVersion" (id,uid,version,action,author)
        VALUES(99,UID,1,'SYNTHETIC','SYNTHETIC');
        RAISE EXCEPTION 'missing version unique'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN INSERT INTO "Report" (uid,"updatedAt") VALUES('2.25.0','2026-09-06');
        RAISE EXCEPTION 'missing report FK'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN INSERT INTO "ReportDraft" SELECT * FROM "ReportDraft" LIMIT 1;
        RAISE EXCEPTION 'missing draft PK'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN DELETE FROM "StudyState" WHERE uid=UID;
        RAISE EXCEPTION 'missing viewer study restriction'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN DELETE FROM "ViewerItem";
        RAISE EXCEPTION 'missing viewer history restriction'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN DELETE FROM "ViewerRevision";
        RAISE EXCEPTION 'missing viewer replay restriction'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN INSERT INTO "WorkspaceLayout" SELECT * FROM "WorkspaceLayout" LIMIT 1;
        RAISE EXCEPTION 'missing workspace owner PK'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "WorkspaceLayout" SET revision=0;
        RAISE EXCEPTION 'missing workspace revision constraint'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "WorkspaceLayout" SET value=repeat('x',2049);
        RAISE EXCEPTION 'missing workspace byte constraint'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN INSERT INTO "WorklistColumns" SELECT * FROM "WorklistColumns" LIMIT 1;
        RAISE EXCEPTION 'missing columns owner PK'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "WorklistColumns" SET revision=0;
        RAISE EXCEPTION 'missing columns revision constraint'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "WorklistColumns" SET value=repeat('x',8193);
        RAISE EXCEPTION 'missing columns byte constraint'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "Transfer" SET status='UNKNOWN';
        RAISE EXCEPTION 'missing transfer status check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN INSERT INTO "Transfer" SELECT * FROM json_populate_record(NULL::"Transfer",
        (SELECT (to_jsonb(t)||jsonb_build_object('id','00000000-0000-4000-8000-000000000199'))::json FROM "Transfer" t LIMIT 1));
        RAISE EXCEPTION 'missing active transfer unique'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "Transfer" SET "basisId"='00000000-0000-4000-8000-000000000199';
        RAISE EXCEPTION 'missing transfer basis FK'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN UPDATE "TransferBasis" SET "revokedAt"=now(),"revokedBy"='SYNTHETIC';
        RAISE EXCEPTION 'missing revocation reason check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyConsultation" SET state='Bogus';
        RAISE EXCEPTION 'missing consultation state'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyConsultation" SET revision=0;
        RAISE EXCEPTION 'missing consultation revision'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyConsultation" SET "recipientSub"="requesterSub";
        RAISE EXCEPTION 'missing consultation participants'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyConsultation" SET "studyUid"='2.25.0';
        RAISE EXCEPTION 'missing consultation study FK'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN UPDATE "StudyConsultation" SET state='Requested';
        INSERT INTO "StudyConsultation" SELECT * FROM json_populate_record(NULL::"StudyConsultation",
          (SELECT (to_jsonb(t)||jsonb_build_object('id','00000000-0000-4000-8000-000000000999'))::json FROM "StudyConsultation" t LIMIT 1));
        RAISE EXCEPTION 'missing active consultation unique'; EXCEPTION WHEN unique_violation THEN NULL; END;
    END $$; ROLLBACK'''.replace('UID', uid)
    execute(name, 'kin', sql)
    verify_product(name, 'kin', product)
    return dict(version_unique=True, report_study_fk=True, draft_composite_pk=True,
                viewer_restrict=True, rolled_back_unchanged=True)


def negative_restore(name, folder, product):
    foreign_uid = '2.25.1' if product['study_uid'] != '2.25.1' else '2.25.2'
    create_product(name, 'foreign_source', foreign_uid)
    execute(name, 'foreign_source', 'UPDATE "ReportVersion" SET findings=\'SYNTHETIC foreign history\'')
    path = folder/'foreign.dump'
    orth.bounded_output(['docker', 'exec', name, 'pg_dump', '-U', 'postgres', '-Fc', 'foreign_source'],
        path, LIMITS['kin.dump'], timeout=120)
    # Engine restore must finish successfully before the mismatch may count.
    restore(name, 'foreign_restore', path)
    try:
        verify_product(name, 'foreign_restore', product)
    except ProductMismatch as error:
        require(str(error) == 'Synthetic product rows mismatch')
    else:
        raise ValueError('Foreign synthetic dump unexpectedly accepted')
    verify_product(name, 'kin', product)
    return dict(valid_dump_restored=True, wrong_study_and_history_rejected=True)


def produce(destination):
    context = image_transfer.ci_context()
    combined.disk_preflight()
    migration_records()
    token, identities = uuid.uuid4().hex, {}
    resources = combined.names(token)
    destination.mkdir(mode=0o700)
    try:
        identities['orthanc'] = build_orthanc(token)
        identities['postgres'] = combined.build_postgres(token)
        images = {}
        for key, module in combined.COMPONENTS.items():
            path = destination/(key+'-image.tar')
            orth.bounded_output(['docker', 'image', 'save', combined.tags(token)[key]], path, LIMITS[path.name], timeout=180)
            config = module.image_config(path, identities[key], token)
            images[key] = dict(image_id=identities[key], config_id=config[0] if key == 'orthanc' else config, base=module.BASE)
        orth.start_container(identities['orthanc'], resources['orthanc'], token)
        observed = inventory.parse(command(['docker', 'exec', resources['orthanc'], 'python3', '/fixture.py', 'produce'], timeout=90))
        require(set(observed) == {'snapshot', 'study_uid'})
        snapshot, uid = observed['snapshot'], observed['study_uid']
        orth.worker.snapshot_contract(snapshot)
        uid_contract(uid)
        orth.bounded_output(['docker', 'exec', resources['orthanc'], 'cat', '/work/store.tar'], destination/'store.tar', LIMITS['store.tar'], timeout=30)
        pg.start_database(identities['postgres'], resources['postgres'], token)
        name = resources['postgres']
        create_product(name, 'kin', uid)
        product = dict(observe(name, 'kin'), migrations=migration_records(), study_uid=uid)
        product_contract(product)
        command(['docker', 'exec', name, 'createdb', '-U', 'postgres', 'keycloak'])
        rows = combined.expected_rows(snapshot).decode().splitlines()
        values = ','.join('('+row.split('|')[0]+",'"+row.split('|')[1]+"','"+row.split('|')[2]+"')" for row in rows)
        execute(name, 'keycloak', 'CREATE TABLE fixture_attachment(file_type integer PRIMARY KEY, instance text NOT NULL, sha256 text NOT NULL); INSERT INTO fixture_attachment VALUES'+values)
        keycloak_rows(name, snapshot)
        for db in pg.DATABASES:
            orth.bounded_output(['docker', 'exec', name, 'pg_dump', '-U', 'postgres', '-Fc', db], destination/(db+'.dump'), LIMITS[db+'.dump'], timeout=120)
        body = dict(schema=2, profile=PROFILE, code_sha=context['code_sha'], run_id=context['run_id'], run_attempt=context['run_attempt'],
            producer_boot_id=context['boot_id'], token=token, images=images, snapshot=snapshot, relation=relation(snapshot),
            product=product, files={name: record(destination/name, limit) for name, limit in LIMITS.items()})
        combined.verify_files(destination, body)
        verify_product(name, 'kin', product)
        raw = canonical(body)
        require(len(raw) <= RECEIPT_LIMIT)
        image_transfer.write(destination/'receipt.json', raw)
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
            output.write('receipt_sha256='+image_transfer.sha(raw)+'\nproduct_sha256='+image_transfer.sha(canonical(product))+'\n')
        return dict(synthetic_product_archive_prepared=True, product_sha256=image_transfer.sha(canonical(product)),
                    row_counts={key: len(value) for key, value in product['rows'].items()}, migrations=product['migrations'])
    finally:
        combined.cleanup(token, identities, resolve_tags=True)


def consume(source, expected, expected_product):
    context = image_transfer.ci_context()
    combined.disk_preflight()
    require(not source.is_symlink() and source.is_dir() and {path.name for path in source.iterdir()} == set(LIMITS) | {'receipt.json'})
    with tempfile.TemporaryDirectory(prefix='kin-ci-product-restore-') as folder:
        folder = Path(folder)
        orth.copy_download(source/'receipt.json', folder/'receipt.json', RECEIPT_LIMIT)
        body = parse_receipt((folder/'receipt.json').read_bytes(), expected, expected_product, context)
        for name, limit in LIMITS.items():
            orth.copy_download(source/name, folder/name, limit)
        layers = combined.verify_files(folder, body)
        identities = {key: body['images'][key]['image_id'] for key in combined.COMPONENTS}
        absent = [image_transfer.inspect_image(identity) is None for identity in identities.values()]
        require(all(absent))
        cache = orth.cached_layers(layers)
        token, resources = body['token'], combined.names(body['token'])
        try:
            for key, module in combined.COMPONENTS.items():
                command(['docker', 'image', 'load', '--input', str(folder/(key+'-image.tar'))], timeout=120)
                loaded = image_transfer.inspect_image(identities[key])
                require(loaded is not None)
                module.settings(loaded.get('Config'), token)
            pg.start_database(identities['postgres'], resources['postgres'], token)
            name = resources['postgres']
            for db in pg.DATABASES:
                restore(name, db, folder/(db+'.dump'))
            verify_product(name, 'kin', body['product'])
            kc = keycloak_rows(name, body['snapshot'])
            constraints = constraint_probes(name, body['product'])
            negative = negative_restore(name, folder, body['product'])
            orth.start_container(identities['orthanc'], resources['orthanc'], token)
            with (folder/'store.tar').open('rb') as incoming:
                restored = inventory.parse(command(['docker', 'exec', '-i', resources['orthanc'], 'python3', '/fixture.py', 'consume',
                    json.dumps(dict(snapshot=body['snapshot'], study_uid=body['product']['study_uid']), sort_keys=True)], stdin=incoming, timeout=120))
            require(restored == dict(instance=body['snapshot']['instance'], attachments=body['snapshot']['attachments'],
                rest_bytes_match=True, sqlite_integrity=True, uid=65534, study_uid=body['product']['study_uid']))
            combined.verify_files(folder, body)
            require(all(record(source/file, limit) == body['files'][file] for file, limit in LIMITS.items()))
            require(record(source/'receipt.json', RECEIPT_LIMIT)['sha256'] == expected)
        finally:
            combined.cleanup(token, identities)
    return dict(synthetic_product_schema_restored=True, product_sha256=expected_product, migrations=body['product']['migrations'],
        row_counts={key: len(value) for key, value in body['product']['rows'].items()}, sequences=body['product']['sequences'],
        constraints=constraints, negative=negative, keycloak_fixture_rows=kc, orthanc=restored,
        producer_boot_id=body['producer_boot_id'], consumer_boot_id=context['boot_id'], both_images_originally_absent=True,
        source_unchanged=True, preexisting_image_referenced_layers=cache, unreferenced_layer_cache_verified=False,
        base_labels_are_producer_declarations=True, full_restore_verified=False, offsite_backup_verified=False,
        deployment_authorized=False, unverified=['real_keycloak_schema', 'api_keycloak_authentication', 'institution_access',
            'service_append_only', 'report_state_transitions', 'reporting_viewer', 'tls', 'cron', 'encryption_keys', 'external_destination'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['produce', 'consume'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--receipt-sha256')
    parser.add_argument('--product-sha256')
    args = parser.parse_args()
    try:
        result = produce(args.directory) if args.mode == 'produce' else consume(args.directory, args.receipt_sha256, args.product_sha256)
        print(json.dumps(result))
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as output:
            output.write('```json\n'+json.dumps(result, indent=2)+'\n```\n')
        return 0
    except Exception as error:
        print(json.dumps({'synthetic_product_schema_restored': False, 'error_type': type(error).__name__}), file=sys.stderr)
        traceback.print_exc()
        if isinstance(error, subprocess.CalledProcessError):
            print((error.stderr or b'')[-4096:].decode(errors='replace'), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
