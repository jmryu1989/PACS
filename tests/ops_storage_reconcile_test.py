"""Synthetic offline listing/SQLite checks; no cloud credentials or network."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import ops_storage_reconcile as reconcile

BUCKET, PREFIX = 'kin-synthetic-only', 'kin-c4-fixture/'
IDS = ['00000000-0000-4000-8000-'+str(n).zfill(12) for n in range(1, 7)]


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def attachment(number=0, kind=1, size=31):
    return dict(id=number+1, fileType=kind, uuid=IDS[number], compressedSize=size, uncompressedSize=size,
                compressionType=1, compressedMD5=None, uncompressedMD5=None)


def document(entries=None):
    entries = entries if entries is not None else [{'Key': PREFIX+IDS[0]+'.dcm', 'Size': 31}]
    return dict(schema=1, bucket=BUCKET, prefix=PREFIX, profile=copy.deepcopy(reconcile.PROFILE), pages=[
        dict(request_token=None, response=dict(Name=BUCKET, Prefix=PREFIX, MaxKeys=1000,
             KeyCount=len(entries), IsTruncated=False, Contents=entries))])


def parse(body):
    raw = json.dumps(body).encode()
    return reconcile.listing(raw, digest(raw), BUCKET, PREFIX)


class PureTests(unittest.TestCase):
    def test_01_terminal_and_two_page_chain(self):
        body = document()
        last = copy.deepcopy(body['pages'][0])
        body['pages'][0]['response'].update(IsTruncated=True, NextContinuationToken='second')
        last.update(request_token='second')
        last['response'].update(ContinuationToken='second', Contents=[], KeyCount=0)
        body['pages'].append(last)
        self.assertEqual(parse(body), ({PREFIX+IDS[0]+'.dcm':31}, 2))
        self.assertEqual(parse(document([])), ({},1))

    def test_02_missing_terminal_or_extra_pages_refused(self):
        for mode in ('truncated', 'extra', 'next_on_terminal'):
            body=document()
            if mode=='truncated': body['pages'][0]['response'].update(IsTruncated=True, NextContinuationToken='next')
            elif mode=='extra': body['pages'] *= 2
            else: body['pages'][0]['response']['NextContinuationToken']='next'
            with self.subTest(mode=mode), self.assertRaises(ValueError): parse(body)

    def test_03_token_chain_response_and_repetition_refused(self):
        for mode in ('missing', 'wrong_request', 'wrong_response', 'repeat'):
            body=document([])
            body['pages'][0]['response'].update(IsTruncated=True, NextContinuationToken='next')
            body['pages'].append(dict(request_token='next', response=dict(Name=BUCKET, Prefix=PREFIX,
                MaxKeys=1000, KeyCount=0, IsTruncated=False, ContinuationToken='next')))
            if mode=='missing': del body['pages'][0]['response']['NextContinuationToken']
            elif mode=='wrong_request': body['pages'][1]['request_token']='skip'
            elif mode=='wrong_response': body['pages'][1]['response']['ContinuationToken']='skip'
            else:
                body['pages'][1]['response'].update(IsTruncated=True, NextContinuationToken='next')
                body['pages'].append(copy.deepcopy(body['pages'][1]))
            with self.subTest(mode=mode), self.assertRaises(ValueError): parse(body)

    def test_04_duplicate_key_and_outside_prefix_refused(self):
        entry={'Key':PREFIX+IDS[0]+'.dcm', 'Size':31}
        for entries in ([entry,entry], [dict(Key='another/'+IDS[0]+'.dcm', Size=31)]):
            with self.assertRaises(ValueError): parse(document(entries))

    def test_05_wrong_scope_profile_and_types_refused(self):
        for field,value in (('bucket','different'),('prefix','different/'),('schema',True),('profile',{})):
            body=document(); body[field]=value
            with self.subTest(field=field), self.assertRaises(ValueError): parse(body)
        for field,value in (('Name','wrong'),('Prefix','wrong/')):
            body=document(); body['pages'][0]['response'][field]=value
            with self.assertRaises(ValueError): parse(body)
        body=document(); body['profile']['client_encryption']=0
        with self.assertRaises(ValueError): parse(body)

    def test_06_page_count_size_and_boolean_types(self):
        for field,value in (('KeyCount',0),('KeyCount',True),('MaxKeys',0),('MaxKeys',1001),('IsTruncated',0)):
            body=document(); body['pages'][0]['response'][field]=value
            with self.subTest(field=field,value=value), self.assertRaises(ValueError): parse(body)

    def test_07_grouped_encoded_partial_error_responses_refused(self):
        for field,value in (('Delimiter','/'),('CommonPrefixes',[]),('StartAfter','x'),('EncodingType','url'),('Error',{'Code':'AccessDenied'})):
            body=document(); body['pages'][0]['response'][field]=value
            with self.subTest(field=field), self.assertRaises(ValueError): parse(body)

    def test_08_digest_duplicate_json_and_nan_refused(self):
        raw=json.dumps(document()).encode()
        with self.assertRaises(ValueError): reconcile.listing(raw,'0'*64,BUCKET,PREFIX)
        for raw in (b'{"schema":1,"schema":1}',b'{"schema":NaN}'):
            with self.assertRaises(ValueError): reconcile.listing(raw,digest(raw),BUCKET,PREFIX)

    def test_09_document_object_and_page_limits(self):
        for name, limit in (('LIST_LIMIT',10),('PAGE_LIMIT',0),('ITEM_LIMIT',0)):
            with patch.object(reconcile,name,limit), self.assertRaises(ValueError): parse(document())

    def test_10_bad_object_key_and_size(self):
        for entry in (dict(Key=PREFIX+'bad\nkey',Size=1),dict(Key=PREFIX+'x'*1024,Size=1),
                      dict(Key=PREFIX+'x',Size=True),dict(Key=PREFIX+'x',Size=-1)):
            with self.assertRaises(ValueError): parse(document([entry]))

    def test_11_index_row_validation(self):
        self.assertEqual(reconcile.validate_rows([attachment()]),[attachment()])
        for field,value in (('uuid','../wrong'),('fileType',True),('compressedSize',-1),('compressedMD5','not-md5')):
            row=attachment(); row[field]=value
            with self.assertRaises(ValueError): reconcile.validate_rows([row])
        for rows in ([attachment(),attachment()], [attachment(),dict(attachment(1),id=1)]):
            with self.assertRaises(ValueError): reconcile.validate_rows(rows)

    def test_12_multiple_types_match_by_uuid_and_never_etag(self):
        rows=[attachment(),attachment(1,1024),attachment(2,1025)]
        entries=[dict(Key=PREFIX+row['uuid']+('.dcm' if row['fileType']==1 else '.unk'),Size=31,ETag='NOT_AN_MD5') for row in rows]
        objects,_=parse(document(entries))
        result=reconcile.compare(rows,objects,PREFIX)
        self.assertTrue(result['comparison_consistent'])
        self.assertEqual(set(result['by_file_type']),{'1','1024','1025'})

    def test_13_missing_orphan_size_and_unknown_objects_separate(self):
        objects={PREFIX+IDS[0]+'.dcm':30,PREFIX+IDS[2]+'.unk':31,PREFIX+'unrecognized':1}
        result=reconcile.compare([attachment(),attachment(1,1024)],objects,PREFIX)
        for field in ('missing','size_mismatch','orphan_candidates','unknown_objects'):
            self.assertEqual(result['counts'][field],1)
        self.assertFalse(result['comparison_consistent'])

    def test_14_ambiguous_uuid_unsupported_type_compression_and_suffix(self):
        variants=[([attachment()],{PREFIX+IDS[0]+'.dcm':31,PREFIX+IDS[0]+'.unk':31},'ambiguous'),
                  ([attachment(0,3)],{PREFIX+IDS[0]+'.dcm.head':31},'unsupported'),
                  ([dict(attachment(),compressionType=2)],{PREFIX+IDS[0]+'.dcm':31},'unsupported'),
                  ([attachment()],{PREFIX+IDS[0]+'.dcm.enc':31},'unsupported')]
        for rows,objects,category in variants:
            result=reconcile.compare(rows,objects,PREFIX)
            self.assertEqual(result['counts'][category],1); self.assertFalse(result['comparison_consistent'])

    def test_15_windows_refuses_before_input_access_and_cli_redacts(self):
        with patch.object(reconcile.private.sys,'platform','win32'), patch.object(reconcile,'input_size') as access:
            with self.assertRaises(ValueError): reconcile.reconcile(None,None,None,None,BUCKET,PREFIX,None)
            access.assert_not_called()
        result=subprocess.run([sys.executable,'-B',reconcile.__file__,'--index','PRIVATE_SENTINEL','--listing','PRIVATE_SENTINEL',
            '--destination','PRIVATE_SENTINEL','--index-sha256','bad','--listing-sha256','bad','--bucket',BUCKET,'--prefix',PREFIX],capture_output=True,text=True)
        self.assertEqual(result.returncode,1); self.assertNotIn('PRIVATE_SENTINEL',result.stdout+result.stderr)
        self.assertFalse(json.loads(result.stderr)['reconciliation_complete'])


@unittest.skipUnless(sys.platform=='linux','Actual private SQLite input requires Linux permissions')
class LinuxTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='kin-storage-tests-')
        self.root=Path(self.temp.name)
        self.index=self.root/'index'; self.listing=self.root/'listing.json'; self.destination=self.root/'report'
        connection=sqlite3.connect(self.index)
        connection.execute('CREATE TABLE AttachedFiles(id INTEGER, fileType INTEGER, uuid TEXT, compressedSize INTEGER, uncompressedSize INTEGER, compressionType INTEGER, uncompressedMD5 TEXT, compressedMD5 TEXT)')
        row=attachment()
        connection.execute('INSERT INTO AttachedFiles VALUES (?,?,?,?,?,?,?,?)',[row[name] for name in
            ('id','fileType','uuid','compressedSize','uncompressedSize','compressionType','uncompressedMD5','compressedMD5')])
        connection.commit(); connection.close(); self.index.chmod(0o600)
        self.listing.write_text(json.dumps(document())); self.listing.chmod(0o600)
        self.refresh()

    def refresh(self):
        self.index_hash=digest(self.index.read_bytes()); self.listing_hash=digest(self.listing.read_bytes())

    def run_compare(self):
        return reconcile.reconcile(self.index,self.index_hash,self.listing,self.listing_hash,BUCKET,PREFIX,self.destination)

    def tearDown(self):
        self.temp.cleanup()

    def test_01_real_sqlite_private_report_and_unchanged_inputs(self):
        with patch.object(reconcile.sqlite3,'connect',wraps=sqlite3.connect) as connect:
            result=self.run_compare()
        self.assertIs(connect.call_args.kwargs['uri'],True)
        self.assertTrue(result['comparison_consistent'])
        for field in ('content_verified','provider_verified','snapshot_consistency_verified','restore_verified','migration_authorized'):
            self.assertFalse(result[field])
        self.assertEqual(self.index_hash,digest(self.index.read_bytes()))
        self.assertEqual(self.listing_hash,digest(self.listing.read_bytes()))
        self.assertEqual({p.name for p in self.root.iterdir()},{'index','listing.json','report'})
        self.assertEqual(self.destination.stat().st_mode&0o777,0o700)
        self.assertEqual((self.destination/'report.json').stat().st_mode&0o777,0o600)

    def test_02_cli_mismatch_reports_private_details_and_exit2(self):
        self.listing.write_text(json.dumps(document([]))); self.refresh()
        result=subprocess.run([sys.executable,'-B',reconcile.__file__,'--index',str(self.index),'--listing',str(self.listing),
            '--destination',str(self.destination),'--index-sha256',self.index_hash,'--listing-sha256',self.listing_hash,
            '--bucket',BUCKET,'--prefix',PREFIX],capture_output=True,text=True)
        self.assertEqual(result.returncode,2,result.stderr)
        self.assertNotIn(IDS[0],result.stdout); self.assertNotIn(str(self.root),result.stdout)
        self.assertEqual(json.loads(result.stdout)['counts']['missing'],1)
        self.assertEqual(json.loads((self.destination/'report.json').read_bytes())['details']['missing'][0]['uuid'],IDS[0])

    def test_03_separate_hashes_refuse_changes_without_output(self):
        for attribute in ('index_hash','listing_hash'):
            saved=getattr(self,attribute); setattr(self,attribute,'0'*64)
            with self.assertRaises(ValueError): self.run_compare()
            setattr(self,attribute,saved)
            self.assertFalse(self.destination.exists())

    def test_04_wal_shm_and_journal_sidecars_refused(self):
        for suffix in ('-wal','-shm','-journal'):
            path=self.index.with_name(self.index.name+suffix); path.touch()
            with self.assertRaises(ValueError): self.run_compare()
            path.unlink()

    def test_05_view_wrong_schema_and_corrupt_database_refused(self):
        original=self.index.read_bytes()
        for variant in ('view','schema','corrupt'):
            self.index.write_bytes(original)
            if variant=='corrupt': self.index.write_bytes(b'not sqlite')
            else:
                connection=sqlite3.connect(self.index); connection.execute('DROP TABLE AttachedFiles')
                connection.execute('CREATE VIEW AttachedFiles AS SELECT 1 AS id' if variant=='view' else 'CREATE TABLE AttachedFiles(id INTEGER)')
                connection.commit(); connection.close()
            self.refresh()
            with self.assertRaises((ValueError,sqlite3.DatabaseError)): self.run_compare()
            self.assertFalse(self.destination.exists())

    def test_06_index_changes_before_bound_copy_refused(self):
        real=reconcile.private.copy_bound
        def changed(source,target,expected):
            with source.open('r+b') as stream: stream.seek(100); stream.write(b'changed')
            return real(source,target,expected)
        with patch.object(reconcile.private,'copy_bound',changed),self.assertRaises(ValueError): self.run_compare()
        self.assertFalse(self.destination.exists())

    def test_07_public_files_symlinks_and_hardlinks_refused(self):
        self.index.chmod(0o644)
        with self.assertRaises(ValueError): self.run_compare()
        self.index.chmod(0o600)
        linked=self.root/'linked'; linked.symlink_to(self.index)
        saved=self.index; self.index=linked
        with self.assertRaises(ValueError): self.run_compare()
        self.index=saved; linked.unlink(); os.link(self.index,linked)
        with self.assertRaises(ValueError): self.run_compare()
        linked.unlink()

    def test_08_existing_output_and_failed_publication_preserve_inputs(self):
        self.run_compare(); before=(self.destination/'report.json').read_bytes()
        with self.assertRaises(ValueError): self.run_compare()
        self.assertEqual(before,(self.destination/'report.json').read_bytes())
        self.destination=self.root/'failed'
        with patch.object(reconcile.private,'sync',side_effect=OSError('synthetic disk full')),self.assertRaises(OSError): self.run_compare()
        self.assertFalse(self.destination.exists())
        self.assertEqual(self.index_hash,digest(self.index.read_bytes()))

    def test_09_row_limit_and_duplicate_uuid_are_refused(self):
        self.listing.write_text(json.dumps(document([]))); self.refresh()
        with patch.object(reconcile,'ITEM_LIMIT',0),self.assertRaises(ValueError): self.run_compare()
        connection=sqlite3.connect(self.index)
        connection.execute('INSERT INTO AttachedFiles SELECT id+1,fileType,uuid,compressedSize,uncompressedSize,compressionType,uncompressedMD5,compressedMD5 FROM AttachedFiles')
        connection.commit(); connection.close(); self.refresh()
        with self.assertRaises(ValueError): self.run_compare()

    def test_10_success_cli_never_runs_cloud_or_subprocess_from_core(self):
        with patch.object(reconcile.private.subprocess,'run',side_effect=AssertionError('No subprocess permitted')):
            self.assertTrue(self.run_compare()['comparison_consistent'])

    def test_11_sqlite_progress_deadline_interrupts_expensive_input(self):
        connection=sqlite3.connect(self.index)
        connection.executemany('INSERT INTO AttachedFiles VALUES (?,?,?,?,?,?,?,?)',
            [(number+2,1,'10000000-0000-4000-8000-'+str(number).zfill(12),31,31,1,None,None) for number in range(1000)])
        connection.commit(); connection.close(); self.refresh()
        with patch.object(reconcile.time,'monotonic',side_effect=[0,11]),self.assertRaises(sqlite3.OperationalError):
            self.run_compare()
        self.assertFalse(self.destination.exists())


if __name__=='__main__':
    unittest.main(verbosity=2)
