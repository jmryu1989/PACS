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
                     lambda p: p['sequences']['UserFilter_id_seq'].update(is_called=True),
                     lambda p: p['catalog']['tables'].append('foreign')]
        for mutate in mutations:
            changed = copy.deepcopy(body); mutate(changed['product'])
            with self.assertRaises(ValueError): check(changed)

    def test_06_orthanc_resource_id_is_not_dicom_uid(self):
        body, _, _, _ = fixture()
        for uid in (body['snapshot']['instance'], '1;DROP', '1.'+'2'*64, True, 'single'):
            with self.assertRaises(ValueError): transfer.expected_rows(uid)
        rows = body['product']['rows']
        self.assertEqual(sum(len(value) for value in rows.values()), 8)
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
