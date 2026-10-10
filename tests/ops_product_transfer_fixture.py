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
# The 37-table catalog plus synthetic rows exceeds 128 KiB (136,191 bytes
# measured at 32 tables). Keep producer, bounded copy and parser on one finite cap.
# S5-U4a (41 tables): the synthetic rows grew by 2,920 bytes (exact); the whole receipt is estimated at
# about 185 KB from a modelled catalog, pending the hosted producer's actual size.
# S5-U4c (43 tables): the synthetic rows grew by 3,560 bytes (measured with a 34-digit UID; the real UID's length moves
# it by a few bytes per row) and the modelled catalog by about 13 KB (26 columns, 16 constraints, 7 indexes; 411 of
# the 512 columns catalog_contract allows); the whole receipt is estimated at about 203 KB, pending the hosted size.
# S7-U1a (46 tables): measured on a local postgres:16-alpine with a 43-digit UID, the product section (catalog, rows,
# sequences, study UID) grew from 202,084 to 234,975 bytes (+23,025 catalog: 460 columns, 172 constraints, 97 indexes;
# +9,866 rows); with the 32 migration records (4,950 bytes) and the C12L envelope (about 2.3 KB in the pure fixture) the
# whole receipt is about 242 KB, about 20 KB under this cap. The next schema unit should expect to raise it.
# S7-U3a (46 tables, one more ReaderAssignment row): measured the same way (43-digit UID), the product section grew from
# 234,975 to 236,487 bytes (+1,052 catalog: 2 columns, 1 constraint, the pair key's index; +460 rows); with the 33rd
# migration record the whole receipt is about 244 KB, about 18 KB under this cap.
# S7-U5 session end (47 tables: IdpSessionEnd, its two rows, AuthSession.idpSid and two indexes): not measured on a
# stack when written - estimated at about 4 KB of catalog and rows, inside what the cap left; measure with the next run.
# S7-U5 member isolation's call in flight (three columns on MemberIsolation, their values on the owed row): not measured on a
# stack when written - estimated at well under 1 KB of catalog and rows.
# S7-U5 D600 provider change records (49 tables: ProviderChange, its two rows, its sequence and two indexes; the three
# in-flight columns of MemberIsolation dropped): not measured on a stack when written - estimated at about 2 KB.
# S7-U5 core (51 tables, 41 migrations): PG16 observe() plus the pure C12L envelope measures 263,343 bytes
# with a 43-character UID (213,022 catalog; 41,425 rows; 6,217 migration paths/hashes; 801 snapshot).
# 512 KiB leaves about 255 KiB for schema/envelope growth while keeping every receipt read bounded.
RECEIPT_LIMIT = 512*1024
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
              'api/prisma/migrations/20260910110000_study_consultation/migration.sql',
              'api/prisma/migrations/20260910123000_consultation_predicates/migration.sql',
              'api/prisma/migrations/20260910130000_study_access/migration.sql',
              'api/prisma/migrations/20260910133000_study_access_subject/migration.sql',
              'api/prisma/migrations/20260912100000_hanging_protocol_preferences/migration.sql',
              'api/prisma/migrations/20260917120000_findings/migration.sql',
              'api/prisma/migrations/20260920120000_report_citations/migration.sql',
              'api/prisma/migrations/20260921120000_report_structure/migration.sql',
              'api/prisma/migrations/20260924120000_order_accession/migration.sql',
              'api/prisma/migrations/20260924130000_gateway_receipt/migration.sql',
              'api/prisma/migrations/20260924140000_gateway_retry_request/migration.sql',
              'api/prisma/migrations/20260926120000_study_questions/migration.sql',
              'api/prisma/migrations/20260926130000_study_image_requests/migration.sql',
              'api/prisma/migrations/20260928120000_critical_result/migration.sql',
              'api/prisma/migrations/20260928130000_reader_assignment_scope/migration.sql',
              'api/prisma/migrations/20260930120000_audit_log_append_only/migration.sql',
              'api/prisma/migrations/20261004120000_draft_revision_session_entry/migration.sql',
              'api/prisma/migrations/20261005120000_idp_session_end/migration.sql',
              'api/prisma/migrations/20261005130000_member_isolation/migration.sql',
              'api/prisma/migrations/20261006000000_tech_note_attempt_id/migration.sql',
              'api/prisma/migrations/20261006120000_member_isolation_call/migration.sql',
              'api/prisma/migrations/20261007120000_provider_change/migration.sql',
              'api/prisma/migrations/20261007170000_member_db_rights/migration.sql',
              'api/prisma/migrations/20261007200000_designation_subjects/migration.sql',
              'api/prisma/migrations/20261011120000_filter_shortcuts/migration.sql']
TABLES = sorted(['AuthSession', 'IdpSessionEnd', 'MemberIsolation', 'ProviderChange', 'MemberRights', 'MemberRightsImport', 'Institution', 'StudyState', 'Report', 'ReportVersion',
                 'ReportDraft', 'Order', 'UserFilter', 'ReadingTemplate', 'AuditLog',
                 'ViewerItem', 'ViewerRevision', 'ViewerStorageBudget', 'ViewerRequest', 'Finding', 'FindingRevision', 'WorkspaceLayout', 'WorklistColumns',
                 'TransferBasis', 'ProcessingAgreement', 'Transfer', 'ViewerJob', 'ViewerJobRevision', 'ManualSr', 'TechNoteRevision',
                 'FavoriteWorkspace', 'StudyTagCatalog', 'ReaderAssignment', 'ReadingPreferences', 'ReadingAppearance', 'WorkspaceShortcuts', 'HangingProtocolPreference', 'UserFilterCollection', 'SharedFilterLibrary', 'StudyConsultation', 'StudyAccessPolicy', 'StudyAccessRevision',
                 'StudyQuestion', 'StudyQuestionEntry', 'StudyImageRequest', 'StudyImageRequestReceipt',
                 'CriticalResult', 'CriticalResultEvent', 'CriticalResultReceipt',
                 'GatewayReceipt', 'GatewayRetryRequest'])
SEQUENCES = ['AuditLog_id_seq', 'ProviderChange_id_seq', 'ReadingTemplate_id_seq', 'ReportVersion_id_seq', 'UserFilter_id_seq']
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
    protocol = dict(version=1, activeRuleId='00000000-0000-4000-8000-000000000801', rules=[dict(
        id='00000000-0000-4000-8000-000000000801', name='SYNTHETIC CT prior', enabled=True,
        match=dict(modality='CT', retrieveAE=None, bodyPart='CHEST', description=None),
        selectors=[dict(alias='current', role='current', historical=False, modality='CT', retrieveAE=None,
            bodyPart='CHEST', description=None, laterality=None, order='descending', occurrence=1),
          dict(alias='prior', role='related', historical=True, modality='CT', retrieveAE=None,
            bodyPart='CHEST', description=dict(operator='contains', value='SYNTHETIC prior'),
            laterality=None, order='descending', occurrence=1)],
        layout=dict(rows=1, cols=2, cells=['current', 'prior']))])
    rows['HangingProtocolPreference'] = [
        dict(institution='SYNTHETIC-hospital', subject='SYNTHETIC-sub', revision=2, value=protocol, updatedAt=STAMP),
        dict(institution='SYNTHETIC-tele', subject='SYNTHETIC-sub', revision=3, value=None, updatedAt=STAMP),
        dict(institution='SYNTHETIC-hospital', subject='SYNTHETIC-other', revision=4,
            value=dict(version=1, activeRuleId=None, rules=[]), updatedAt=STAMP)]
    shortcuts = dict(list='Digit1',image='Digit2',prior='Digit3',report='KeyR',context='Digit5',
        note='Digit6',tools='Digit7',nativeTools='Digit9',previous='ArrowLeft',next='ArrowRight')
    rows['WorkspaceShortcuts'] = [dict(institution=institution,subject=subject,revision=revision,
        bindings=dict(shortcuts,report=report),updatedAt=STAMP) for institution,subject,revision,report in
        [('SYNTHETIC-hospital','SYNTHETIC-sub',2,'KeyR'), ('SYNTHETIC-tele','SYNTHETIC-sub',3,'KeyT'),
         ('SYNTHETIC-hospital','SYNTHETIC-other',4,'KeyY')]]
    # S8-CTX: a revision from before save attempts had ids (attemptId NULL) and one written by an attempt (a UUID); both
    # must transfer and restore as they are.
    rows['TechNoteRevision'] = [dict(studyUid=uid, version=1, text='SYNTHETIC tech note', reason='', author='SYNTHETIC-tech', authorSub='SYNTHETIC-sub', institutionId='SYNTHETIC-hospital', createdAt=STAMP, attemptId=None),
        dict(studyUid=uid, version=2, text='SYNTHETIC tech note v2', reason='SYNTHETIC correction', author='SYNTHETIC-tech', authorSub='SYNTHETIC-sub', institutionId='SYNTHETIC-hospital', createdAt=STAMP, attemptId='00000000-0000-4000-8000-000000000d01')]
    rows['Institution'] = [dict(id='SYNTHETIC-'+kind, name='SYNTHETIC '+kind, type=kind,
        dicomNames='SYNTHETIC', createdAt=STAMP) for kind in ('hospital', 'tele')]
    rows['StudyState'] = [dict(uid=uid, institutionId='SYNTHETIC-hospital', teleInstitutionId='SYNTHETIC-tele',
        origin='dicom', rs='R', holdReason=None, ss='Verified', em='N', ts='none', matched='U', ward='',
        reqHosp='SYNTHETIC', repDoc='SYNTHETIC-reader', confirm=None, preDoc=None, preReviewer=None, preDocSub="SYNTHETIC-author-sub", preReviewerSub="SYNTHETIC-reviewer-sub",
        ov=None, orig=None, orderOid=None, holder=None, heldAt=None,
        # S7-U5: the draft epoch is a value of the row (rotated by a forced release), not something a restore may re-draw.
        draftEpoch='00000000-0000-4000-8000-0000000000d1', updatedAt=STAMP, createdAt=STAMP)]
    rows['Report'] = [dict(uid=uid, findings='SYNTHETIC findings\n합성', conclusion='SYNTHETIC conclusion',
        recommendation='', version=2, updatedBy='SYNTHETIC-reader', updatedAt=STAMP)]
    # 한 행은 인용을 들고, 한 행은 NULL이다. 둘 다 실제로 왕복해야 "추가 전용"이 말이 된다 —
    # NULL만 있으면 JSONB 칸이 dump/restore를 건너뛰어도 아무도 모른다.
    citation = [dict(v=2, cid='00000000-0000-4000-8000-0000000000c1', field='findings',
        findingId='00000000-0000-4000-8000-0000000000f1', findingRevision=1, sourceIndex=0,
        sourceRef=dict(kind='item', itemId='00000000-0000-4000-8000-0000000000e1', sourceRevision=1),
        linkStateAtInsert='current', headRevisionAtInsert=1, insertedText='SYNTHETIC 인용 줄',
        insertedAt='2026-09-06T00:00:00.123Z', insertedBy='SYNTHETIC-reader')]
    # 구조화 칸도 같은 이유로 한 행은 값을 들고 한 행은 NULL이다. 제품 서식 목록은 비어 있으므로
    # 이 값은 **오직 여기서만** 존재하는 합성 자료다(P5/P6).
    structured = [dict(v=1, sid='00000000-0000-4000-8000-0000000000a1',
        field='findings', templateId='SYN-T1', templateRevision=2, itemCode='SYN-CHOICE',
        valueType='choice', value='c1', unit=None, renderedText='SYNTHETIC-ITEM choice = alpha',
        enteredAt='2026-09-06T00:00:00.123Z', enteredBy='SYNTHETIC-reader')]
    # S7-U1a: the two history rows are a signed approve (v1) and its addendum (v2), so the critical result records below
    # pin real final rows through their composite foreign key and their action copies equal the pinned rows.
    rows['ReportVersion'] = [dict(id=number, uid=uid, version=number, action='approve' if number == 1 else 'addendum',
        findings='SYNTHETIC history '+str(number), conclusion='', recommendation='', reason=None,
        author='SYNTHETIC-reader', citations=citation if number == 2 else None,
        structured=structured if number == 2 else None, at=STAMP) for number in (1, 2)]
    rows['ReportDraft'] = [dict(uid=uid, author='SYNTHETIC-reader'+str(number),
        findings='SYNTHETIC private '+str(number), conclusion='', recommendation='', baseVersion=2,
        citations=citation if number == 1 else None,
        structured=structured if number == 1 else None,
        # S7-U5: the stored boundary. Two present drafts at different revisions and one emptied row (a tombstone:
        # no content, its revision kept) - a restore that lost the revision or the tombstone would let an old write back in.
        revision=4 - number, present=True, updatedAt=STAMP) for number in (1, 2)]
    rows['ReportDraft'].append(dict(uid=uid, author='SYNTHETIC-reader3', findings='', conclusion='', recommendation='',
        baseVersion=0, citations=None, structured=None, revision=5, present=False, updatedAt=STAMP))
    # S4-U2: the Order table had no synthetic row, so a dump that lost the new accession value would
    # pass on an empty table. One unlinked synthetic order carries a real (synthetic) accession.
    rows['Order'] = [dict(oid='SYNTHETIC-order-1', institutionId='SYNTHETIC-hospital', patientId='SYNTHETIC-patient',
        name='SYNTHETIC order', sex='O', birth='', sched='2026-09-06 09:00', modality='CT', descr='SYNTHETIC order',
        ward='', reqDoc='', matched='U', studyUid=None, accession='SYNTHETIC-ACC-1')]
    # S4-U3: one synthetic receipt in a retry state, so BIGINT counts, the UUID epoch and a non-null
    # errorCode all carry real values through the dump (an empty table would pass on nothing).
    rows['GatewayReceipt'] = [dict(studyUid=uid, institutionId='SYNTHETIC-hospital',
        epoch='00000000-0000-4000-8000-000000000c01', seq=7, phase='retry', attempt=2, successCount=3,
        localCount=12, errorCode='stow_http', receivedAt=STAMP)]
    # S4-U4: one Now Retry request bound to exactly that retry receipt state (epoch ...c01, seq 7), so the
    # composite key, the UUID epoch, the BIGINT seq and the timestamp carry real values through the dump.
    rows['GatewayRetryRequest'] = [dict(studyUid=uid, epoch='00000000-0000-4000-8000-000000000c01', seq=7,
        requestedAt=STAMP)]
    rows['UserFilter'] = [dict(id=1, owner='SYNTHETIC-reader', name='SYNTHETIC saved search',
        mode='Radiology', isDefault=True, quick='SYNTHETIC', days=-1, cols='{}', sortKey='date',
        sortDir=-1, folder='SYNTHETIC/CT', description='SYNTHETIC follow-up', ordinal=7, createdAt=STAMP)]
    rows['UserFilterCollection'] = [dict(owner='SYNTHETIC-reader', revision=3, folders=[
        dict(path='SYNTHETIC/Empty', description='SYNTHETIC empty folder', ordinal=2)],
        shortcuts=[dict(id='first', name='SYNTHETIC shortcut', searchId='own:1'),
                   dict(id='missing', name='SYNTHETIC unavailable', searchId='shared:999')])]
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
    # A finding freezes a server copy of the key item above at revision 1; the
    # later hide of that item does not rewrite this copy. ASCII keeps the jsonb
    # text byte count equal to json.dumps for the payload CHECK.
    finding_id = '00000000-0000-4000-8000-000000000a01'
    finding_source = dict(itemId=item_id, revision=1, studyUid=uid, kind='key', seriesUid=uid+'.1', sopUid=uid+'.2',
        frame=1, frameOfReferenceUid=None, label='SYNTHETIC key', values=None, calculator=None, sourceDigest=None,
        authorActor='SYNTHETIC-reader')
    finding_snapshot = dict(schemaVersion=1, title='SYNTHETIC finding', text='SYNTHETIC finding text', hidden=False,
        primary=0, sources=[finding_source])
    finding_snapshots = [finding_snapshot, {**finding_snapshot, 'hidden': True}]
    rows['Finding'] = [dict(id=finding_id, studyUid=uid, authorSub='SYNTHETIC-sub', authorActor='SYNTHETIC-reader',
        revision=2, hidden=True, snapshot=finding_snapshots[1], createdAt=STAMP, updatedAt=STAMP)]
    rows['FindingRevision'] = [dict(findingId=finding_id, revision=n+1, snapshot=value,
        action='create' if n==0 else 'hide', reason='' if n==0 else 'SYNTHETIC reason', actor='SYNTHETIC-reader',
        authorSub='SYNTHETIC-sub', requestId='00000000-0000-4000-8000-000000000b0'+str(n+1), fingerprint=str(n+1)*64,
        payloadBytes=len(json.dumps(value).encode()), at=STAMP) for n,value in enumerate(finding_snapshots)]
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
    access_policy=dict(version=1,restricted=True,startsAt=None,endsAt='2099-01-01T00:00:00.000Z',rules=[dict(patientId=None,modalities=['CT'],dateFrom=None,dateTo=None,studyUids=[uid])])
    rows['StudyAccessPolicy']=[dict(institution='SYNTHETIC-hospital',subject='SYNTHETIC-sub',revision=1,policy=access_policy,reason='SYNTHETIC restriction',updatedBy='SYNTHETIC-admin',updatedAt=STAMP)]
    rows['StudyAccessRevision']=[dict(institution='SYNTHETIC-hospital',subject='SYNTHETIC-sub',revision=1,policy=access_policy,reason='SYNTHETIC restriction',authorSub='SYNTHETIC-admin-sub',author='SYNTHETIC-admin',requestId='00000000-0000-4000-8000-000000000951',fingerprint='d'*64,at=STAMP)]
    rows['StudyConsultation']=[dict(id='00000000-0000-4000-8000-000000000901',studyUid=uid,
        institutionId='SYNTHETIC-hospital',requesterSub='SYNTHETIC-sub',requesterActor='SYNTHETIC-reader',
        recipientSub='SYNTHETIC-consultant',recipientActor='SYNTHETIC-consultant',recipientName='SYNTHETIC consultant',
        reason='SYNTHETIC request',reply='SYNTHETIC reply',cancelReason=None,state='Completed',revision=3,
        changedBy='SYNTHETIC-consultant',creationFingerprint='e'*64,
        lastRequest='00000000-0000-4000-8000-000000000902',lastFingerprint='f'*64,createdAt=STAMP,updatedAt=STAMP)]
    # S5-U4a: one Closed question with its three receipts - the creating entry (seq 1, id = the question id, no report
    # version yet), an answer (seq 2) and the author's close with an empty note (seq 3). Each result is the stored
    # QuestionApplied a replay answers, so the replay receipts, the closing columns and a NULL and a real reportVersion
    # all go through the exact dump comparison (F-19). The rows satisfy revision = entryCount and appliedRevision = seq.
    question_id = '00000000-0000-4000-8000-000000000d01'
    entries = [(question_id, 1, 'question', 'SYNTHETIC question', 'clinician', 'W', None, None, 'Open'),
               ('00000000-0000-4000-8000-000000000d02', 2, 'answer', 'SYNTHETIC answer\n합성', 'radiologist', 'A', 2, 'Open', 'Answered'),
               ('00000000-0000-4000-8000-000000000d03', 3, 'close', '', 'clinician', 'A', 2, 'Answered', 'Closed')]
    rows['StudyQuestion'] = [dict(id=question_id, studyUid=uid, institutionId='SYNTHETIC-hospital',
        authorSub='SYNTHETIC-clinician-sub', authorActor='SYNTHETIC-clinician', authorName='SYNTHETIC clinician',
        state='Closed', revision=3, entryCount=3, closedAt=STAMP, closedByActor='SYNTHETIC-clinician',
        closedByName='SYNTHETIC clinician', closedByRole='clinician', changedBy='SYNTHETIC-clinician',
        createdAt=STAMP, updatedAt=STAMP)]
    rows['StudyQuestionEntry'] = [dict(id=entry_id, questionId=question_id, seq=seq, kind=kind, body=body,
        authorSub='SYNTHETIC-reader-sub' if role == 'radiologist' else 'SYNTHETIC-clinician-sub',
        authorActor='SYNTHETIC-reader' if role == 'radiologist' else 'SYNTHETIC-clinician',
        authorName='SYNTHETIC reader' if role == 'radiologist' else 'SYNTHETIC clinician', authorRole=role,
        reportRs=rs, reportVersion=version, fingerprint=str(seq)*64, appliedRevision=seq,
        result=dict(id=question_id, studyUid=uid, requestId=entry_id,
            action='create' if kind == 'question' else 'answer' if kind == 'answer' else 'close',
            entry=dict(id=entry_id, seq=seq, kind=kind), revision=seq, to=to, at='2026-09-06T00:00:00.123Z',
            **{'from': before}), at=STAMP)
        for entry_id, seq, kind, body, role, rs, version, before, to in entries]
    # S5-U4c: two image requests and their four receipts. A Closed image-transfer request whose counterparty is the
    # tele institution (a real FK value) carries the creating receipt (requestId = request id, revision 1), the accept
    # and the close; an active external-image request with no counterparty id, handler or note carries its creating
    # receipt and sits inside the partial unique index. Each result is the stored ImageRequestApplied a replay
    # answers, so the receipts, the handler and note columns and a NULL and a real counterparty id all go through
    # the exact dump comparison (F-19). The rows satisfy every CHECK of 20260926130000_study_image_requests.
    closed_request, active_request = '00000000-0000-4000-8000-000000000e01', '00000000-0000-4000-8000-000000000e11'
    requester = dict(requesterSub='SYNTHETIC-clinician-sub', requesterActor='SYNTHETIC-clinician',
        requesterName='SYNTHETIC clinician')
    rows['StudyImageRequest'] = [
        dict(id=closed_request, studyUid=uid, institutionId='SYNTHETIC-hospital', kind='image-transfer', **requester,
            counterpartyText='SYNTHETIC receiving hospital', counterpartyInstitutionId='SYNTHETIC-tele',
            reason='SYNTHETIC transfer reason\n합성', state='Closed', revision=3, handlerActor='SYNTHETIC-tech',
            handlerName='SYNTHETIC tech', note='SYNTHETIC processing record', changedBy='SYNTHETIC-tech',
            createdAt=STAMP, updatedAt=STAMP),
        dict(id=active_request, studyUid=uid, institutionId='SYNTHETIC-hospital', kind='external-image', **requester,
            counterpartyText='SYNTHETIC outside clinic', counterpartyInstitutionId=None, reason='SYNTHETIC outside images',
            state='Requested', revision=1, handlerActor=None, handlerName=None, note=None,
            changedBy='SYNTHETIC-clinician', createdAt=STAMP, updatedAt=STAMP)]
    receipts = [(closed_request, closed_request, 'image-transfer', 'SYNTHETIC-clinician-sub', 'create', None, 'Requested', 1),
                ('00000000-0000-4000-8000-000000000e02', closed_request, 'image-transfer', 'SYNTHETIC-tech-sub', 'accept', 'Requested', 'Accepted', 2),
                ('00000000-0000-4000-8000-000000000e03', closed_request, 'image-transfer', 'SYNTHETIC-tech-sub', 'close', 'Accepted', 'Closed', 3),
                (active_request, active_request, 'external-image', 'SYNTHETIC-clinician-sub', 'create', None, 'Requested', 1)]
    rows['StudyImageRequestReceipt'] = [dict(requestId=request_id, imageRequestId=parent, subjectSub=subject,
        action=action, fingerprint=str(index + 5)*64, appliedRevision=revision,
        result=dict(id=parent, studyUid=uid, requestId=request_id, kind=kind, action=action, to=to, revision=revision,
            at='2026-09-06T00:00:00.123Z', **{'from': before}), at=STAMP)
        for index, (request_id, parent, kind, subject, action, before, to, revision) in enumerate(receipts)]
    # S7-U1a: four critical result records (contract S7-U1p section 12.3-3) - an acknowledged one to a clinician (v1), a
    # superseded one to a radiologist (v1) with its replacement still created (v2, supersedes the old one), and a cancelled
    # one to another clinician (v2) - their seven events (created seq 1 and one terminal seq 2 each; the replacement has
    # only created) and six receipts (create x3, ack, supersede naming the old record with the new record's id, cancel).
    # Each result is the stored CriticalResultApplied a replay answers. The rows satisfy every CHECK, the partial unique
    # pending key (one created record) and the pinned-row foreign keys of 20260928120000_critical_result.
    acked, superseded, replacement, cancelled = ('00000000-0000-4000-8000-000000000f' + n for n in ('01', '11', '12', '21'))
    reader = dict(senderSub='SYNTHETIC-reader-sub', senderActor='SYNTHETIC-reader', senderName='SYNTHETIC reader')
    identity = dict(origName='SYNTHETIC ORIGINAL NAME', origPatientId='SYNTHETIC-patient', origBirth='19700101', origStudyDate='20260906')
    none = dict(acknowledgedAt=None, cancelledAt=None, cancelReason=None, supersededAt=None)
    def critical(record, recipient, role, version, message, state, revision, supersedes=None, **terminal):
        return dict(id=record, studyUid=uid, institutionId='SYNTHETIC-hospital', senderInstitutionId='SYNTHETIC-hospital', **reader,
            recipientSub='SYNTHETIC-' + recipient + '-sub', recipientActor='SYNTHETIC-' + recipient, recipientName='SYNTHETIC ' + recipient,
            recipientRole=role, sourceVersion=version, sourceAction='approve' if version == 1 else 'addendum', sourceAuthor='SYNTHETIC-reader',
            sourceAt=STAMP, **identity, message=message, state=state, revision=revision, supersedesId=supersedes,
            **{**none, **terminal}, changedBy='SYNTHETIC-clinician' if state == 'acknowledged' else 'SYNTHETIC-reader',
            createdAt=STAMP, updatedAt=STAMP)
    rows['CriticalResult'] = [
        critical(acked, 'clinician', 'clinician', 1, 'SYNTHETIC critical message\n합성', 'acknowledged', 2, acknowledgedAt=STAMP),
        critical(superseded, 'reader2', 'radiologist', 1, 'SYNTHETIC first wording', 'superseded', 2, supersededAt=STAMP),
        critical(replacement, 'reader2', 'radiologist', 2, 'SYNTHETIC corrected wording', 'created', 1, supersedes=superseded),
        critical(cancelled, 'clinician2', 'clinician', 2, 'SYNTHETIC sent to the wrong clinician', 'cancelled', 2,
            cancelledAt=STAMP, cancelReason='SYNTHETIC cancel reason')]
    ack_request, supersede_request, cancel_request = acked[:-2] + '02', replacement, cancelled[:-2] + '22'
    reader_actor = dict(actorSub='SYNTHETIC-reader-sub', actorActor='SYNTHETIC-reader', actorName='SYNTHETIC reader', actorRole='radiologist')
    events = [(acked, 1, 'created', reader_actor, acked), (acked, 2, 'acknowledged', dict(actorSub='SYNTHETIC-clinician-sub',
                  actorActor='SYNTHETIC-clinician', actorName='SYNTHETIC clinician', actorRole='clinician'), ack_request),
              (superseded, 1, 'created', reader_actor, superseded), (superseded, 2, 'superseded', reader_actor, supersede_request),
              (replacement, 1, 'created', reader_actor, supersede_request),
              (cancelled, 1, 'created', reader_actor, cancelled), (cancelled, 2, 'cancelled', reader_actor, cancel_request)]
    rows['CriticalResultEvent'] = [dict(id='00000000-0000-4000-8000-000000000e' + str(70 + index), recordId=record, seq=seq, event=event,
        revision=seq, **actor, requestId=request, at=STAMP) for index, (record, seq, event, actor, request) in enumerate(events)]
    applied = lambda record, request, action, before, to, revision, replacement_row=None: dict(id=record, studyUid=uid, requestId=request,
        action=action, to=to, revision=revision, replacement=replacement_row, at='2026-09-06T00:00:00.123Z', **{'from': before})
    critical_receipts = [
        (acked, acked, 'SYNTHETIC-reader-sub', applied(acked, acked, 'create', None, 'created', 1)),
        (ack_request, acked, 'SYNTHETIC-clinician-sub', applied(acked, ack_request, 'ack', 'created', 'acknowledged', 2)),
        (superseded, superseded, 'SYNTHETIC-reader-sub', applied(superseded, superseded, 'create', None, 'created', 1)),
        (supersede_request, superseded, 'SYNTHETIC-reader-sub', applied(superseded, supersede_request, 'supersede', 'created', 'superseded', 2,
            dict(id=replacement, revision=1, sourceVersion=2))),
        (cancelled, cancelled, 'SYNTHETIC-reader-sub', applied(cancelled, cancelled, 'create', None, 'created', 1)),
        (cancel_request, cancelled, 'SYNTHETIC-reader-sub', applied(cancelled, cancel_request, 'cancel', 'created', 'cancelled', 2))]
    rows['CriticalResultReceipt'] = [dict(requestId=request, recordId=record, subjectSub=subject, action=result['action'],
        fingerprint=str(index + 1)*64, appliedRevision=result['revision'], result=result, at=STAMP)
        for index, (request, record, subject, result) in enumerate(critical_receipts)]
    # S7-U3a (D-S7-09 a): the owner's open row and, on the same study, the tele institution's row as its channel's close
    # left it (reader cleared, revision moved on, closedRevision = revision, closedAt set), so the composite key and both
    # new columns carry real values through the dump. The rows satisfy 20260928130000_reader_assignment_scope's CHECK.
    rows['ReaderAssignment']=[dict(studyUid=uid,institutionId='SYNTHETIC-hospital',revision=4,
        readerSub='SYNTHETIC-sub',readerActor='SYNTHETIC-reader',readerName='SYNTHETIC reader',changedBy='SYNTHETIC-admin',
        lastRequest='00000000-0000-4000-8000-000000000701',lastFingerprint='d'*64,updatedAt=STAMP,
        closedRevision=None,closedAt=None),
        dict(studyUid=uid,institutionId='SYNTHETIC-tele',revision=3,readerSub=None,readerActor=None,readerName=None,
        changedBy='SYNTHETIC-reader',lastRequest='00000000-0000-4000-8000-000000000702',lastFingerprint='e'*64,
        updatedAt=STAMP,closedRevision=3,closedAt=STAMP)]
    # Exercise bytea/JSON receipts, pending intent and expired tombstones in the
    # actual dump/restore. These bytes are a synthetic DB marker, not a DICOM.
    rows['ManualSr']=[dict(id='00000000-0000-4000-8000-00000000030'+str(n),studyUid=uid,
        authorSub='SYNTHETIC-sub',authorActor='SYNTHETIC-reader',requestId='00000000-0000-4000-8000-00000000040'+str(n),
        fingerprint=str(n)*64,selection=[dict(id=item_id,revision=2)],sha256='a'*64,createdAt=STAMP,
        dataset=None if n==3 else dict(SOPInstanceUID=uid+'.'+str(n)),dicom=None if n==3 else '\\x'+('01'*132),
        attemptedAt=STAMP if n<3 else None,nextCheckAt=STAMP if n==1 else None,
        storedAt=STAMP if n==2 else None,orthancId='SYNTHETIC-stored' if n==2 else None) for n in (1,2,3)]
    # S7-U5 session end: the marks of provider sessions the product decided to end are state a restore must keep - an
    # unconfirmed one is still owed to the provider and still blocks that session's logins, a confirmed one blocks until
    # it is swept. One of each, every column with a value (confirmedAt NULL on the pending one).
    rows['IdpSessionEnd'] = [
        dict(idpSid='SYNTHETIC-idp-session-pending',cause='logout',decidedAt=STAMP,confirmedAt=None,attempts=3,
             nextAttemptAt='2026-10-06T00:00:00.123'),
        dict(idpSid='SYNTHETIC-idp-session-confirmed',cause='reauthentication',decidedAt=STAMP,confirmedAt=STAMP,attempts=1,
             nextAttemptAt=STAMP)]
    # S7-U5 member isolation: our own record that a member is isolated is state a restore must keep - while it exists the
    # member gets no session, and an unfinished one is provider work still owed. One of each, every column with a value
    # (providerDoneAt NULL on the owed one).
    rows['MemberIsolation'] = [
        dict(sub='SYNTHETIC-member-isolation-owed',decidedAt=STAMP,providerDoneAt=None,attempts=2,
             nextAttemptAt='2026-10-06T00:00:00.456'),
        dict(sub='SYNTHETIC-member-isolation-done',decidedAt=STAMP,providerDoneAt=STAMP,attempts=0,nextAttemptAt=STAMP)]
    # S7-U5 D600: the provider change records are state a restore must keep - an unknown one (here the owed member's disable
    # whose answer was lost) keeps that member's re-activation from succeeding until that call's own answer settles it, and
    # a settled one is the newest end request of a provider session (its mark may be confirmed). One of each, every column
    # with a value (sub, outcome and settledAt NULL where a record has none); the ids come from the sequence.
    rows['ProviderChange'] = [
        dict(id=1,kind='disable',target='SYNTHETIC-member-isolation-owed',sub='SYNTHETIC-member-isolation-owed',generation=2,
             state='unknown',outcome='transport',createdAt='2026-10-06T00:00:00.789',settledAt=None),
        dict(id=2,kind='end_session',target='SYNTHETIC-idp-session-confirmed',sub=None,generation=1,state='done',
             outcome='http_204',createdAt=STAMP,settledAt=STAMP)]
    rows['MemberRights'] = [dict(sub='SYNTHETIC-member',username='SYNTHETIC-member',email='synthetic@example.test',
        name='SYNTHETIC Member',emailVerified=True,approved=True,suspended=False,institution='SYNTHETIC-hospital',
        roles=['radiologist'],version=4,newAuthAfter=STAMP,updatedAt=STAMP)]
    rows['MemberRightsImport'] = [dict(id='realm-v1',completedAt=STAMP)]
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
    return {name: dict(last_value=2 if name in ('ReportVersion_id_seq', 'ProviderChange_id_seq') else 1,
                       is_called=name in ('ReportVersion_id_seq', 'UserFilter_id_seq', 'ProviderChange_id_seq')) for name in SEQUENCES}


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
    for table in ('Institution', 'StudyState', 'Report', 'ReportVersion', 'ReportDraft', 'Order', 'UserFilter',
                  'ViewerItem', 'ViewerRevision', 'ViewerStorageBudget', 'ViewerRequest', 'Finding', 'FindingRevision', 'WorkspaceLayout', 'WorklistColumns',
                  'TransferBasis', 'ProcessingAgreement', 'Transfer', 'ViewerJob', 'ViewerJobRevision', 'ManualSr', 'TechNoteRevision',
                  'FavoriteWorkspace', 'StudyTagCatalog', 'ReaderAssignment', 'ReadingPreferences', 'ReadingAppearance', 'WorkspaceShortcuts', 'HangingProtocolPreference', 'UserFilterCollection', 'SharedFilterLibrary', 'StudyConsultation', 'StudyAccessPolicy', 'StudyAccessRevision',
                  'StudyQuestion', 'StudyQuestionEntry', 'StudyImageRequest', 'StudyImageRequestReceipt',
                  'CriticalResult', 'CriticalResultEvent', 'CriticalResultReceipt', 'IdpSessionEnd', 'MemberIsolation', 'ProviderChange', 'MemberRights', 'MemberRightsImport',
                  'GatewayReceipt', 'GatewayRetryRequest'):
        rows = data[table]
        for row in rows:
            # SERIAL must actually run; explicit values would hide setval loss.
            fields = [key for key in row if not (table in ('ReportVersion', 'UserFilter', 'ProviderChange') and key == 'id')]
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


# Schema-metadata-only diagnostic for a catalog mismatch: names, types and definitions of the
# synthetic product schema, never rows, credentials or dump bytes. Bounded so a log stays readable.
DIAGNOSTIC_ENTRIES = 8
DIAGNOSTIC_BYTES = 4096


def catalog_difference(expected, actual):
    report = {}
    for key in sorted(set(expected) | set(actual)):
        left = {canonical(item).decode() for item in (expected.get(key) or [])}
        right = {canonical(item).decode() for item in (actual.get(key) or [])}
        if left == right:
            continue
        report[key] = dict(expected_count=len(left), actual_count=len(right),
                           only_expected=sorted(left - right)[:DIAGNOSTIC_ENTRIES], only_actual=sorted(right - left)[:DIAGNOSTIC_ENTRIES])
    return report


def bounded_diagnostic(report):
    text = json.dumps(report, sort_keys=True, ensure_ascii=True, separators=(',', ':'))
    while len(text.encode()) > DIAGNOSTIC_BYTES:
        longest = max(((len(entry), key, side) for key, value in report.items() for side in ('only_expected', 'only_actual')
                       for entry in [value[side]] if entry), default=None)
        if longest is None:
            break
        _, key, side = longest
        report[key][side].pop(); report[key]['truncated'] = True
        text = json.dumps(report, sort_keys=True, ensure_ascii=True, separators=(',', ':'))
    return text[:DIAGNOSTIC_BYTES]


def verify_product(name, db, expected):
    actual = observe(name, db)
    for key in ('catalog', 'rows', 'sequences'):
        left, right = actual[key], expected[key]
        if key == 'rows':
            left, right = sorted_rows(left), sorted_rows(right)
        if canonical(left) != canonical(right):
            if key == 'catalog':
                print('Synthetic catalog difference (expected vs restored, schema metadata only): '+
                      bounded_diagnostic(catalog_difference(right, left)), file=sys.stderr, flush=True)
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
      BEGIN UPDATE "ReportDraft" SET revision=0;
        RAISE EXCEPTION 'missing draft revision constraint'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "ReportDraft" SET present=false WHERE findings<>'';
        RAISE EXCEPTION 'missing draft tombstone constraint'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN DELETE FROM "StudyState" WHERE uid=UID;
        RAISE EXCEPTION 'missing viewer study restriction'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN DELETE FROM "ViewerItem";
        RAISE EXCEPTION 'missing viewer history restriction'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN DELETE FROM "ViewerRevision";
        RAISE EXCEPTION 'missing viewer replay restriction'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN DELETE FROM "Finding";
        RAISE EXCEPTION 'missing finding history restriction'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN INSERT INTO "FindingRevision" SELECT * FROM "FindingRevision" LIMIT 1;
        RAISE EXCEPTION 'missing finding revision PK'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "FindingRevision" SET "payloadBytes"="payloadBytes"+1;
        RAISE EXCEPTION 'missing finding payload check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "Finding" SET snapshot=snapshot-'sources';
        RAISE EXCEPTION 'missing finding source check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "Finding" SET snapshot=jsonb_set(snapshot,'{sources}','null');
        RAISE EXCEPTION 'missing finding null source check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "FindingRevision" SET snapshot=snapshot-'sources',"payloadBytes"=octet_length(convert_to((snapshot-'sources')::text,'UTF8'));
        RAISE EXCEPTION 'missing finding revision source check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN INSERT INTO "WorkspaceLayout" SELECT * FROM "WorkspaceLayout" LIMIT 1;
        RAISE EXCEPTION 'missing workspace owner PK'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "WorkspaceLayout" SET revision=0;
        RAISE EXCEPTION 'missing workspace revision constraint'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "WorkspaceLayout" SET value=repeat('x',2049);
        RAISE EXCEPTION 'missing workspace byte constraint'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN INSERT INTO "HangingProtocolPreference" SELECT * FROM "HangingProtocolPreference" LIMIT 1;
        RAISE EXCEPTION 'missing hanging protocol owner PK'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "HangingProtocolPreference" SET revision=0;
        RAISE EXCEPTION 'missing hanging protocol revision constraint'; EXCEPTION WHEN check_violation THEN NULL; END;
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
      BEGIN UPDATE "StudyAccessPolicy" SET policy='{}'::jsonb;
        RAISE EXCEPTION 'missing access shape'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyAccessPolicy" SET revision=0;
        RAISE EXCEPTION 'missing access revision'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN DELETE FROM "StudyAccessPolicy";
        RAISE EXCEPTION 'missing access history restriction'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN INSERT INTO "StudyAccessRevision" SELECT * FROM "StudyAccessRevision" LIMIT 1;
        RAISE EXCEPTION 'missing access history PK'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "StudyAccessPolicy" SET institution='SYNTHETIC-missing';
        RAISE EXCEPTION 'missing access institution FK'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN UPDATE "StudyConsultation" SET state='Bogus';
        RAISE EXCEPTION 'missing consultation state'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyConsultation" SET revision=0;
        RAISE EXCEPTION 'missing consultation revision'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyConsultation" SET "recipientSub"="requesterSub";
        RAISE EXCEPTION 'missing consultation participants'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyConsultation" SET "studyUid"='2.25.0';
        RAISE EXCEPTION 'missing consultation study FK'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN UPDATE "GatewayReceipt" SET phase='done';
        RAISE EXCEPTION 'missing gateway receipt phase check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "GatewayReceipt" SET phase='complete', "errorCode"=NULL;
        RAISE EXCEPTION 'missing gateway receipt completeness check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "GatewayReceipt" SET "errorCode"=NULL;
        RAISE EXCEPTION 'missing gateway receipt error code check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "GatewayRetryRequest" SET seq=-1;
        RAISE EXCEPTION 'missing gateway retry seq check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "GatewayRetryRequest" SET "studyUid"='2.25.0';
        RAISE EXCEPTION 'missing gateway retry receipt FK'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN INSERT INTO "GatewayRetryRequest" SELECT * FROM "GatewayRetryRequest" LIMIT 1;
        RAISE EXCEPTION 'missing gateway retry PK'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "StudyQuestion" SET state='Bogus';
        RAISE EXCEPTION 'missing question state check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyQuestion" SET revision=revision+1;
        RAISE EXCEPTION 'missing question revision check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyQuestion" SET "closedAt"=NULL;
        RAISE EXCEPTION 'missing question closed check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN DELETE FROM "StudyQuestion";
        RAISE EXCEPTION 'missing question receipt restriction'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN UPDATE "StudyQuestionEntry" SET "appliedRevision"=99 WHERE seq=1;
        RAISE EXCEPTION 'missing question receipt revision check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyQuestionEntry" SET result='[]'::jsonb WHERE seq=1;
        RAISE EXCEPTION 'missing question receipt result check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN INSERT INTO "StudyQuestionEntry" SELECT * FROM "StudyQuestionEntry" LIMIT 1;
        RAISE EXCEPTION 'missing question receipt PK'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "StudyImageRequest" SET kind='transfer';
        RAISE EXCEPTION 'missing image request kind check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyImageRequest" SET state='Bogus';
        RAISE EXCEPTION 'missing image request state check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyImageRequest" SET note=NULL WHERE state='Closed';
        RAISE EXCEPTION 'missing image request note check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyImageRequest" SET "handlerActor"=NULL,"handlerName"=NULL WHERE state='Closed';
        RAISE EXCEPTION 'missing image request handler check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyImageRequest" SET "counterpartyInstitutionId"="institutionId" WHERE "counterpartyInstitutionId" IS NOT NULL;
        RAISE EXCEPTION 'missing image request counterparty check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyImageRequest" SET "counterpartyInstitutionId"='SYNTHETIC-missing';
        RAISE EXCEPTION 'missing image request counterparty FK'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN DELETE FROM "StudyImageRequest";
        RAISE EXCEPTION 'missing image request receipt restriction'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN INSERT INTO "StudyImageRequest" SELECT * FROM json_populate_record(NULL::"StudyImageRequest",
        (SELECT (to_jsonb(t)||jsonb_build_object('id','00000000-0000-4000-8000-000000000e99'))::json FROM "StudyImageRequest" t WHERE state='Requested'));
        RAISE EXCEPTION 'missing active image request unique'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "StudyImageRequestReceipt" SET "appliedRevision"=99 WHERE action='create';
        RAISE EXCEPTION 'missing image request receipt revision check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "StudyImageRequestReceipt" SET result='[]'::jsonb WHERE action='create';
        RAISE EXCEPTION 'missing image request receipt result check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN INSERT INTO "StudyImageRequestReceipt" SELECT * FROM "StudyImageRequestReceipt" LIMIT 1;
        RAISE EXCEPTION 'missing image request receipt PK'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "CriticalResult" SET state='Bogus';
        RAISE EXCEPTION 'missing critical result state check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "CriticalResult" SET revision=1 WHERE state<>'created';
        RAISE EXCEPTION 'missing critical result revision check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "CriticalResult" SET "acknowledgedAt"=NULL WHERE state='acknowledged';
        RAISE EXCEPTION 'missing critical result terminal check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "CriticalResult" SET "sourceAction"='save' WHERE "recipientRole"='clinician';
        RAISE EXCEPTION 'missing critical result final-source check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "CriticalResult" SET "sourceAction"='reset';
        RAISE EXCEPTION 'missing critical result pinnable-source check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "CriticalResult" SET "recipientSub"="senderSub";
        RAISE EXCEPTION 'missing critical result party check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "CriticalResult" SET "sourceVersion"=99;
        RAISE EXCEPTION 'missing critical result pinned-row FK'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN DELETE FROM "ReportVersion" WHERE version=1;
        RAISE EXCEPTION 'missing pinned report version restriction'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN DELETE FROM "CriticalResult";
        RAISE EXCEPTION 'missing critical result history restriction'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      BEGIN INSERT INTO "CriticalResult" SELECT * FROM json_populate_record(NULL::"CriticalResult",
        (SELECT (to_jsonb(t)||jsonb_build_object('id','00000000-0000-4000-8000-000000000f99','supersedesId',NULL))::json FROM "CriticalResult" t WHERE state='created'));
        RAISE EXCEPTION 'missing pending critical result unique'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN INSERT INTO "CriticalResultEvent" SELECT * FROM json_populate_record(NULL::"CriticalResultEvent",
        (SELECT (to_jsonb(t)||jsonb_build_object('id','00000000-0000-4000-8000-000000000e99','event','cancelled'))::json
         FROM "CriticalResultEvent" t WHERE seq=2 AND event<>'cancelled' LIMIT 1));
        RAISE EXCEPTION 'missing one terminal event per record'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "CriticalResultEvent" SET seq=3 WHERE seq=2;
        RAISE EXCEPTION 'missing critical result event seq check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "CriticalResultReceipt" SET "appliedRevision"=2 WHERE action='create';
        RAISE EXCEPTION 'missing critical result receipt revision check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "CriticalResultReceipt" SET result='[]'::jsonb;
        RAISE EXCEPTION 'missing critical result receipt result check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN INSERT INTO "CriticalResultReceipt" SELECT * FROM "CriticalResultReceipt" LIMIT 1;
        RAISE EXCEPTION 'missing critical result receipt PK'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN INSERT INTO "ReaderAssignment" SELECT * FROM "ReaderAssignment" LIMIT 1;
        RAISE EXCEPTION 'missing reader assignment PK'; EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN UPDATE "ReaderAssignment" SET "readerSub"='SYNTHETIC-sub' WHERE "closedAt" IS NOT NULL;
        RAISE EXCEPTION 'missing reader assignment closed check'; EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN UPDATE "ReaderAssignment" SET "closedRevision"="revision"+1 WHERE "closedRevision" IS NOT NULL;
        RAISE EXCEPTION 'missing reader assignment close revision check'; EXCEPTION WHEN check_violation THEN NULL; END;
      -- A third institution's row beside the open one on the same study is accepted (the key is the pair, not the
      -- study alone); the raise afterwards undoes the insert, and only that raise is caught.
      BEGIN INSERT INTO "ReaderAssignment" SELECT * FROM json_populate_record(NULL::"ReaderAssignment",
        (SELECT (to_jsonb(t)||jsonb_build_object('institutionId','SYNTHETIC-third'))::json FROM "ReaderAssignment" t WHERE "closedAt" IS NULL));
        RAISE EXCEPTION 'reader assignment pair key accepted'; EXCEPTION WHEN raise_exception THEN NULL; END;
      BEGIN UPDATE "StudyConsultation" SET state='Requested';
        INSERT INTO "StudyConsultation" SELECT * FROM json_populate_record(NULL::"StudyConsultation",
          (SELECT (to_jsonb(t)||jsonb_build_object('id','00000000-0000-4000-8000-000000000999'))::json FROM "StudyConsultation" t LIMIT 1));
        RAISE EXCEPTION 'missing active consultation unique'; EXCEPTION WHEN unique_violation THEN NULL; END;
      -- S7-AUDIT-STORE: AuditLog stays append-only after the restore (a trigger, which --no-privileges keeps). The explicit
      -- id leaves the AuditLog sequence as restored; the guard's refusal undoes the probe row with its block.
      BEGIN INSERT INTO "AuditLog" (id,actor,action,target) VALUES(-1,'SYNTHETIC','SYNTHETIC','SYNTHETIC');
        DELETE FROM "AuditLog" WHERE id=-1;
        RAISE EXCEPTION 'missing audit append-only guard'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END $$; ROLLBACK'''.replace('UID', uid)
    execute(name, 'kin', sql)
    verify_product(name, 'kin', product)
    return dict(version_unique=True, report_study_fk=True, draft_composite_pk=True,
                viewer_restrict=True, finding_restrict=True, rolled_back_unchanged=True)


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
