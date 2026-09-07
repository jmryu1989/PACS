"""Default-off cost boundary and synthetic sealed-export transfer failures."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import ops_offsite_backup as offsite


def record(raw):
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def write(path, value):
    path.write_bytes(value)
    path.chmod(0o600)
    return path


def config():
    return dict(schema=1, enabled=True, endpoint=offsite.ENDPOINT, region=offsite.REGION,
                bucket='kin-synthetic-only', prefix='backup/', credentials_file=str(Path.cwd()/'private/secret.json'))


class NoCost(unittest.TestCase):
    def test_01_default_cli_disabled_without_credentials_sdk_or_source(self):
        result = subprocess.run([sys.executable, '-B', str(Path(offsite.__file__)),
                                 '--source', 'PRIVATE_MISSING', '--destination', 'PRIVATE_MISSING'],
                                capture_output=True, text=True, env=dict(os.environ, AWS_ACCESS_KEY_ID='ENV_SENTINEL',
                                KIN_OFFSITE_ENABLED='true'))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {k: offsite.DISABLED[k] for k in
                         ('enabled','skipped','transfer_verified','restore_verified','deployment_authorized')})
        self.assertNotIn('PRIVATE_MISSING', result.stdout + result.stderr)

    def test_02_disabled_does_not_touch_any_dependent_resource(self):
        with tempfile.TemporaryDirectory() as folder:
            path=write(Path(folder)/'config.json',b'{"schema":1,"enabled":false}')
            with patch.object(offsite.private,'linux_only',side_effect=AssertionError), \
                 patch.object(offsite.private,'read_small',side_effect=AssertionError), \
                 patch.object(offsite,'sdk_client',side_effect=AssertionError):
                self.assertEqual(offsite.run(path,object(),object(),object()),offsite.DISABLED)

    def test_03_invalid_switches_and_duplicate_keys_refused(self):
        for value in ('true','false',0,1,None,[],{}):
            with self.subTest(value=value),self.assertRaises(ValueError):
                offsite.configuration(json.dumps({'schema':1,'enabled':value}).encode())
        for raw in (b'{"schema":1,"enabled":false,"enabled":true}',b'{"schema":true,"enabled":false}',
                    b'{"enabled":false}',b'{"schema":1,"enabled":false,"force":true}'):
            with self.assertRaises(ValueError):offsite.configuration(raw)

    def test_04_enabled_config_has_fixed_destination_and_explicit_credentials(self):
        self.assertEqual(offsite.configuration(json.dumps(config()).encode()),config())
        for name,value in [('endpoint','https://example.com'),('region','other'),('bucket','bad/name'),
                           ('bucket','a.b'),('prefix','../backup/'),('prefix','backup//'),
                           ('credentials_file','relative')]:
            with self.subTest(name=name),self.assertRaises(ValueError):
                offsite.configuration(json.dumps(dict(config(),**{name:value})).encode())

    def test_05_cli_failure_does_not_print_secret_or_path(self):
        with tempfile.TemporaryDirectory() as folder:
            path=write(Path(folder)/'config.json',b'{"schema":1,"enabled":"PRIVATE_SENTINEL"}')
            result=subprocess.run([sys.executable,'-B',str(Path(offsite.__file__)),'--config',str(path)],
                                  capture_output=True,text=True)
            self.assertEqual(result.returncode,1)
            self.assertNotIn('PRIVATE_SENTINEL',result.stdout+result.stderr)
            self.assertNotIn(folder,result.stdout+result.stderr)

    def test_06_request_guard_blocks_redirect_wrong_key_and_cloud_management(self):
        key='backup/receipt/run/payload.age'
        guard=offsite.RequestGuard(config(),[key])
        request=SimpleNamespace(method='PUT',url=offsite.ENDPOINT+'/kin-synthetic-only/'+key,body=b'cipher')
        guard(request,event_name='before-send.s3.PutObject')
        for change,event in [({'url':request.url.replace('kakaocloud.com','example.com')},'PutObject'),
                             ({'url':request.url+'/other'},'PutObject'),({},'CreateBucket'),
                             ({'method':'DELETE'},'DeleteObject'),({'url':request.url+'?acl'},'PutObject'),
                             ({'url':request.url+'?x=1&x=2'},'PutObject')]:
            with self.subTest(event=event),self.assertRaises(ValueError):
                guard(SimpleNamespace(**dict(vars(request),**change)),event_name='before-send.s3.'+event)

    def test_07_guard_allows_only_multipart_and_download_within_scope(self):
        key='backup/receipt/run/payload.age'; guard=offsite.RequestGuard(config(),[key])
        base=offsite.ENDPOINT+'/kin-synthetic-only/'+key
        for method,query,event in [('POST','?uploads','CreateMultipartUpload'),
                                  ('PUT','?uploadId=opaque&partNumber=1','UploadPart'),
                                  ('POST','?uploadId=opaque','CompleteMultipartUpload'),
                                  ('DELETE','?uploadId=opaque','AbortMultipartUpload'),('GET','','GetObject')]:
            guard(SimpleNamespace(method=method,url=base+query,body=None),event_name='before-send.s3.'+event)
        with patch.object(offsite,'TIME_LIMIT',0),self.assertRaises(ValueError):guard.check_time()

    def test_08_readback_detects_truncation_wrong_content_and_closes_body(self):
        for data,length,status in [(b'bad',4,200),(b'xxxx',4,200),(b'goodx',4,200),(b'good',4,403)]:
            stream=io.BytesIO(data)
            client=SimpleNamespace(get_object=lambda **kw: {'Body':stream,'ContentLength':length,
                                    'ResponseMetadata':{'HTTPStatusCode':status}})
            with self.subTest(data=data,status=status),self.assertRaises(ValueError):
                offsite.readback(client,offsite.RequestGuard(config(),['key']),'bucket','key',record(b'good'))
            self.assertTrue(stream.closed)


@unittest.skipUnless(sys.platform=='linux','Enabled transfer requires Linux private staging')
class Transfer(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='kin-offsite-test-')
        self.root=Path(self.temp.name);self.root.chmod(0o700)
        self.source=self.root/'sealed';self.source.mkdir(mode=0o700)
        self.payload=b'age-encryption.org/v1\n'+b'SYNTHETIC-CIPHERTEXT\0'*(1024*60)
        write(self.source/'payload.age',self.payload)
        self.receipt=dict(schema=1,inventory_sha256='0'*64,source_git_sha='1'*40,
            age_sha256=offsite.private.AGE_SHA256,recipient_sha256='2'*64,
            plaintext=record(b'SYNTHETIC ONLY'),ciphertext=record(self.payload),**offsite.private.source_hashes())
        self.raw=offsite.private.encode(self.receipt)
        write(self.source/'receipt.json',self.raw)
        self.sha=hashlib.sha256(self.raw).hexdigest()
        self.secret=write(self.root/'secret.json',b'{"access_key_id":"SYNTHETIC","secret_access_key":"SYNTHETIC-NO-ACCOUNT"}')
        self.cfg=dict(config(),credentials_file=str(self.secret))
        self.path=write(self.root/'config.json',offsite.private.encode(self.cfg))
        self.output=self.root/'verified'
        self.remote={};self.uploads=[];self.closed=False;self.factories=0;self.mode=None
        self.original={p.name:p.read_bytes() for p in self.source.iterdir()}

    def tearDown(self):self.temp.cleanup()

    def factory(self,config,secret,keys):
        self.factories+=1
        self.assertEqual(secret['access_key_id'],'SYNTHETIC')
        self.assertEqual(len(keys),2)
        self.assertTrue(all(key.startswith('backup/'+self.sha+'/') for key in keys))
        client=SimpleNamespace(get_object=self.get_object,close=lambda:setattr(self,'closed',True))
        return client,offsite.RequestGuard(config,keys)

    def upload(self,client,bucket,key,stream):
        self.assertEqual(bucket,'kin-synthetic-only')
        self.uploads.append(key)
        if self.mode=='upload_fail':raise OSError('PRIVATE_SENTINEL')
        self.remote[key]=stream.read()

    def get_object(self,**args):
        if self.mode=='get_fail':raise OSError('PRIVATE_SENTINEL')
        data=self.remote[args['Key']]
        if self.mode=='corrupt' and args['Key'].endswith('payload.age'):data=b'x'+data[1:]
        stream=io.BytesIO(data)
        return dict(Body=stream,ContentLength=len(data),ResponseMetadata={'HTTPStatusCode':200})

    def run_transfer(self):
        return offsite.run(self.path,self.source,self.sha,self.output,factory=self.factory,uploader=self.upload)

    def assert_original(self):
        self.assertEqual({p.name:p.read_bytes() for p in self.source.iterdir()},self.original)

    def test_01_upload_and_full_readback_before_private_success_receipt(self):
        result=self.run_transfer()
        self.assertTrue(result['transfer_verified'])
        self.assertFalse(result['restore_verified']);self.assertFalse(result['deployment_authorized'])
        self.assertEqual(len(self.uploads),2);self.assertTrue(self.closed)
        self.assertEqual({key.rsplit('/',1)[1] for key in self.remote},{'payload.age','receipt.json'})
        self.assertEqual(json.loads((self.output/'result.json').read_bytes()),result)
        self.assertEqual((self.output/'result.json').stat().st_mode&0o777,0o600)
        self.assert_original()

    def test_02_failures_do_not_publish_success_or_remove_original(self):
        for mode in ('upload_fail','get_fail','corrupt'):
            self.mode=mode;self.output=self.root/('failed_'+mode)
            with self.subTest(mode=mode),self.assertRaises((ValueError,OSError)):self.run_transfer()
            self.assertFalse(self.output.exists());self.assertTrue(self.closed)
            self.assertEqual({p.name for p in (self.root/('.'+self.output.name+'.pending')).iterdir()},{'failure.json'})
            self.assert_original()

    def test_03_bad_receipt_or_ciphertext_refused_before_client(self):
        self.sha='0'*64
        with self.assertRaises(ValueError):self.run_transfer()
        self.sha=hashlib.sha256(self.raw).hexdigest()
        write(self.source/'payload.age',b'WRONG')
        with self.assertRaises(ValueError):self.run_transfer()
        self.assertEqual(self.factories,0)

    def test_04_plaintext_extra_key_or_symlink_refused_before_client(self):
        extra=write(self.source/'identity.txt',b'SYNTHETIC SECRET')
        with self.assertRaises(ValueError):self.run_transfer()
        extra.unlink()
        (self.source/'payload.age').unlink();(self.source/'payload.age').symlink_to(self.secret)
        with self.assertRaises(ValueError):self.run_transfer()
        self.assertEqual(self.factories,0)

    def test_05_loose_credentials_and_existing_output_refused(self):
        self.secret.chmod(0o644)
        with self.assertRaises(ValueError):self.run_transfer()
        self.secret.chmod(0o600);self.output.mkdir(mode=0o700)
        sentinel=write(self.output/'keep',b'USER DATA')
        with self.assertRaises(ValueError):self.run_transfer()
        self.assertEqual(sentinel.read_bytes(),b'USER DATA');self.assertEqual(self.factories,0)

    def test_06_no_remote_overwrite_on_separate_retry(self):
        first=self.run_transfer();self.output=self.root/'verified_retry'
        second=self.run_transfer()
        self.assertTrue(set(first['keys']).isdisjoint(second['keys']))
        self.assertEqual(len(self.remote),4);self.assert_original()


class SDK(unittest.TestCase):
    def test_01_real_pinned_sdk_serializes_upload_and_get_with_stubbed_transport(self):
        try:
            from botocore.stub import Stubber,ANY
        except ImportError:
            if os.environ.get('KIN_REQUIRE_STORAGE_SDK')=='1':raise
            self.skipTest('Pinned SDK exercised in isolated Linux/CI job')
        secret={'access_key_id':'SYNTHETIC','secret_access_key':'SYNTHETIC-NO-ACCOUNT'}
        key='backup/synthetic/run/payload.age'
        client,guard=offsite.sdk_client(config(),secret,[key])
        with Stubber(client) as stub:
            stub.add_response('put_object',{'ETag':'"not-a-sha256"'},
                              {'Bucket':'kin-synthetic-only','Key':key,'Body':ANY,'ContentType':'application/octet-stream'})
            stub.add_response('get_object',{'Body':io.BytesIO(b'cipher'),'ContentLength':6,
                              'ResponseMetadata':{'HTTPStatusCode':200}}, {'Bucket':'kin-synthetic-only','Key':key})
            offsite.upload(client,'kin-synthetic-only',key,io.BytesIO(b'cipher'))
            offsite.readback(client,guard,'kin-synthetic-only',key,record(b'cipher'))
            stub.assert_no_pending_responses()
        client.close()

    def test_02_multipart_sdk_path_and_failed_part_abort_are_scoped(self):
        try:
            from botocore.stub import Stubber,ANY
        except ImportError:
            if os.environ.get('KIN_REQUIRE_STORAGE_SDK')=='1':raise
            self.skipTest('Pinned SDK exercised in isolated Linux/CI job')
        secret={'access_key_id':'SYNTHETIC','secret_access_key':'SYNTHETIC-NO-ACCOUNT'}
        key='backup/synthetic/run/payload.age'
        for failure in (False,True):
            client,guard=offsite.sdk_client(config(),secret,[key])
            with self.subTest(failure=failure),Stubber(client) as stub:
                stub.add_response('create_multipart_upload',{'UploadId':'SYNTHETIC-UPLOAD'},
                    {'Bucket':'kin-synthetic-only','Key':key,'ContentType':'application/octet-stream'})
                part={'Bucket':'kin-synthetic-only','Key':key,'UploadId':'SYNTHETIC-UPLOAD','PartNumber':1,'Body':ANY}
                if failure:
                    stub.add_client_error('upload_part',service_error_code='AccessDenied',http_status_code=403,
                                          expected_params=part)
                    stub.add_response('abort_multipart_upload',{},
                        {'Bucket':'kin-synthetic-only','Key':key,'UploadId':'SYNTHETIC-UPLOAD'})
                else:
                    stub.add_response('upload_part',{'ETag':'"one"'},part)
                    stub.add_response('upload_part',{'ETag':'"two"'},dict(part,PartNumber=2))
                    stub.add_response('complete_multipart_upload',{},
                        {'Bucket':'kin-synthetic-only','Key':key,'UploadId':'SYNTHETIC-UPLOAD',
                         'MultipartUpload':{'Parts':[{'ETag':'"one"','PartNumber':1},{'ETag':'"two"','PartNumber':2}]}})
                with io.BytesIO(b'x'*(64*1024**2+1)) as payload:
                    if failure:
                        with self.assertRaises(Exception):offsite.upload(client,'kin-synthetic-only',key,payload)
                    else:offsite.upload(client,'kin-synthetic-only',key,payload)
                stub.assert_no_pending_responses()
            client.close()


if __name__=='__main__':unittest.main(verbosity=2)
