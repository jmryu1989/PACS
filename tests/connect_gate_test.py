"""TEST-EG-01..12: real local auth/C-STORE/DB gates with owned synthetic rows.

SQL fault/time/lock setup never selects a clinical identity. Cleanup verifies the
run's actor and captured full rows before removing children in dependency order.
"""
from __future__ import annotations
import io, json, re, subprocess, sys, time, unittest, uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError
from urllib.request import Request
from pydicom import dcmread
from invariants_live import LiveStack


def psql(sql):
    # The 100-row pagination teardown exceeds Windows' argv limit. Pass SQL on
    # stdin so the full-row equality guard is retained for every captured row.
    result=subprocess.run(['docker','exec','-i','-e','PGTZ=UTC','kin-db','psql','-XqAt','-U','kin','-d','kin','-v','ON_ERROR_STOP=1'],
        input=sql,encoding='utf-8',capture_output=True,timeout=30)
    if result.returncode:raise RuntimeError('Owned Connect SQL failed: '+result.stderr)
    return [line for line in result.stdout.splitlines() if line.strip()]


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def stamp(days=0):
    return (datetime.now(timezone.utc)+timedelta(days=days)).isoformat(timespec='milliseconds').replace('+00:00','Z')


def rows(table, where):
    return [json.loads(s) for s in psql(f'SELECT to_jsonb(t)::text FROM "{table}" t WHERE {where} ORDER BY to_jsonb(t)::text COLLATE "C"')]


def exact_deletes(table, captured):
    statements=[]
    for row in captured:
        payload=literal(json.dumps(row,ensure_ascii=False))
        statements.append(f'''DO $$ DECLARE n integer; BEGIN
          DELETE FROM "{table}" t WHERE id={literal(row['id'])} AND to_jsonb(t)={payload}::jsonb;
          GET DIAGNOSTICS n = ROW_COUNT;
          IF n<>1 THEN RAISE EXCEPTION 'Owned Connect cleanup row changed'; END IF;
        END $$;''')
    return '\n'.join(statements)


class ConnectStack(LiveStack):
    def cleanup_fixture(self, uid):
        if uid not in self.active or not re.fullmatch(r'[0-9.]+',uid):
            raise RuntimeError('Connect cleanup requires this run-owned study')
        statements=[]
        for table,actor in [('Transfer','requestedBy'),('TransferBasis','recordedBy')]:
            captured=rows(table,'"studyUid"='+literal(uid))
            if any(r[actor] not in self.actors.values() for r in captured):
                raise RuntimeError('Connect child has a foreign actor')
            statements.append(exact_deletes(table,captured))
        captured=rows('AuditLog','target='+literal(uid)+" AND (action LIKE 'basis.%' OR action LIKE 'transfer.%')")
        if any(r['actor'] not in self.actors.values() for r in captured):
            raise RuntimeError('Connect audit has a foreign actor')
        statements.append(exact_deletes('AuditLog',captured))
        psql('BEGIN;\n'+'\n'.join(statements)+'\nCOMMIT;')
        super().cleanup_fixture(uid)


class ConnectGateAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stack=ConnectStack()
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()
        for name,group in [('adminonly','hallym'),('kadmin','kin-center')]:
            cls.stack.create_test_identity(name,['admin'],group)
            cls.stack.token(name)
        cls.gateway=cls.stack.service_token('gateway')

    def setUp(self):
        self.fixtures=[]; self.agreements={}
        self.addCleanup(self.cleanup_owned)
        self.fixture=self.fixture_for()
        self.uid=self.fixture.uid; self.path='/studies/'+self.uid
        self.instance=self.stack.first_instance_id(self.uid)
        self.original=self.stack.orthanc_bytes('/instances/'+self.instance+'/file')
        self.assertEqual(str(dcmread(io.BytesIO(self.original)).PatientID),self.fixture.patient_id)
        self.addCleanup(lambda:self.assertEqual(self.stack.orthanc_bytes('/instances/'+self.instance+'/file'),self.original))

    def fixture_for(self, institution='한림병원'):
        fixture=self.stack.create_fixture(institution); self.fixtures.append(fixture)
        return fixture

    def cleanup_owned(self):
        for fixture in reversed(self.fixtures):
            self.stack.cleanup_fixture(fixture.uid)
        statements=[]
        for aid,actor in self.agreements.items():
            captured=rows('ProcessingAgreement','id='+literal(aid))
            self.assertEqual(len(captured),1)
            self.assertEqual(captured[0]['recordedBy'],actor)
            audits=rows('AuditLog','target='+literal(aid))
            self.assertTrue(all(r['actor'] in self.stack.actors.values() and r['action'].startswith('agreement.') for r in audits))
            statements += [exact_deletes('AuditLog',audits),exact_deletes('ProcessingAgreement',captured)]
        psql('BEGIN;\n'+'\n'.join(statements)+'\nCOMMIT;')

    def call(self, method, path, body=None, user='adminonly', status=None):
        result=self.stack.request(method,path,user,body)
        self.assertEqual(result.status,status if status is not None else (201 if method=='POST' else 200),result.text)
        return result.body

    def basis(self, fixture=None, user='adminonly', **changes):
        return self.call('POST','/studies/'+(fixture or self.fixture).uid+'/basis',
                         dict(kind='PATIENT_CONSENT',reference='SYNTHETIC basis <script> literal',obtainedAt=stamp(-2),**changes),user)

    def agreement(self, user='adminonly', **changes):
        body=dict(to='kin-center',kind='CONTRACT',reference='SYNTHETIC agreement',validFrom=stamp(-2))
        body.update(changes)
        row=self.call('POST','/admin/agreements',body,user)
        self.agreements[row['id']]=self.stack.actor(user)
        return row

    def open(self, basis, user='tech', status=201, fixture=None, **changes):
        body=dict(to='kin-center',basisId=basis['id'] if isinstance(basis,dict) else basis); body.update(changes)
        return self.call('POST','/studies/'+(fixture or self.fixture).uid+'/transfers',body,user,status)

    def revoke(self, transfer, user='tech', status=201):
        return self.call('POST','/transfers/'+transfer['id']+'/revoke',dict(reason='SYNTHETIC withdraw'),user,status)

    def terminate(self, agreement, status=200):
        return self.call('PATCH','/admin/agreements/'+agreement['id'],dict(status='terminated',reason='SYNTHETIC end'),status=status)

    def revoke_basis(self, basis, status=201):
        return self.call('POST',self.path+'/basis/'+basis['id']+'/revoke',dict(reason='SYNTHETIC revoke'),status=status)

    def snapshot(self):
        uid=literal(self.uid)
        where={'Transfer':f'"studyUid"={uid}','TransferBasis':f'"studyUid"={uid}',
               'ProcessingAgreement': 'id IN ('+','.join(map(literal,self.agreements))+')' if self.agreements else 'false',
               'AuditLog': f'target={uid} OR target IN ('+','.join(map(literal,self.agreements))+')' if self.agreements else f'target={uid}'}
        parts=[literal(t)+f', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb) FROM "{t}" t WHERE {w})' for t,w in where.items()]
        return json.loads(psql('SELECT jsonb_build_object('+','.join(parts)+')::text')[0])

    def unchanged_refusal(self, operation):
        before=self.snapshot(); result=operation(); self.assertEqual(self.snapshot(),before)
        return result

    def study_update(self, changes):
        self.assertIn(self.uid,self.stack.active)
        psql(f'UPDATE "StudyState" SET {changes} WHERE uid={literal(self.uid)}')

    @contextmanager
    def database_lock(self, sql):
        process=subprocess.Popen(['docker','exec','-i','kin-db','psql','-XqAt','-U','kin','-d','kin','-v','ON_ERROR_STOP=1'],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
        try:
            process.stdin.write("BEGIN; SET LOCAL statement_timeout='8s'; "+sql+"; SELECT 'LOCKED';\n");process.stdin.flush()
            while process.stdout.readline().strip()!='LOCKED':
                if process.poll() is not None: raise RuntimeError('Owned lock setup failed')
            yield
            process.stdin.write('COMMIT;\n');process.stdin.flush()
        finally:
            try: process.communicate(timeout=10)
            except subprocess.TimeoutExpired: process.kill();process.communicate();raise
            self.assertEqual(process.returncode,0,'Owned lock transaction failed')

    def wait_blocked(self, kind='parent', count=1):
        needle='FROM "StudyState"' if kind=='parent' else 'pg_advisory_xact_lock'
        deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            sql="SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE "+literal('%'+needle+'%')+' AND pid<>pg_backend_pid()'
            if int(psql(sql)[0])>=count:return
            time.sleep(.03)
        self.fail('API did not observably wait on '+kind+' lock')

    @contextmanager
    def audit_fault(self, action):
        name='connect_fault_'+uuid.uuid4().hex
        actors=','.join(map(literal,self.stack.actors.values()))
        psql(f'''CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.actor IN ({actors}) AND NEW.action={literal(action)} THEN
            RAISE EXCEPTION 'SYNTHETIC Connect audit fault'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER {name} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION {name}();''')
        try:yield
        finally:psql(f'DROP TRIGGER {name} ON "AuditLog"; DROP FUNCTION {name}();')

    def test_01_roles_owner_and_all_routes(self):
        basis=self.basis(); agreement=self.agreement(); transfer=self.open(basis)
        routes=[('GET','/admin/agreements',None),('POST','/admin/agreements',dict(to='kin-center',kind='CONTRACT',reference='SYNTHETIC',validFrom=stamp(-1))),
                ('PATCH','/admin/agreements/'+agreement['id'],dict(status='terminated',reason='reason')),
                ('GET',self.path+'/basis',None),('POST',self.path+'/basis',dict(kind='LEGAL_BASIS',reference='SYNTHETIC',obtainedAt=stamp(-1))),
                ('POST',self.path+'/basis/'+basis['id']+'/revoke',dict(reason='reason')),
                ('POST',self.path+'/transfers',dict(to='kin-center',basisId=basis['id'])),
                ('GET','/transfers',None),('POST','/transfers/'+transfer['id']+'/revoke',dict(reason='reason'))]
        before=self.snapshot()
        for method,path,body in routes:
            with self.subTest(method=method,path=path):
                self.call(method,path,body,None,401)
                gateway=self.stack.bearer_request(method,path,self.gateway,body)
                self.assertEqual(gateway.status,403,gateway.text)
                if path=='/transfers':
                    self.assertTrue(any(r['id']==transfer['id'] for r in self.call(method,path,user='doctor')['items']))
                else:self.call(method,path,body,'doctor',403)
                if '/basis' in path or '/agreements' in path:self.call(method,path,body,'tech',403)
        self.assertEqual(self.snapshot(),before)
        self.revoke(transfer,user='adminonly')
        self.open(basis,user='adminonly')

    def test_02_foreign_tele_missing_and_actor_binding(self):
        basis=self.basis();agreement=self.agreement();transfer=self.open(basis)
        other=self.fixture_for(); foreign=self.fixture_for('KIN 판독센터')
        expected=self.call('GET','/studies/2.25.0/basis',status=404)
        self.assertEqual(self.call('GET',self.path+'/basis',user='kadmin',status=404),expected)
        self.assertEqual(self.call('GET','/studies/'+foreign.uid+'/basis',status=404),expected)
        self.study_update('"teleInstitutionId"=\'kin-center\'')
        self.call('GET',self.path+'/basis',user='kadmin',status=404)
        self.call('POST',self.path+'/transfers',dict(to='hallym',basisId=basis['id']),'kadmin',404)
        self.call('POST','/studies/'+other.uid+'/basis/'+basis['id']+'/revoke',dict(reason='x'),status=404)
        for path in ['/admin/agreements/'+agreement['id'],'/admin/agreements/'+str(uuid.uuid4())]:
            self.call('PATCH',path,dict(status='terminated',reason='x'),'kadmin',404)
        for id in [transfer['id'],str(uuid.uuid4())]:
            self.call('POST','/transfers/'+id+'/revoke',dict(reason='x'),'kadmin',404)
        self.assertEqual(self.call('GET','/admin/agreements',user='kadmin')['items'],[])
        self.assertEqual(self.call('GET','/transfers',user='kdoctor')['items'],[])
        self.assertEqual(basis['recordedBy'],self.stack.actor('adminonly'))
        self.assertEqual(transfer['requestedBy'],self.stack.actor('tech'))
        self.assertEqual(basis['institutionId'],'hallym')

    def test_03_input_dates_ids_fields_and_no_store(self):
        basis=self.basis();agreement=self.agreement();transfer=self.open(basis)
        valid=dict(kind='PATIENT_CONSENT',reference='SYNTHETIC',obtainedAt=stamp(-2))
        before=self.snapshot()
        for changes in [dict(kind='invented'),dict(reference=' '),dict(reference='x'*1001),dict(reference='a\x00b'),
                        dict(obtainedAt=stamp(1)),dict(obtainedAt='2026-02-30T00:00:00Z'),dict(obtainedAt='2026-01-01'),
                        dict(expiresAt=stamp(-3)),dict(recordedBy='forged'),dict(institutionId='kin-center')]:
            self.call('POST',self.path+'/basis',{**valid,**changes},status=400)
        agreement_body=dict(to='kin-center',kind='CONTRACT',reference='SYNTHETIC',validFrom=stamp(-2))
        for changes in [dict(to='hallym'),dict(to='missing'),dict(kind='CONSENT'),dict(reference=''),dict(validTo=stamp(-3)),dict(fromInstitutionId='kin-center')]:
            self.call('POST','/admin/agreements',{**agreement_body,**changes},status=400)
        for changes in [dict(sourcePatientKey='forged'),dict(status='ACCEPTED'),dict(basisId='invalid'),dict(to='hallym'),dict(to='missing')]:
            self.call('POST',self.path+'/transfers',dict(dict(to='kin-center',basisId=basis['id']),**changes),'tech',400)
        for path in [self.path+'/basis/'+basis['id']+'/revoke','/transfers/'+transfer['id']+'/revoke']:
            for body in [{},dict(reason=' '),dict(reason='x',actor='forged')]:self.call('POST',path,body,status=400)
        self.call('PATCH','/admin/agreements/'+agreement['id'],dict(status='active',reason='x'),status=400)
        for path in [self.path+'/basis/invalid/revoke','/transfers/invalid/revoke']:
            self.call('POST',path,dict(reason='x'),status=400)
        for query in ['?limit=0','?limit=101','?limit=01','?cursor=invalid','?limit=1&limit=2','?unknown=x','?dir=in']:
            self.call('GET','/transfers'+query,status=400)
        self.assertEqual(self.snapshot(),before)
        # Check the real HTTP response headers, including authentication and parser errors.
        probes=[('/transfers','GET',None,True),('/transfers','GET',None,False),('/transfers?limit=101','GET',None,True)]
        probes += [(path,method,b'{bad',True) for method,path in [
            ('POST','/admin/agreements'),('PATCH','/admin/agreements/'+agreement['id']),
            ('POST',self.path+'/basis'),('POST',self.path+'/basis/'+basis['id']+'/revoke'),
            ('POST',self.path+'/transfers'),('POST','/transfers/'+transfer['id']+'/revoke')]]
        for path,method,data,auth in probes:
            headers={'Content-Type':'application/json'}
            if auth:headers['Authorization']='Bearer '+self.stack.token('adminonly')
            try:response=self.stack._open(Request(self.stack.api+path,data=data,headers=headers,method=method))
            except HTTPError as error:response=error
            with response:self.assertEqual(response.headers.get('Cache-Control'),'no-store',(method,path,response.status))

    def test_04_missing_revoked_future_and_expired_basis(self):
        self.agreement()
        for basis in [None,'',str(uuid.uuid4())]:
            result=self.unchanged_refusal(lambda:self.open(basis,status=403));self.assertEqual(result['code'],'BASIS_MISSING')
        other=self.fixture_for();different=self.basis(other)
        self.unchanged_refusal(lambda:self.open(different,status=403))
        expired=self.basis(expiresAt=stamp(-1))
        self.assertEqual(self.unchanged_refusal(lambda:self.open(expired,status=403))['code'],'BASIS_EXPIRED')
        revoked=self.basis();self.revoke_basis(revoked)
        self.assertEqual(self.unchanged_refusal(lambda:self.open(revoked,status=403))['code'],'BASIS_REVOKED')
        future=self.basis()
        psql('UPDATE "TransferBasis" SET "obtainedAt"=CURRENT_TIMESTAMP+interval \'1 day\' WHERE id='+literal(future['id']))
        self.assertEqual(self.unchanged_refusal(lambda:self.open(future,status=403))['code'],'BASIS_NOT_YET_VALID')

    def test_05_missing_future_expired_terminated_agreement(self):
        basis=self.basis()
        self.assertEqual(self.unchanged_refusal(lambda:self.open(basis,status=403))['code'],'AGREEMENT_MISSING')
        future=self.agreement(validFrom=stamp(1))
        self.assertEqual(self.unchanged_refusal(lambda:self.open(basis,status=403))['code'],'AGREEMENT_INACTIVE')
        self.terminate(future)
        self.agreement(validFrom=stamp(-3),validTo=stamp(-1))
        self.assertEqual(self.unchanged_refusal(lambda:self.open(basis,status=403))['code'],'AGREEMENT_INACTIVE')
        active=self.agreement();self.terminate(active)
        self.assertEqual(self.unchanged_refusal(lambda:self.open(basis,status=403))['code'],'AGREEMENT_INACTIVE')
        replacement=self.agreement();transfer=self.open(basis)
        self.assertEqual(transfer['agreementId'],replacement['id'])

    def test_06_original_identity_report_draft_lock_and_open_not_grant(self):
        self.call('POST',self.path+'/report/commit',dict(action='approve',baseVersion=0,findings=self.fixture.secret,conclusion='approved',recommendation=''),'doctor')
        self.call('PUT',self.path+'/report',dict(findings='SYNTHETIC private draft',conclusion='',recommendation=''),'doctor')
        original={t:rows(t,'uid='+literal(self.uid)) for t in ['StudyState','Report','ReportDraft','ReportVersion']}
        basis=self.basis();agreement=self.agreement();transfer=self.open(basis)
        self.assertEqual(transfer['sourcePatientKey'],'hallym|'+self.fixture.patient_id)
        delta=datetime.fromisoformat(transfer['expiresAt'].replace('Z','+00:00'))-datetime.fromisoformat(transfer['requestedAt'].replace('Z','+00:00'))
        self.assertEqual(delta,timedelta(days=30));self.assertEqual(transfer['status'],'OPEN')
        self.call('GET',self.path+'/report/versions',user='doctor')
        for user in ['kdoctor','kadmin']:
            self.call('GET',self.path+'/report/versions',user=user,status=404)
            self.call('GET',self.path+'/viewer-items',user=user,status=403)
            self.assertEqual(self.stack.dicom_request('/dicom-web/studies/'+self.uid+'/metadata',user).status,403)
        self.revoke(transfer)
        self.assertEqual({t:rows(t,'uid='+literal(self.uid)) for t in original},original)
        audit=self.snapshot()['AuditLog']
        details=' '.join(str(r['detail']) for r in audit if r['action'].startswith(('basis.','agreement.','transfer.')))
        for forbidden in [basis['reference'],agreement['reference'],self.fixture.patient_id,self.fixture.secret]:self.assertNotIn(forbidden,details)
        self.assertEqual(sum(r['action']=='transfer.open' for r in audit),1)

    def test_07_every_audit_failure_rolls_back_all_effects(self):
        basis=self.basis();agreement=self.agreement();transfer=self.open(basis)
        attempts=[('basis.record',lambda:self.call('POST',self.path+'/basis',dict(kind='LEGAL_BASIS',reference='SYNTHETIC fault',obtainedAt=stamp(-1)),status=500)),
                  ('agreement.record',lambda:self.call('POST','/admin/agreements',dict(to='kin-center',kind='CONTRACT',reference='SYNTHETIC fault',validFrom=stamp(-1)),status=500)),
                  ('basis.revoke',lambda:self.revoke_basis(basis,status=500)),
                  ('agreement.terminate',lambda:self.terminate(agreement,status=500)),
                  ('transfer.revoke',lambda:self.revoke(transfer,status=500)),
                  ('transfer.revoke',lambda:self.revoke_basis(basis,status=500)),
                  ('transfer.revoke',lambda:self.terminate(agreement,status=500))]
        for action,operation in attempts:
            with self.subTest(action=action),self.audit_fault(action):self.unchanged_refusal(operation)
        self.revoke(transfer)
        with self.audit_fault('transfer.open'):self.unchanged_refusal(lambda:self.open(basis,status=500))
        self.assertEqual(len(rows('ProcessingAgreement','"recordedBy"='+literal(self.stack.actor('adminonly')))),1)

    def test_08_concurrent_duplicate_and_evidence_revocation_orders(self):
        basis=self.basis();agreement=self.agreement()
        with ThreadPoolExecutor(2) as pool:
            futures=[pool.submit(self.stack.request,'POST',self.path+'/transfers','tech',dict(to='kin-center',basisId=basis['id'])) for _ in range(2)]
            results=[f.result() for f in futures]
        self.assertEqual(sorted(r.status for r in results),[201,409])
        self.assertEqual(sum(r['action']=='transfer.open' for r in self.snapshot()['AuditLog']),1)
        self.revoke(next(r.body for r in results if r.status==201))
        # Hold the same sender lock and observe the DB wait queue, exercising
        # both serial orders instead of relying on whichever request wins a race.
        for kind in ['basis','agreement']:
            for revoke_first in [True,False]:
                current_basis=self.basis();current_agreement=self.agreement()
                open_args=('POST',self.path+'/transfers','tech',dict(to='kin-center',basisId=current_basis['id']))
                close_args=('POST',self.path+'/basis/'+current_basis['id']+'/revoke','adminonly',dict(reason='SYNTHETIC concurrent')) if kind=='basis' else ('PATCH','/admin/agreements/'+current_agreement['id'],'adminonly',dict(status='terminated',reason='SYNTHETIC concurrent'))
                # Earlier active contracts must not let an open after termination
                # pick a different valid agreement in this serial-order fixture.
                for row in rows('ProcessingAgreement','"recordedBy"='+literal(self.stack.actor('adminonly'))+" AND status='active'"):
                    if row['id']!=current_agreement['id']:self.terminate(row)
                args=[close_args,open_args] if revoke_first else [open_args,close_args]
                with ThreadPoolExecutor(2) as pool:
                    with self.database_lock("SELECT pg_advisory_xact_lock(hashtextextended('connect:hallym',0))"):
                        first=pool.submit(self.stack.request,*args[0]);self.wait_blocked('sender',1)
                        second=pool.submit(self.stack.request,*args[1]);self.wait_blocked('sender',2)
                    result=[first.result(),second.result()]
                self.assertEqual([r.status for r in result],([201 if kind=='basis' else 200,403] if revoke_first else [201,201 if kind=='basis' else 200]),[r.text for r in result])
                active=rows('Transfer','"studyUid"='+literal(self.uid)+" AND status IN ('OPEN','ACCEPTED')")
                self.assertEqual(active,[])
                if not revoke_first:
                    tid=result[0].body['id']; row=rows('Transfer','id='+literal(tid))[0]
                    self.assertEqual(row['status'],'REVOKED')
                    audits=[r for r in self.snapshot()['AuditLog'] if json.loads(r['detail'] or '{}').get('transferId')==tid]
                    self.assertEqual(sorted(r['action'] for r in audits),['transfer.open','transfer.revoke'])

    def test_09_parent_ownership_preliminary_and_lock_timeout(self):
        basis=self.basis();self.agreement();body=dict(to='kin-center',basisId=basis['id'])
        with ThreadPoolExecutor(1) as pool:
            for changes,status in [('"institutionId"=\'kin-center\'',404),("rs='P', \"preDoc\"='SYNTHETIC-author', \"preReviewer\"='SYNTHETIC-reviewer'",403)]:
                before=self.snapshot()
                with self.database_lock('UPDATE "StudyState" SET '+changes+' WHERE uid='+literal(self.uid)):
                    pending=pool.submit(self.stack.request,'POST',self.path+'/transfers','tech',body);self.wait_blocked()
                response=pending.result();self.assertEqual(response.status,status,response.text)
                self.assertEqual(self.snapshot(),before)
                self.study_update('"institutionId"=\'hallym\', rs=\'N\', "preDoc"=NULL, "preReviewer"=NULL')
            before=self.snapshot()
            with self.database_lock('SELECT uid FROM "StudyState" WHERE uid='+literal(self.uid)+' FOR UPDATE'):
                pending=pool.submit(self.stack.request,'POST',self.path+'/transfers','tech',body);self.wait_blocked()
                result=pending.result(timeout=7)
                self.assertEqual(result.status,503,result.text);self.assertEqual(result.body['code'],'CONNECT_BUSY')
            self.assertEqual(self.snapshot(),before)

    def test_10_bounded_cursor_outgoing_and_scope(self):
        basis=self.basis();agreement=self.agreement();transfer=self.open(basis)
        # Seed owned history cheaply while preserving source identity and actor;
        # HTTP reads still exercise actual limits, cursors and sender isolation.
        psql('INSERT INTO "Transfer" SELECT (jsonb_populate_record(NULL::"Transfer",to_jsonb(t)||jsonb_build_object(\'id\',md5(t.id::text||g::text)::uuid,\'status\',\'REVOKED\'))).* FROM "Transfer" t CROSS JOIN generate_series(1,104) g WHERE t.id='+literal(transfer['id']))
        all_ids=sorted(r['id'] for r in rows('Transfer','"studyUid"='+literal(self.uid)))
        first=self.call('GET','/transfers?dir=out&limit=100',user='doctor')
        self.assertEqual([r['id'] for r in first['items']],all_ids[:100]);self.assertEqual(first['nextCursor'],all_ids[99])
        second=self.call('GET','/transfers?dir=out&limit=100&cursor='+first['nextCursor'],user='tech')
        self.assertEqual([r['id'] for r in second['items']],all_ids[100:]);self.assertIsNone(second['nextCursor'])
        self.assertEqual(len(self.call('GET','/transfers')['items']),50)
        self.assertEqual(self.call('GET','/transfers?cursor='+all_ids[0],user='kdoctor')['items'],[])
        second_basis=self.basis();basis_ids=sorted([basis['id'],second_basis['id']])
        page=self.call('GET',self.path+'/basis?limit=1');self.assertEqual(page['nextCursor'],basis_ids[0])
        self.assertEqual(self.call('GET',self.path+'/basis?cursor='+page['nextCursor'])['items'][0]['id'],basis_ids[1])
        second_agreement=self.agreement();agreement_ids=sorted([agreement['id'],second_agreement['id']])
        page=self.call('GET','/admin/agreements?limit=1');self.assertEqual(page['nextCursor'],agreement_ids[0])
        self.assertEqual(self.call('GET','/admin/agreements?cursor='+page['nextCursor'])['items'][0]['id'],agreement_ids[1])

    def test_11_expiry_reopen_atomicity_and_terminal_revoke(self):
        basis=self.basis();self.agreement();old=self.open(basis)
        psql('UPDATE "Transfer" SET "requestedAt"=CURRENT_TIMESTAMP-interval \'31 days\',"expiresAt"=CURRENT_TIMESTAMP-interval \'1 day\' WHERE id='+literal(old['id']))
        before=self.snapshot()
        self.assertEqual(self.call('GET','/transfers')['items'][0]['status'],'EXPIRED')
        self.assertEqual(self.snapshot(),before)
        for action in ['transfer.expire','transfer.open']:
            with self.audit_fault(action):self.unchanged_refusal(lambda:self.open(basis,status=500))
        new=self.open(basis);self.assertNotEqual(old['id'],new['id'])
        oldrow=rows('Transfer','id='+literal(old['id']))[0]
        self.assertEqual(oldrow['status'],'EXPIRED');self.assertEqual(oldrow['decisionReason'],'OPEN_EXPIRED')
        self.unchanged_refusal(lambda:self.revoke(old,status=409))
        self.revoke(new);self.unchanged_refusal(lambda:self.revoke(new,status=409))
        self.revoke_basis(basis);self.unchanged_refusal(lambda:self.revoke_basis(basis,status=409))
        actions=[r['action'] for r in self.snapshot()['AuditLog']]
        self.assertEqual(actions.count('transfer.expire'),1)
        self.assertEqual(actions.count('transfer.open'),2)

    def test_12_database_constraints_and_restrict(self):
        basis=self.basis();agreement=self.agreement();transfer=self.open(basis)
        def reject(sql,code):
            before=self.snapshot()
            psql(f'DO $$ BEGIN {sql}; RAISE EXCEPTION \'Constraint missing\'; EXCEPTION WHEN SQLSTATE {literal(code)} THEN NULL; END $$;')
            self.assertEqual(self.snapshot(),before)
        for table,row,change,code in [
            ('TransferBasis',basis,"kind='invalid'",'23514'),('TransferBasis',basis,"reference=' '",'23514'),
            ('TransferBasis',basis,'"expiresAt"="obtainedAt"','23514'),('TransferBasis',basis,'"revokedAt"=CURRENT_TIMESTAMP','23514'),
            ('TransferBasis',basis,'"studyUid"=\'2.25.0\'','23503'),
            ('ProcessingAgreement',agreement,"kind='invalid'",'23514'),('ProcessingAgreement',agreement,"status='terminated'",'23514'),
            ('ProcessingAgreement',agreement,'"toInstitutionId"="fromInstitutionId"','23514'),('ProcessingAgreement',agreement,'"validTo"="validFrom"','23514'),
            ('Transfer',transfer,"status='invalid'",'23514'),('Transfer',transfer,'"toInstitutionId"="fromInstitutionId"','23514'),
            ('Transfer',transfer,'"expiresAt"="requestedAt"','23514'),('Transfer',transfer,"\"sourcePatientKey\"=''",'23514'),
            ('Transfer',transfer,'"basisId"='+literal(str(uuid.uuid4())),'23503'),('Transfer',transfer,'"agreementId"='+literal(str(uuid.uuid4())),'23503')]:
            with self.subTest(table=table,change=change):reject(f'UPDATE "{table}" SET {change} WHERE id='+literal(row['id']),code)
        for table,row in [('TransferBasis',basis),('ProcessingAgreement',agreement)]:reject(f'DELETE FROM "{table}" WHERE id='+literal(row['id']),'23503')
        reject('DELETE FROM "StudyState" WHERE uid='+literal(self.uid),'23503')
        for status in ['OPEN','ACCEPTED']:
            reject('INSERT INTO "Transfer" SELECT (jsonb_populate_record(NULL::"Transfer",to_jsonb(t)||jsonb_build_object(\'id\','+literal(str(uuid.uuid4()))+',\'status\','+literal(status)+'))).* FROM "Transfer" t WHERE id='+literal(transfer['id']),'23505')


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    unittest.main(verbosity=2)
