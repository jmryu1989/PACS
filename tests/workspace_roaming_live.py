"""D02-ROAM actual API identity, revision and strict display-only schema boundaries.

REQ-D-WORKSPACE-READING-LAYOUT -> RISK-ROAM-MIX/LOST/SIZE -> TEST-ROAM-API.
"""
import copy,json,unittest,threading
from urllib.parse import urlencode
from urllib.request import Request
from concurrent.futures import ThreadPoolExecutor
from invariants_live import LiveStack
from workspace_roaming_support import cleanup_workspace

class WorkspaceRoamingLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stack=LiveStack();cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.stack.require_stack();cls.addClassCleanup(cleanup_workspace,cls.stack)
    def tearDown(self):cleanup_workspace(self.stack)
    def get(self,actor='doctor'):
        r=self.stack.request('GET','/workspace-layout',actor);self.assertEqual(r.status,200,r.text);return r.body
    def body(self,actor='doctor',state=None):
        head=state or self.get(actor)
        return dict(expectedOwner=head['owner'],revision=head['revision'],layout=dict(version=1,mode='portrait',portrait=dict(main=430,top=270),landscape=dict(main=740)))
    def write(self,body,actor='doctor',method='PUT'):return self.stack.request(method,'/workspace-layout',actor,body)
    def body_v2(self,actor='doctor',state=None):
        body=self.body(actor,state);body['layout']['version']=2
        body['layout']['reading']=dict(version=1,reportWidth=540,imageHeight=390,
            relatedHeight=None,relatedListHeight=180,relatedHidden=False)
        return body

    def test_01_roundtrip_clear_and_stale_revisions(self):
        empty=self.get();self.assertIsNone(empty['layout']);self.assertEqual(empty['revision'],0)
        body=self.body();r=self.write(body);self.assertEqual(r.status,200,r.text)
        self.assertEqual(r.body['layout'],body['layout']);self.assertEqual(r.body['revision'],1)
        self.assertEqual(self.write(body).status,409)
        clear=dict(expectedOwner=body['expectedOwner'],revision=1)
        r=self.write(clear,method='DELETE');self.assertEqual(r.status,200);self.assertIsNone(r.body['layout']);self.assertEqual(r.body['revision'],2)
        self.assertEqual(self.write(body).status,409);self.assertEqual(self.write(clear,method='DELETE').status,409)
        self.assertEqual(self.get(),r.body)
        body['revision']=2;self.assertEqual(self.write(body).body['revision'],3)

    def test_02_real_roles_subjects_and_institutions(self):
        a=self.body();self.assertEqual(self.write(a).status,200);original=self.get()
        for actor in ['doctor2','kdoctor','tech','ktech','jmryu']:
            with self.subTest(actor=actor):
                own=self.get(actor);self.assertIsNone(own['layout']);self.assertNotEqual(own['owner'],original['owner'])
                self.assertEqual(self.write(a,actor).status,409)
                body=self.body(actor);body['layout']['mode']='landscape';self.assertEqual(self.write(body,actor).status,200)
                self.assertEqual(self.get(),original)
        self.assertNotEqual(self.get('kdoctor')['owner'][0],original['owner'][0])

    def test_03_strict_input_and_unchanged_saved_value(self):
        body=self.body();self.assertEqual(self.write(body).status,200);original=self.get();body['revision']=1
        bad=[]
        for field,value in [('version',99),('mode','unknown'),('mode','x'*2100),('patient','not-allowed'),('portrait',[]),('landscape',None)]:
            b=copy.deepcopy(body);b['layout'][field]=value;bad.append(b)
        for value in [-1,0,16385,'200',None,True]:
            b=copy.deepcopy(body);b['layout']['portrait']['main']=value;bad.append(b)
        for field,value in [('owner','other'),('revision',-1),('revision',1.5),('revision',True),('revision',2147483647)]:
            b=copy.deepcopy(body);b[field]=value;bad.append(b)
        for b in bad:
            self.assertEqual(self.write(b).status,400,json.dumps(b));self.assertEqual(self.get(),original)
        b=copy.deepcopy(body);b['layout']['portrait']['main']=431.6
        self.assertEqual(self.write(b).body['layout']['portrait']['main'],432)

    def test_04_concurrent_create_update_and_clear(self):
        self.stack.token('doctor')
        def race(bodies):
            gate=threading.Barrier(2)
            def send(item):gate.wait();return self.write(item[1],method=item[0])
            with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(send,bodies))
            self.assertEqual(sorted(r.status for r in results),[200,409],[r.text for r in results])
            return next(r.body for r in results if r.status==200)
        body=self.body();a=copy.deepcopy(body);a['layout']['mode']='landscape'
        winner=race([('PUT',body),('PUT',a)]);self.assertEqual(self.get(),winner)
        body['revision']=winner['revision'];clear=dict(expectedOwner=body['expectedOwner'],revision=winner['revision'])
        winner=race([('PUT',body),('DELETE',clear)]);self.assertEqual(self.get(),winner)

    def test_05_unauthenticated_gateway_and_pending_denied(self):
        body=self.body()
        for method in ['GET','PUT','DELETE']:
            self.assertEqual(self.stack.request(method,'/workspace-layout',body=body if method!='GET' else None).status,401)
            token=self.stack.service_token('gateway')
            self.assertEqual(self.stack.bearer_request(method,'/workspace-layout',token,body if method!='GET' else None).status,403)
        sub=self.stack.create_test_identity('roam-pending',['radiologist'],'hallym')
        groups=self.stack.kc_admin('GET','/users/'+sub+'/groups').body
        for group in groups:self.assertEqual(self.stack.kc_admin('DELETE','/users/'+sub+'/groups/'+group['id']).status,204)
        data=urlencode(dict(client_id=self.stack.test_client_id,grant_type='password',username=self.stack.username('roam-pending'),password=self.stack.passwords['roam-pending'])).encode()
        with self.stack._open(Request(self.stack.keycloak,data=data,headers={'Content-Type':'application/x-www-form-urlencoded'})) as response:
            token=json.loads(response.read())['access_token']
        for method in ['GET','PUT','DELETE']:
            r=self.stack.bearer_request(method,'/workspace-layout',token,body if method!='GET' else None)
            self.assertEqual(r.status,403,r.text);self.assertEqual(r.body.get('code'),'INSTITUTION_PENDING')

    def test_06_v2_upgrade_roundtrip_and_legacy_load_remains_v1(self):
        legacy=self.body();saved=self.write(legacy);self.assertEqual(saved.status,200,saved.text)
        self.assertEqual(saved.body['layout'],legacy['layout'])
        self.assertEqual(self.get()['layout']['version'],1)
        self.assertNotIn('reading',self.get()['layout'])
        body=self.body_v2(state=saved.body)
        body['layout']['reading'].update(reportWidth=1,imageHeight=16384,relatedHeight=None,
            relatedListHeight=420,relatedHidden=True)
        saved=self.write(body);self.assertEqual(saved.status,200,saved.text)
        self.assertEqual(saved.body['revision'],2)
        self.assertEqual(saved.body['layout'],body['layout']);self.assertEqual(self.get(),saved.body)
        body['revision']=saved.body['revision']
        body['layout']['reading'].update(reportWidth=None,imageHeight=None,relatedListHeight=None,relatedHidden=False)
        body['layout']['portrait']['main']=431.6
        saved=self.write(body);self.assertEqual(saved.status,200,saved.text)
        self.assertEqual(saved.body['layout']['reading'],body['layout']['reading'])
        self.assertEqual(saved.body['layout']['portrait']['main'],432)
        self.assertEqual(self.get(),saved.body)

    def test_07_v2_blocks_current_revision_legacy_writes_until_explicit_clear(self):
        body=self.body_v2();saved=self.write(body);self.assertEqual(saved.status,200,saved.text)
        original=self.get();legacy=self.body(state=original)
        for request in [legacy,body,{**legacy,'revision':0}]:
            with self.subTest(version=request['layout']['version'],revision=request['revision']):
                refused=self.write(request);self.assertEqual(refused.status,409,refused.text)
                self.assertEqual(refused.body.get('code'),'WORKSPACE_CONFLICT')
                self.assertEqual(self.get(),original)
        clear=dict(expectedOwner=original['owner'],revision=original['revision'])
        saved=self.write(clear,method='DELETE');self.assertEqual(saved.status,200,saved.text)
        self.assertIsNone(saved.body['layout']);self.assertEqual(saved.body['revision'],2)
        self.assertEqual(self.write(legacy).status,409)
        legacy['revision']=saved.body['revision']
        saved=self.write(legacy);self.assertEqual(saved.status,200,saved.text)
        self.assertEqual(saved.body['layout'],legacy['layout']);self.assertEqual(saved.body['revision'],3)
        self.assertEqual(self.get(),saved.body)

    def test_08_v2_reading_rejects_non_display_and_incomplete_or_invalid_values(self):
        body=self.body_v2();saved=self.write(body);self.assertEqual(saved.status,200,saved.text)
        original=self.get();body['revision']=original['revision'];bad=[]
        for value in [None,[],False,'reading']:
            b=copy.deepcopy(body);b['layout']['reading']=value;bad.append(b)
        for key in body['layout']['reading']:
            b=copy.deepcopy(body);del b['layout']['reading'][key];bad.append(b)
        for version in [0,2,True,'1']:
            b=copy.deepcopy(body);b['layout']['reading']['version']=version;bad.append(b)
        for key in ['reportWidth','imageHeight','relatedHeight','relatedListHeight']:
            for value in [-1,0,16385,320.5,'320',True,[],{}]:
                b=copy.deepcopy(body);b['layout']['reading'][key]=value;bad.append(b)
        for value in [None,0,1,'false',[],{}]:
            b=copy.deepcopy(body);b['layout']['reading']['relatedHidden']=value;bad.append(b)
        for key,value in [('findings','SYNTHETIC report'),('patient','SYNTHETIC patient'),
                ('uid','SYNTHETIC study'),('camera',{}),('image','SYNTHETIC image')]:
            for scope in ['root','reading']:
                b=copy.deepcopy(body);target=b['layout'] if scope=='root' else b['layout']['reading']
                target[key]=value;bad.append(b)
        b=copy.deepcopy(body);del b['layout']['reading'];bad.append(b)
        b=copy.deepcopy(body);b['layout']['version']=1;bad.append(b)
        b=copy.deepcopy(body);b['layout']['portrait']['reportWidth']=300;bad.append(b)
        for b in bad:
            with self.subTest(layout=b['layout']):
                refused=self.write(b);self.assertEqual(refused.status,400,refused.text)
                self.assertEqual(self.get(),original)

    def test_09_v2_reading_owner_and_institution_isolation(self):
        body=self.body_v2();saved=self.write(body);self.assertEqual(saved.status,200,saved.text)
        original=self.get()
        for index,actor in enumerate(['doctor2','kdoctor','tech']):
            with self.subTest(actor=actor):
                head=self.get(actor);self.assertIsNone(head['layout']);self.assertNotEqual(head['owner'],original['owner'])
                refused=self.write(body,actor);self.assertEqual(refused.status,409,refused.text)
                self.assertEqual(refused.body.get('code'),'WORKSPACE_OWNER_CHANGED')
                clear=dict(expectedOwner=original['owner'],revision=original['revision'])
                self.assertEqual(self.write(clear,actor,method='DELETE').status,409)
                own=self.body_v2(actor,state=head);own['layout']['reading']['reportWidth']=600+index
                result=self.write(own,actor);self.assertEqual(result.status,200,result.text)
                self.assertEqual(self.get(actor)['layout'],own['layout']);self.assertEqual(self.get(),original)

    def test_10_concurrent_v2_upgrade_and_legacy_update_preserve_revision_guard(self):
        legacy=self.body();saved=self.write(legacy);self.assertEqual(saved.status,200,saved.text)
        legacy['revision']=saved.body['revision'];legacy['layout']['portrait']['main']=510
        upgrade=self.body_v2(state=saved.body);gate=threading.Barrier(2)
        def send(body):gate.wait();return self.write(body)
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(send,[legacy,upgrade]))
        self.assertEqual(sorted(result.status for result in results),[200,409],[result.text for result in results])
        winner=next(result.body for result in results if result.status==200)
        self.assertEqual(winner['revision'],2);self.assertEqual(self.get(),winner)
        if winner['layout']['version']==1:
            upgrade['revision']=winner['revision'];saved=self.write(upgrade);self.assertEqual(saved.status,200,saved.text)
            winner=saved.body
        self.assertEqual(winner['layout']['reading'],upgrade['layout']['reading'])
        legacy['revision']=winner['revision'];refused=self.write(legacy)
        self.assertEqual(refused.status,409,refused.text);self.assertEqual(self.get(),winner)

if __name__=='__main__':unittest.main(verbosity=2)
