"""D02-ROAM actual API identity, revision and strict display-only schema boundaries."""
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

if __name__=='__main__':unittest.main(verbosity=2)
