"""REQ/RISK/TEST-D05B: real Nest/Prisma, Keycloak, Orthanc and owned synthetic data.

No clinical fixture is used. Direct SQL is limited to this run's study identities
for quota/fault/lock setup; observations compare all five persisted write effects.
"""
from __future__ import annotations
import copy, hashlib, io, json, re, subprocess, time, unittest, uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from urllib.request import Request
from urllib.error import HTTPError
from pydicom import dcmread
from pydicom.uid import generate_uid
from invariants_live import LiveStack, ROOT, psql

def literal(value):
    return "'" + value.replace("'", "''") + "'"

class ViewerStack(LiveStack):
    def cleanup_fixture(self, uid):
        if uid not in self.active or not re.fullmatch(r'[0-9.]+', uid):
            raise RuntimeError('Viewer cleanup requires this run-owned synthetic study')
        # RESTRICT is deliberately bypassed only in the owned fixture teardown,
        # deleting children in dependency order. Product routes have no DELETE.
        psql('BEGIN; '+
             f'DELETE FROM "ManualSr" WHERE "studyUid"={literal(uid)}; '+
             f'DELETE FROM "ViewerRequest" WHERE "itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={literal(uid)}); '+
             f'DELETE FROM "ViewerRevision" WHERE "itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={literal(uid)}); '+
             f'DELETE FROM "ViewerItem" WHERE "studyUid"={literal(uid)}; '+
             f'DELETE FROM "ViewerStorageBudget" WHERE "studyUid"={literal(uid)}; COMMIT;')
        super().cleanup_fixture(uid)

class ViewerAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stack = ViewerStack()
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()
        cls.stack.create_test_identity('adminonly', ['admin'], 'hallym')
        cls.stack.token('adminonly')
        # Adjacent suites create different users through Keycloak, outside the
        # product's 60s colleague cache invalidation. Observe this run's actual
        # reviewers before testing P transitions; never retry a failed test as
        # a substitute for proving that fixture precondition.
        started = time.monotonic()
        required = {cls.stack.actor(user) for user in ['jmryu', 'doctor2']}
        while True:
            peers = cls.stack.request('GET', '/colleagues', 'doctor')
            if peers.status != 200:
                raise RuntimeError(f'Colleague fixture readiness failed: HTTP {peers.status}')
            if required.issubset({peer['id'] for peer in peers.body}): break
            if time.monotonic()-started >= 70:
                raise RuntimeError('This run\'s reviewers did not become visible before the readiness deadline')
            time.sleep(1)
        print(f'Colleague fixture readiness verified by API after {time.monotonic()-started:.2f}s', flush=True)

    def setUp(self):
        self.fixture = self.stack.create_fixture()
        self.addCleanup(self.stack.cleanup_fixture, self.fixture.uid)
        self.uid = self.fixture.uid
        self.path = '/studies/'+self.uid+'/viewer-items'
        self.instance = self.stack.first_instance_id(self.uid)
        self.original = self.stack.orthanc_bytes('/instances/'+self.instance+'/file')
        self.ds = dcmread(io.BytesIO(self.original))
        self.ds.filename = None
        self.key = dict(schemaVersion=1, kind='key', seriesUid=str(self.ds.SeriesInstanceUID),
                        sopUid=str(self.ds.SOPInstanceUID), frame=1, title='한글 <script>alert(1)</script>', description='')
        self.addCleanup(lambda: self.assertEqual(self.stack.orthanc_bytes('/instances/'+self.instance+'/file'), self.original))

    def call(self, method='POST', body=None, user='doctor', path=None, status=200):
        response = self.stack.request(method, path or self.path, user, body)
        self.assertEqual(response.status, status, response.text)
        return response.body

    def create(self, item=None, user='doctor', status=200, request_id=None):
        command = dict(requestId=request_id or str(uuid.uuid4()), item=copy.deepcopy(item or self.key))
        return self.call(body=command, user=user, status=status), command

    def revise(self, head, action='edit', item=None, reason=None, status=200, user='doctor'):
        snapshot = {k:v for k,v in head['item'].items() if k!='hidden'} if item is None else item
        command = dict(requestId=str(uuid.uuid4()), expectedRevision=head['revision'], action=action, item=snapshot)
        if reason is not None: command['reason']=reason
        path = self.path+'/'+head['id']+'/revisions'
        return self.call(body=command, path=path, status=status, user=user), command

    def snapshot(self):
        uid=literal(self.uid)
        tables = {'ViewerItem':f'"studyUid"={uid}', 'ViewerRevision':f'"itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={uid})',
                  'ViewerRequest':f'"itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={uid})',
                  'ViewerStorageBudget':f'"studyUid"={uid}', 'AuditLog':f'target={uid}'}
        return {t: psql(f'SELECT to_jsonb(t)::text FROM "{t}" t WHERE {where} ORDER BY to_jsonb(t)::text COLLATE "C"') for t,where in tables.items()}

    def study_update(self, changes):
        assert self.uid in self.stack.active
        psql(f'UPDATE "StudyState" SET {changes} WHERE uid={literal(self.uid)}')

    @contextmanager
    def parent_lock(self, changes=None):
        assert self.uid in self.stack.active
        process = subprocess.Popen(['docker','exec','-i','kin-db','psql','-XqAt','-U','kin','-d','kin','-v','ON_ERROR_STOP=1'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        sql = f'UPDATE "StudyState" SET {changes} WHERE uid={literal(self.uid)}' if changes else f'SELECT uid FROM "StudyState" WHERE uid={literal(self.uid)} FOR UPDATE'
        try:
            process.stdin.write("BEGIN; SET LOCAL statement_timeout='8s'; "+sql+"; SELECT 'LOCKED';\n"); process.stdin.flush()
            while process.stdout.readline().strip() != 'LOCKED':
                if process.poll() is not None: raise RuntimeError('Parent lock setup failed')
            yield
            process.stdin.write('COMMIT;\n'); process.stdin.flush()
        finally:
            try: process.communicate(timeout=10)
            except subprocess.TimeoutExpired: process.kill(); process.communicate(); raise
            self.assertEqual(process.returncode,0,'Parent lock transaction failed')

    def wait_blocked(self):
        deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            query="SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM \"StudyState\"%' AND pid<>pg_backend_pid()"
            if int(psql(query)[0])>0: return
            time.sleep(.03)
        self.fail('API did not observably wait on the parent lock')

    def test_01_lifecycle_replay_and_report_preservation(self):
        self.call(path='/studies/'+self.uid+'/report/commit', body=dict(action='approve',baseVersion=0,
            findings=self.fixture.secret,conclusion='approved',recommendation=''), status=201)
        self.call(method='PUT',path='/studies/'+self.uid+'/report',body=dict(findings='private draft',conclusion='',recommendation=''))
        original={t:psql(f'SELECT to_jsonb(t)::text FROM "{t}" t WHERE uid={literal(self.uid)} ORDER BY to_jsonb(t)::text')
                  for t in ['StudyState','Report','ReportDraft','ReportVersion']}
        head,create=self.create()
        self.assertEqual(head['authorSub'],self.stack.user_ids['doctor'])
        self.assertEqual(head['revision'],1)
        self.assertEqual(self.call(method='GET')['items'],[head])
        before=self.snapshot()
        self.assertEqual(self.call(body=create),head); self.assertEqual(self.snapshot(),before)
        edited,_=self.revise(head,item={**self.key,'title':'편집😀'})
        hidden,_=self.revise(edited,'hide',reason='중복 표시')
        self.assertEqual(self.call(method='GET')['items'],[])
        self.assertTrue(self.call(method='GET',path=self.path+'?includeHidden=true')['items'][0]['item']['hidden'])
        self.call(method='DELETE',path='/studies/'+self.uid,user='tech',status=409)
        restored,_=self.revise(hidden,'restore',reason='복원')
        self.assertFalse(restored['item']['hidden']); self.assertEqual(restored['revision'],4)
        self.assertEqual(self.call(body=create),head)
        history=self.call(method='GET',path=self.path+'/'+head['id']+'/revisions')['revisions']
        self.assertEqual([r['action'] for r in history],['create','edit','hide','restore'])
        self.assertEqual(history[0]['item']['title'],self.key['title'])
        counts=json.loads(self.snapshot()['ViewerStorageBudget'][0])
        self.assertEqual((counts['itemCount'],counts['revisionCount']),(1,4))
        self.assertEqual(counts['payloadBytes'],sum(r['payloadBytes'] for r in history))
        self.assertNotIn(self.key['title'],' '.join(self.snapshot()['AuditLog']))
        for t,rows in original.items(): self.assertEqual(psql(f'SELECT to_jsonb(t)::text FROM "{t}" t WHERE uid={literal(self.uid)} ORDER BY to_jsonb(t)::text'),rows)

    def test_02_every_route_role_tenant_preliminary_and_retired_owner(self):
        head,command=self.create()
        revision_path=self.path+'/'+head['id']+'/revisions'
        edit=dict(requestId=str(uuid.uuid4()),expectedRevision=1,action='edit',item=self.key)
        routes=[('GET',self.path,None),('POST',self.path,command),('GET',revision_path,None),('POST',revision_path,edit)]
        for method,path,body in routes:
            self.call(method,body,'kdoctor',path,403)
            gateway=self.stack.bearer_request(method,path,self.stack.service_token('gateway'),body)
            self.assertEqual(gateway.status,403)
            self.call(method,body,'adminonly',path,200 if method=='GET' else 403)
            self.call(method,body,'tech',path,200 if method=='GET' else 403)
        self.call(body=edit,path=revision_path,user='doctor2',status=403)
        self.study_update('"teleInstitutionId"=\'kin-center\'')
        self.call(method='GET',user='kdoctor')
        tele,_=self.create(user='kdoctor')
        self.study_update('"teleInstitutionId"=NULL')
        self.call(method='GET',user='kdoctor',status=403)
        self.assertEqual(len(self.call(method='GET')['items']),2)
        self.revise(tele,user='doctor',status=403)
        self.call(path='/studies/'+self.uid+'/report/commit', body=dict(action='preliminary',baseVersion=0,
            reviewer=self.stack.actor('jmryu'),findings='preliminary',conclusion='',recommendation=''),status=201)
        for method,path,body in routes:
            for user in ['doctor2','adminonly','tech']:
                self.call(method,body,user,path,403)
        self.call(method='GET',user='jmryu')
        self.call(body=command)
        self.study_update('"institutionId"=NULL, "teleInstitutionId"=NULL')
        for method,path,body in routes: self.call(method,body,'jmryu',path,403)

    def test_03_raw_input_canonical_replays_and_no_store(self):
        head,command=self.create()
        token=self.stack.token('doctor')
        raw=json.dumps(command).replace('"frame": 1','"frame": 1e0').encode()
        response=self.stack.bearer_request('POST',self.path,token,raw,headers={'Content-Type':'application/json'})
        self.assertEqual(response.status,200); self.assertEqual(response.body,head)
        equivalent=dict(item={k:v for k,v in reversed(list(self.key.items())) if k!='description'},requestId=command['requestId'])
        self.assertEqual(self.call(body=equivalent),head)
        unicode_raw=json.dumps(command,ensure_ascii=False).encode()
        response=self.stack.bearer_request('POST',self.path,token,unicode_raw,headers={'Content-Type':'application/json'})
        self.assertEqual(response.status,200);self.assertEqual(response.body,head)
        raw=json.dumps(command).encode()
        invalid=[raw[:-1]+b',"requestId":"'+str(uuid.uuid4()).encode()+b'"}',
                 raw[:-1]+b',"\\u0072equestId":"'+str(uuid.uuid4()).encode()+b'"}',
                 raw.replace(b'"frame": 1',b'"frame": 1e999'),raw+b' '*32769,
                 raw.replace(b'"description": ""',b'"description": "\\ud800"'),
                 raw.replace(b'"description": ""',b'"description": "\\u0000"')]
        before=self.snapshot()
        for value in invalid:
            response=self.stack.bearer_request('POST',self.path,token,value,headers={'Content-Type':'application/json'})
            self.assertEqual(response.status,400,response.text)
        self.call(body={**command,'item':{**self.key,'title':'different'}},status=409)
        for extra in ['author','institution','createdAt','cachedStats']:
            self.call(body={**command,extra:'forged'},status=400)
        for query in ['?limit=101','?limit=0','?cursor=invalid','?includeHidden=yes','?limit=1&limit=2']:
            self.call(method='GET',path=self.path+query,status=400)
        self.call(method='GET',path=self.path+'/'+head['id']+'/revisions?cursor=1&cursor=2',status=400)
        self.assertEqual(self.snapshot(),before)
        raw=json.dumps(command).encode()
        bounded=raw+b' '*(32768-len(raw))
        response=self.stack.bearer_request('POST',self.path,token,bounded,headers={'Content-Type':'application/json'})
        self.assertEqual(response.status,200);self.assertEqual(response.body,head)
        with self.assertRaises(HTTPError) as error:
            self.stack._open(Request(self.stack.api+self.path,data=b'{bad',headers={'Content-Type':'application/json','Authorization':'Bearer '+token}))
        self.assertEqual(error.exception.headers.get('Cache-Control'),'no-store')
        error.exception.close()
        for path,auth in [(self.path,True),(self.path,False),('/studies/2.25.0/viewer-items',True)]:
            headers={'Authorization':'Bearer '+token} if auth else {}
            try: response=self.stack._open(Request(self.stack.api+path,headers=headers))
            except HTTPError as e: response=e
            with response: self.assertEqual(response.headers.get('Cache-Control'),'no-store')
        _,nfc=self.create({**self.key,'title':'é'})
        self.call(body={**nfc,'item':{**nfc['item'],'title':'é'}},status=409)

    def test_04_actual_dicom_reference_frame_and_geometry(self):
        for change in [{'seriesUid':'2.25.99'},{'sopUid':'2.25.99'},{'frame':2},{'frame':0},{'frame':1.5}]:
            self.create({**self.key,**change},status=400)
        ipp=[float(x) for x in self.ds.ImagePositionPatient]
        arrow={k:v for k,v in self.key.items() if k not in ['title','description']}
        arrow.update(kind='arrow',frameOfReferenceUid=str(self.ds.FrameOfReferenceUID),label='화살표',points=[ipp,ipp])
        self.create(arrow)
        # Actual GPU stack points can contain near-zero exponent values. Counting
        # one JSON serialization and persisting another used to violate the DB
        # payload-byte equality constraint even for these valid CT coordinates.
        fractional = {**arrow, 'points': [[ipp[0]+.125, ipp[1]+.25, ipp[2]+5.684341886080802e-14],
                                        [ipp[0]+.375, ipp[1]+.5, ipp[2]+5.684341886080802e-14]]}
        fractional_head, fractional_request = self.create(fractional)
        self.assertEqual(fractional_head['item']['points'], fractional['points'])
        self.assertEqual(self.call(body=fractional_request), fractional_head)
        self.assertEqual(psql(f'SELECT count(*) FROM "ViewerRevision" WHERE "itemId"={literal(fractional_head["id"])}::uuid AND "payloadBytes"=octet_length(convert_to(snapshot::text,\'UTF8\'))'), ['1'])
        for change in [{'frameOfReferenceUid':'2.25.99'}, {'points':[[1e99,1e99,1e99],ipp]}]:
            self.create({**arrow,**change},status=400)
        for sop_class,frames in [('1.2.840.10008.5.1.4.1.1.4',1),('1.2.840.10008.5.1.4.1.1.1',1),
                                  ('1.2.840.10008.5.1.4.1.1.1.1',1),('1.2.840.10008.5.1.4.1.1.3.1',3)]:
            ds=copy.deepcopy(self.ds); ds.SOPInstanceUID=generate_uid(); ds.SeriesInstanceUID=generate_uid(); ds.SOPClassUID=sop_class
            ds.file_meta.MediaStorageSOPInstanceUID=ds.SOPInstanceUID;ds.file_meta.MediaStorageSOPClassUID=sop_class
            if frames>1: ds.NumberOfFrames=frames;ds.PixelData=ds.PixelData*frames
            stream=io.BytesIO(); ds.save_as(stream,write_like_original=False)
            response=self.stack._orthanc_request('POST','/instances',stream.getvalue()); self.assertEqual(response.status,200)
            key={**self.key,'seriesUid':str(ds.SeriesInstanceUID),'sopUid':str(ds.SOPInstanceUID),'frame':frames}
            self.create(key); self.create({**key,'frame':frames+1},status=400)
            self.create({**arrow,'seriesUid':key['seriesUid'],'sopUid':key['sopUid']},status=400)
        other=self.stack.create_fixture();self.addCleanup(self.stack.cleanup_fixture,other.uid)
        self.call(path='/studies/'+other.uid+'/viewer-items',body=dict(requestId=str(uuid.uuid4()),item=self.key),status=400)
        duplicate=copy.deepcopy(self.ds)
        duplicate.StudyInstanceUID=other.uid;duplicate.SeriesInstanceUID=generate_uid()
        duplicate.PatientID=other.patient_id;duplicate.PatientName='SYNTHETIC^D05B-DUPLICATE'
        stream=io.BytesIO();duplicate.save_as(stream,write_like_original=False)
        response=self.stack._orthanc_request('POST','/instances',stream.getvalue());self.assertEqual(response.status,200)
        found=self.stack._orthanc_request('POST','/tools/lookup',self.key['sopUid'].encode())
        self.assertEqual(len([x for x in found.body if x['Type']=='Instance']),2)
        self.create(status=400)

    def test_05_concurrent_revision_replay_and_cross_target_request(self):
        head,command=self.create()
        path=self.path+'/'+head['id']+'/revisions'
        commands=[dict(requestId=str(uuid.uuid4()),expectedRevision=1,action='edit',item={**self.key,'title':str(i)}) for i in range(2)]
        with ThreadPoolExecutor(2) as pool:
            responses=list(pool.map(lambda x:self.stack.request('POST',path,'doctor',x),commands))
        self.assertEqual(sorted(r.status for r in responses),[200,409])
        before=self.snapshot()
        with ThreadPoolExecutor(2) as pool:
            responses=list(pool.map(lambda _:self.stack.request('POST',self.path,'doctor',command),range(2)))
        self.assertEqual([r.body for r in responses],[head,head]); self.assertEqual(self.snapshot(),before)
        new=dict(requestId=str(uuid.uuid4()),item=self.key)
        with ThreadPoolExecutor(2) as pool:
            responses=list(pool.map(lambda _:self.stack.request('POST',self.path,'doctor',new),range(2)))
        self.assertEqual([r.status for r in responses],[200,200]);self.assertEqual(responses[0].body,responses[1].body)
        changed={**commands[0],'requestId':command['requestId']}
        self.call(body=changed,path=path,status=409)
        self.call(body=changed,path=self.path+'/'+str(uuid.uuid4())+'/revisions',status=409)
        self.call(method='GET',path=self.path+'/'+str(uuid.uuid4())+'/revisions',status=404)

    def test_06_quota_last_slot_bytes_and_rollback(self):
        head,command=self.create()
        for field,last in [('itemCount',511),('revisionCount',4095),('payloadBytes',16777216)]:
            # Boundary counters are seeded only on this owned fixture. Other tests
            # establish the exact increment-to-revision sum from real API writes.
            saved=json.loads(self.snapshot()['ViewerStorageBudget'][0])
            if field=='payloadBytes':
                sample=json.loads(self.snapshot()['ViewerRevision'][0]); last-=sample['payloadBytes']
            psql(f'UPDATE "ViewerStorageBudget" SET "{field}"={last} WHERE "studyUid"={literal(self.uid)}')
            try:
                with ThreadPoolExecutor(2) as pool:
                    responses=list(pool.map(lambda _:self.stack.request('POST',self.path,'doctor',dict(requestId=str(uuid.uuid4()),item=self.key)),range(2)))
                self.assertEqual(sorted(r.status for r in responses),[200,409])
                self.assertEqual(next(r for r in responses if r.status==409).body['code'],'VIEWER_STORAGE_LIMIT')
                before=self.snapshot();self.assertEqual(self.call(body=command),head)
                self.create(status=409);self.assertEqual(self.snapshot(),before)
                if field!='itemCount':
                    self.revise(head,'hide',reason='사유',status=409);self.assertEqual(self.snapshot(),before)
            finally:
                psql(f'UPDATE "ViewerStorageBudget" SET "itemCount"={saved["itemCount"]}, "revisionCount"={saved["revisionCount"]}, "payloadBytes"={saved["payloadBytes"]} WHERE "studyUid"={literal(self.uid)}')
        name='viewer_fault_'+uuid.uuid4().hex
        target=literal(self.uid)
        psql(f'CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target={target} AND NEW.action LIKE \'viewer.%\' THEN RAISE EXCEPTION \'SYNTHETIC viewer audit fault\'; END IF; RETURN NEW; END $$; CREATE TRIGGER {name} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION {name}();')
        try:
            before=self.snapshot();self.create(status=500);self.assertEqual(self.snapshot(),before)
            self.revise(head,status=500);self.assertEqual(self.snapshot(),before)
        finally: psql(f'DROP TRIGGER {name} ON "AuditLog"; DROP FUNCTION {name}();')

    def test_07_parent_lock_revocation_preliminary_and_delete(self):
        self.study_update('"teleInstitutionId"=\'kin-center\'')
        head,command=self.create(user='kdoctor')
        with ThreadPoolExecutor(1) as pool:
            with self.parent_lock('"teleInstitutionId"=NULL'):
                future=pool.submit(self.stack.request,'POST',self.path,'kdoctor',command);self.wait_blocked()
            self.assertEqual(future.result().status,403)
        with ThreadPoolExecutor(1) as pool:
            with self.parent_lock('rs=\'P\', "preDoc"=\'SYNTHETIC-other\', "preReviewer"=\'SYNTHETIC-reviewer\''):
                future=pool.submit(self.stack.request,'POST',self.path,'doctor',dict(requestId=str(uuid.uuid4()),item=self.key));self.wait_blocked()
            self.assertEqual(future.result().status,403)
        self.study_update('rs=\'W\',"preDoc"=NULL,"preReviewer"=NULL')
        with self.assertRaises(RuntimeError): psql(f'DELETE FROM "StudyState" WHERE uid={literal(self.uid)}')
        self.call(method='DELETE',path='/studies/'+self.uid,user='tech',status=409)
        # A first create versus state deletion must leave a whole item, or no item.
        extra=self.stack.create_fixture();self.addCleanup(self.stack.cleanup_fixture,extra.uid)
        instance=self.stack.first_instance_id(extra.uid);ds=dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+instance+'/file')))
        item={**self.key,'seriesUid':str(ds.SeriesInstanceUID),'sopUid':str(ds.SOPInstanceUID)}
        with ThreadPoolExecutor(2) as pool:
            write=pool.submit(self.stack.request,'POST','/studies/'+extra.uid+'/viewer-items','doctor',dict(requestId=str(uuid.uuid4()),item=item))
            delete=pool.submit(self.stack.request,'DELETE','/studies/'+extra.uid,'tech')
            codes=(write.result().status,delete.result().status)
        self.assertIn(codes,[(200,409),(403,200)])

    def test_08_exclusive_pagination_and_hidden_cursor(self):
        heads=[self.create()[0] for _ in range(4)]
        ordered=sorted(heads,key=lambda h:h['id'])
        first=self.call(method='GET',path=self.path+'?limit=2')
        self.assertEqual([x['id'] for x in first['items']],[x['id'] for x in ordered[:2]])
        self.revise(ordered[1],'hide',reason='숨김')
        second=self.call(method='GET',path=self.path+'?limit=2&cursor='+first['nextCursor'])
        self.assertEqual([x['id'] for x in second['items']],[x['id'] for x in ordered[2:]])
        self.assertIsNone(second['nextCursor'])
        path=self.path+'/'+ordered[1]['id']+'/revisions'
        history=self.call(method='GET',path=path+'?limit=1')
        self.assertEqual(history['nextCursor'],1)
        tail=self.call(method='GET',path=path+'?limit=1&cursor=1')
        self.assertEqual(tail['revisions'][0]['revision'],2);self.assertIsNone(tail['nextCursor'])

    def test_09_database_lock_timeout_is_retryable_and_inert(self):
        head,command=self.create()
        before=self.snapshot()
        with ThreadPoolExecutor(1) as pool:
            with self.parent_lock():
                future=pool.submit(self.stack.request,'POST',self.path,'doctor',dict(requestId=str(uuid.uuid4()),item=self.key))
                self.wait_blocked()
                self.assertEqual(future.result(timeout=7).status,503)
        self.assertEqual(self.snapshot(),before)
        self.assertEqual(self.call(body=command),head)

if __name__=='__main__': unittest.main(verbosity=2)
