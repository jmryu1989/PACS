"""REQ/RISK/TEST-C12M-01..05: product bindings and fail-closed restore paths."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import ops_product_transfer_fixture as transfer
from ops_combined_transfer_test import fixture as combined_fixture
from ops_image_transfer_test import CONTEXT

UID = '2.25.123456789'
MIGRATIONS = [dict(path=transfer.MIGRATIONS[0], sha256='f'*64)]


def fixture():
    body, files, pg_config, orth_config = combined_fixture()
    catalog = dict(tables=transfer.TABLES, columns=[dict(column_name='fixture-test-only')],
        constraints=[dict(name='fixture-test-only')], indexes=[dict(name='fixture-test-only')],
        sequence_settings=[dict(sequencename=name) for name in transfer.SEQUENCES])
    product = dict(migrations=MIGRATIONS, study_uid=UID, catalog=catalog,
                   rows=transfer.expected_rows(UID), sequences=transfer.expected_sequences())
    return dict(body, schema=2, profile=transfer.PROFILE, product=product,
                relation=transfer.relation(body['snapshot'])), files, pg_config, orth_config


def check(body, product_sha=None):
    raw = transfer.canonical(body)
    with patch.object(transfer, 'migration_records', return_value=MIGRATIONS):
        return transfer.parse_receipt(raw, transfer.image_transfer.sha(raw),
            product_sha or transfer.image_transfer.sha(transfer.canonical(body['product'])), CONTEXT)


class Pure(unittest.TestCase):
    def test_catalog_column_budget_supports_current_schema_and_stays_bounded(self):
        catalog=fixture()[0]['product']['catalog']
        catalog['columns']=[dict(column_name='synthetic') for _ in range(260)]
        transfer.catalog_contract(catalog)
        catalog['columns']*=2
        with self.assertRaises(ValueError):transfer.catalog_contract(catalog)
        catalog['columns']=[dict(column_name='synthetic')]
        catalog['constraints']=[dict(name='synthetic') for _ in range(257)]
        with self.assertRaises(ValueError):transfer.catalog_contract(catalog)

    def test_current_git_migrations_are_covered(self):
        self.assertEqual(len(transfer.migration_sources()),len(transfer.MIGRATIONS))

    def test_workspace_catalog_assignment_restore_contract(self):
        body, _, _, _ = fixture(); expected=body['product']
        for table,field,value in [('FavoriteWorkspace','value','[]'),('FavoriteWorkspace','subject','wrong-owner'),
                ('StudyTagCatalog','ownerSub','wrong-owner'),('StudyTagCatalog','lastRequest','00000000-0000-4000-8000-000000000999'),
                ('ReaderAssignment','readerSub',None),('ReaderAssignment','revision',1),('ReaderAssignment','lastFingerprint','0'*64)]:
            actual={key:copy.deepcopy(expected[key]) for key in ('catalog','rows','sequences')}
            actual['rows'][table][0][field]=value
            with self.subTest(table=table,field=field),patch.object(transfer,'observe',return_value=actual),self.assertRaises(transfer.ProductMismatch):
                transfer.verify_product('owned','kin',expected)

    def test_workspace_shortcuts_preserve_bindings_owner_and_revision(self):
        body, _, _, _ = fixture(); expected=body['product']
        rows=expected['rows']['WorkspaceShortcuts']
        self.assertEqual({(row['institution'],row['subject']) for row in rows},
            {('SYNTHETIC-hospital','SYNTHETIC-sub'),('SYNTHETIC-tele','SYNTHETIC-sub'),
             ('SYNTHETIC-hospital','SYNTHETIC-other')})
        for index,field,value in [(0,'bindings',{}),(0,'revision',1),(1,'institution','wrong-owner'),
                (2,'subject','wrong-owner'),(2,'bindings',rows[0]['bindings'])]:
            actual={key:copy.deepcopy(expected[key]) for key in ('catalog','rows','sequences')}
            actual['rows']['WorkspaceShortcuts'][index][field]=value
            with self.subTest(index=index,field=field),patch.object(transfer,'observe',return_value=actual),self.assertRaises(transfer.ProductMismatch):
                transfer.verify_product('owned','kin',expected)
        actual={key:copy.deepcopy(expected[key]) for key in ('catalog','rows','sequences')}
        actual['rows']['WorkspaceShortcuts']=[]
        with patch.object(transfer,'observe',return_value=actual),self.assertRaises(transfer.ProductMismatch):
            transfer.verify_product('owned','kin',expected)

    def test_worklist_column_restore_contract(self):
        body, _, _, _ = fixture(); expected=body['product']
        self.assertEqual(len(expected['rows']['WorklistColumns']),2)
        actual={key:copy.deepcopy(expected[key]) for key in ('catalog','rows','sequences')}
        with patch.object(transfer,'observe',return_value=actual):transfer.verify_product('owned','kin',expected)
        for row,field,value in [(0,'value',None),(0,'revision',1),(0,'subject','wrong-owner'),(1,'value','{}'),(1,'revision',1)]:
            actual={key:copy.deepcopy(expected[key]) for key in ('catalog','rows','sequences')}
            actual['rows']['WorklistColumns'][row][field]=value
            with patch.object(transfer,'observe',return_value=actual), self.assertRaises(transfer.ProductMismatch):
                transfer.verify_product('owned','kin',expected)

    def test_workspace_reading_layout_restore_preserves_all_sizes_visibility_and_owner(self):
        body, _, _, _ = fixture();expected=body['product'];row=expected['rows']['WorkspaceLayout'][0]
        layout=json.loads(row['value']);self.assertEqual(layout['version'],2)
        self.assertEqual(layout['reading'],dict(version=1,reportWidth=540,imageHeight=390,
            relatedHeight=None,relatedListHeight=180,relatedHidden=True))
        changed_layouts=[]
        for key in layout['reading']:
            changed=copy.deepcopy(layout);del changed['reading'][key];changed_layouts.append(changed)
        for key,value in [('reportWidth',541),('imageHeight',391),('relatedHeight',310),
                ('relatedListHeight',181),('relatedHidden',False)]:
            changed=copy.deepcopy(layout);changed['reading'][key]=value;changed_layouts.append(changed)
        legacy=copy.deepcopy(layout);del legacy['reading'];legacy['version']=1;changed_layouts.append(legacy)
        for changed in changed_layouts:
            actual={key:copy.deepcopy(expected[key]) for key in ('catalog','rows','sequences')}
            actual['rows']['WorkspaceLayout'][0]['value']=json.dumps(changed,separators=(',',':'))
            with self.subTest(layout=changed),patch.object(transfer,'observe',return_value=actual),self.assertRaises(transfer.ProductMismatch):
                transfer.verify_product('owned','kin',expected)
        for index,field,value in [(0,'revision',1),(0,'subject','wrong-owner'),
                (0,'institution','wrong-institution'),(1,'value',row['value'])]:
            actual={key:copy.deepcopy(expected[key]) for key in ('catalog','rows','sequences')}
            actual['rows']['WorkspaceLayout'][index][field]=value
            with self.subTest(index=index,field=field),patch.object(transfer,'observe',return_value=actual),self.assertRaises(transfer.ProductMismatch):
                transfer.verify_product('owned','kin',expected)

    def test_saved_filter_metadata_restore_contract(self):
        body, _, _, _ = fixture()
        expected = body['product']
        row = expected['rows']['UserFilter'][0]
        self.assertEqual((row['folder'], row['description'], row['ordinal']),
                         ('SYNTHETIC/CT', 'SYNTHETIC follow-up', 7))
        self.assertEqual(expected['sequences']['UserFilter_id_seq'], dict(last_value=1, is_called=True))
        for field, value in (('folder',''), ('description','changed'), ('ordinal',0)):
            actual = {key: copy.deepcopy(expected[key]) for key in ('catalog','rows','sequences')}
            actual['rows']['UserFilter'][0][field] = value
            with patch.object(transfer, 'observe', return_value=actual), self.assertRaises(transfer.ProductMismatch):
                transfer.verify_product('owned', 'kin', expected)

    def test_empty_folder_owner_revision_and_metadata_restore_contract(self):
        expected = fixture()[0]['product']
        self.assertEqual(expected['rows']['UserFilterCollection'][0]['folders'][0]['path'], 'SYNTHETIC/Empty')
        for field, value in [('owner', 'wrong-owner'), ('revision', 0), ('folders', []),
                             ('folders', [dict(path='SYNTHETIC/Empty', description='changed', ordinal=2)])]:
            actual = {key: copy.deepcopy(expected[key]) for key in ('catalog','rows','sequences')}
            actual['rows']['UserFilterCollection'][0][field] = value
            with self.subTest(field=field), patch.object(transfer, 'observe', return_value=actual), self.assertRaises(transfer.ProductMismatch):
                transfer.verify_product('owned', 'kin', expected)

    def test_shared_search_library_preserves_institution_revision_metadata_and_criteria(self):
        expected = fixture()[0]['product']
        self.assertEqual(expected['rows']['SharedFilterLibrary'][0]['filters'][0]['cols'], {'mod':'CT'})
        for field, value in [('institution','foreign'),('revision',0),('folders',[]),('filters',[]),
                             ('updatedBy','foreign'),('updatedAt','2020-01-01T00:00:00')]:
            actual = {key: copy.deepcopy(expected[key]) for key in ('catalog','rows','sequences')}
            actual['rows']['SharedFilterLibrary'][0][field] = value
            with self.subTest(field=field), patch.object(transfer,'observe',return_value=actual), self.assertRaises(transfer.ProductMismatch):
                transfer.verify_product('owned','kin',expected)

    def test_01_non_ci_refused_before_any_mutation(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(transfer, 'command') as calls, \
             patch.object(transfer.combined, 'disk_preflight') as disk, tempfile.TemporaryDirectory() as folder:
            target = Path(folder)/'absent'
            for method, args in ((transfer.produce, [target]), (transfer.consume, [target, '0'*64, '0'*64])):
                with self.assertRaises(ValueError): method(*args)
            self.assertFalse(target.exists()); calls.assert_not_called(); disk.assert_not_called()

    def test_02_new_profile_cannot_be_read_as_c12l(self):
        body, _, _, _ = fixture(); self.assertEqual(check(body), body)
        for changes in ({'schema': 1}, {'schema': True}, {'profile': 'other'}, {'extra': 1},
                        {'producer_boot_id': CONTEXT['boot_id']}, {'code_sha': 'c'*40}):
            with self.subTest(changes=changes), self.assertRaises(ValueError): check(dict(body, **changes))
        raw = transfer.canonical(body)
        with self.assertRaises(ValueError):
            transfer.combined.parse_receipt(raw, transfer.image_transfer.sha(raw), body['relation']['keycloak_rows_sha256'], CONTEXT)

    def test_03_separate_expected_product_rejects_resealed_foreign_uid(self):
        body, _, _, _ = fixture(); changed = copy.deepcopy(body)
        changed['product']['study_uid'] = '2.25.987'
        changed['product']['rows'] = transfer.expected_rows('2.25.987')
        check(changed)
        with self.assertRaises(ValueError): check(changed, transfer.image_transfer.sha(transfer.canonical(body['product'])))

    def test_04_migration_drift_and_extra_migration_refused(self):
        body, _, _, _ = fixture()
        for values in ([], MIGRATIONS*2, [dict(MIGRATIONS[0], sha256='0'*64)]):
            changed = copy.deepcopy(body); changed['product']['migrations'] = values
            with self.assertRaises(ValueError): check(changed)
        with patch.object(transfer, 'command', return_value=('\n'.join(transfer.MIGRATIONS+['api/prisma/migrations/new/migration.sql'])).encode()) as call:
            with self.assertRaises(ValueError): transfer.migration_sources()
            self.assertEqual(call.call_count, 1)

    def test_05_all_rows_columns_empty_tables_and_typed_sequences(self):
        body, _, _, _ = fixture()
        mutations = [lambda p: p['rows']['Report'][0].update(findings='SYNTHETIC wrong'),
                     lambda p: p['rows']['ReportVersion'][1].update(reason=''),
                     lambda p: p['rows']['StudyState'][0].pop('holdReason'),
                     lambda p: p['rows']['ReportDraft'].pop(),
                     lambda p: p['rows']['AuthSession'].append(dict(sid='SYNTHETIC')),
                     lambda p: p['sequences']['ReportVersion_id_seq'].update(last_value=True),
                     lambda p: p['sequences']['UserFilter_id_seq'].update(is_called=False),
                     lambda p: p['catalog']['tables'].append('foreign')]
        for mutate in mutations:
            changed = copy.deepcopy(body); mutate(changed['product'])
            with self.assertRaises(ValueError): check(changed)

    def test_06_orthanc_resource_id_is_not_dicom_uid(self):
        body, _, _, _ = fixture()
        for uid in (body['snapshot']['instance'], '1;DROP', '1.'+'2'*64, True, 'single'):
            with self.assertRaises(ValueError): transfer.expected_rows(uid)
        rows = body['product']['rows']
        self.assertEqual(sum(len(value) for value in rows.values()), 40)
        self.assertEqual([(r['revision'],r['value'] is None) for r in rows['WorklistColumns']],[(2,False),(3,True)])
        self.assertEqual([(r['studyUid'],r['version'],r['text']) for r in rows['TechNoteRevision']],[(UID,1,'SYNTHETIC tech note')])
        job=rows['ViewerJob'][0]
        self.assertEqual(job['snapshot']['cells'][0]['sop'],UID+'.2')
        self.assertEqual(job['studies'],[UID]);self.assertTrue(job['hidden'])
        self.assertEqual([(r['jobId'],r['revision'],r['hidden']) for r in rows['ViewerJobRevision']],[(job['id'],1,False),(job['id'],2,True)])
        basis,agreement,request=[rows[name][0] for name in ('TransferBasis','ProcessingAgreement','Transfer')]
        self.assertEqual(request['basisId'],basis['id']);self.assertEqual(request['agreementId'],agreement['id'])
        self.assertEqual(request['studyUid'],UID);self.assertEqual(request['status'],'OPEN')
        self.assertEqual(request['fromInstitutionId'],basis['institutionId'])
        self.assertEqual(request['toInstitutionId'],agreement['toInstitutionId'])
        workspaces=rows['WorkspaceLayout']
        self.assertEqual(len(workspaces),2)
        self.assertEqual(workspaces[0]['subject'],workspaces[1]['subject'])
        self.assertNotEqual(workspaces[0]['institution'],workspaces[1]['institution'])
        self.assertEqual(json.loads(workspaces[0]['value'])['landscape']['main'],720)
        self.assertIsNone(workspaces[1]['value']);self.assertEqual(workspaces[1]['revision'],3)
        self.assertEqual({row['uid'] for table in ('StudyState', 'Report', 'ReportVersion', 'ReportDraft') for row in rows[table]}, {UID})

    def test_07_actual_observation_compares_every_section(self):
        body, _, _, _ = fixture(); product = body['product']
        actual = {key: copy.deepcopy(product[key]) for key in ('catalog', 'rows', 'sequences')}
        actual['rows']['ReportVersion'].reverse()
        with patch.object(transfer, 'observe', return_value=actual): transfer.verify_product('owned', 'kin', product)
        for section in ('catalog', 'rows', 'sequences'):
            changed = copy.deepcopy(actual)
            if section == 'catalog': changed[section]['constraints'][0]['name'] = 'different'
            if section == 'rows': changed[section]['ReportVersion'][0]['findings'] = 'SYNTHETIC foreign'
            if section == 'sequences': changed[section]['ReportVersion_id_seq']['last_value'] = 1
            with patch.object(transfer, 'observe', return_value=changed), self.assertRaises(transfer.ProductMismatch):
                transfer.verify_product('owned', 'kin', product)

    def test_08_negative_requires_real_restore_success_then_row_mismatch(self):
        body, _, _, _ = fixture()
        with tempfile.TemporaryDirectory() as folder, patch.object(transfer, 'create_product'), \
             patch.object(transfer, 'execute'), patch.object(transfer.orth, 'bounded_output'), \
             patch.object(transfer, 'restore') as restore, patch.object(transfer, 'verify_product') as verify:
            verify.side_effect = [transfer.ProductMismatch('Synthetic product rows mismatch'), {}]
            result = transfer.negative_restore('owned', Path(folder), body['product'])
            self.assertTrue(result['valid_dump_restored']); restore.assert_called_once()
            self.assertEqual(verify.call_args_list[0].args[1], 'foreign_restore')
            self.assertEqual(verify.call_args_list[1].args[1], 'kin')
            for error in (None, ValueError('query failed'), transfer.ProductMismatch('Synthetic product catalog mismatch')):
                verify.side_effect = [error] if error else None
                with self.assertRaises(ValueError): transfer.negative_restore('owned', Path(folder), body['product'])
            restore.side_effect = subprocess.CalledProcessError(1, ['pg_restore'])
            verify.reset_mock()
            with self.assertRaises(subprocess.CalledProcessError): transfer.negative_restore('owned', Path(folder), body['product'])
            verify.assert_not_called()

    def test_09_constraints_run_transaction_then_verify_unchanged(self):
        body, _, _, _ = fixture()
        with patch.object(transfer, 'execute') as execute, patch.object(transfer, 'verify_product') as verify:
            self.assertTrue(transfer.constraint_probes('owned', body['product'])['rolled_back_unchanged'])
            sql = execute.call_args.args[2]
            self.assertTrue(sql.startswith('BEGIN;')); self.assertTrue(sql.endswith('ROLLBACK'))
            self.assertIn('WHEN foreign_key_violation', sql); self.assertIn('VALUES(99,', sql)
            verify.assert_called_once_with('owned', 'kin', body['product'])

    def test_10_receipt_caps_duplicate_json_and_separate_hash(self):
        body, _, _, _ = fixture(); raw = transfer.canonical(body)
        for data in (b' '* (transfer.RECEIPT_LIMIT+1), b'{"schema":2,"schema":2}', b'NaN'):
            with self.assertRaises(ValueError): transfer.parse_receipt(data, transfer.image_transfer.sha(data), '0'*64, CONTEXT)
        with self.assertRaises(ValueError): transfer.parse_receipt(raw, '0'*64, '0'*64, CONTEXT)
        with self.assertRaises(ValueError): check(body, '0'*64)

    def test_11_producer_seed_orders_fk_and_exercises_serial(self):
        with patch.object(transfer, 'command'), patch.object(transfer, 'migration_sources', return_value=[b'SELECT 1']), \
             patch.object(transfer, 'execute') as execute:
            transfer.create_product('owned', 'kin', UID)
            sql = [call.args[2] for call in execute.call_args_list]
            # Every expected nonempty table must actually be seeded. A receipt
            # assembled from expectations alone missed new tables in hosted CI.
            for table, rows in transfer.expected_rows(UID).items():
                inserted=[text for text in sql if text.startswith('INSERT INTO "'+table+'" ')]
                self.assertEqual(len(inserted),len(rows),table)
                for statement,row in zip(inserted,rows):
                    self.assertIn(transfer.sql_literal(json.dumps(row)),statement)
            state = next(i for i, text in enumerate(sql) if 'INSERT INTO "StudyState"' in text)
            report = next(i for i, text in enumerate(sql) if 'INSERT INTO "Report" ' in text)
            self.assertLess(state, report)
            for text in sql:
                if text.startswith('INSERT INTO "ReportVersion"'): self.assertNotIn('"id"', text.split(' SELECT ')[0])


@unittest.skipUnless(sys.platform == 'linux', 'Linux private FD and bounded output')
class Linux(unittest.TestCase):
    def test_12_query_cap_and_explicit_deadline(self):
        with patch.object(transfer.orth, 'bounded_output') as output:
            def write(args, target, limit, timeout):
                self.assertEqual(limit, 256*1024); self.assertEqual(timeout, 30)
                self.assertIn('-XqAt', args); target.write_bytes(b'[]\n')
            output.side_effect = write
            self.assertEqual(transfer.psql('owned', 'kin', 'SELECT 1'), b'[]')

    def test_13_both_images_absent_before_load_or_cleanup(self):
        body, files, _, _ = fixture(); raw = transfer.canonical(body)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, data in files.items(): (root/name).write_bytes(data)
            (root/'receipt.json').write_bytes(raw)
            for found in ([None, {}], [{}, None]):
                with patch.object(transfer.image_transfer, 'ci_context', return_value=CONTEXT), \
                     patch.object(transfer.combined, 'disk_preflight'), patch.object(transfer, 'migration_records', return_value=MIGRATIONS), \
                     patch.object(transfer.image_transfer, 'inspect_image', side_effect=found) as inspect, \
                     patch.object(transfer, 'command') as commands, patch.object(transfer.combined, 'cleanup') as cleanup:
                    with self.assertRaises(ValueError): transfer.consume(root, transfer.image_transfer.sha(raw), transfer.image_transfer.sha(transfer.canonical(body['product'])))
                    self.assertEqual(inspect.call_count, 2); commands.assert_not_called(); cleanup.assert_not_called()

    def test_14_source_artifact_symlink_refused(self):
        body, files, _, _ = fixture(); raw = transfer.canonical(body)
        with tempfile.TemporaryDirectory() as folder, patch.object(transfer.image_transfer, 'ci_context', return_value=CONTEXT), \
             patch.object(transfer.combined, 'disk_preflight'), patch.object(transfer, 'migration_records', return_value=MIGRATIONS), \
             patch.object(transfer.image_transfer, 'inspect_image') as inspect:
            root = Path(folder)/'source'; root.mkdir()
            for name, data in files.items(): (root/name).write_bytes(data)
            (Path(folder)/'receipt.json').write_bytes(raw)
            (root/'receipt.json').symlink_to(Path(folder)/'receipt.json')
            with self.assertRaises(OSError): transfer.consume(root, transfer.image_transfer.sha(raw), transfer.image_transfer.sha(transfer.canonical(body['product'])))
            inspect.assert_not_called()


if __name__ == '__main__': unittest.main(verbosity=2)
