"""REQ-D01-COLUMNS-ROAM -> RISK-OWNER/LOST-UPDATE/DISPLAY-ONLY -> TEST-D01-COLUMNS-API."""
import copy,json,re,threading,unittest,uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from invariants_live import LiveStack,psql
from workspace_roaming_support import cleanup_workspace

class WorklistColumnsLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stack=LiveStack();cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.stack.require_stack();cls.addClassCleanup(cleanup_workspace,cls.stack,'WorklistColumns')
    def tearDown(self):cleanup_workspace(self.stack,'WorklistColumns')
    def get(self,actor='doctor'):
        r=self.stack.request('GET','/worklist-columns',actor);self.assertEqual(r.status,200,r.text);return r.body
    def body(self,actor='doctor'):
        head=self.get(actor)
        return dict(expectedOwner=head['owner'],revision=head['revision'],columns=dict(version=1,
            modes={mode:dict(order=['name','id','age'],hidden=['age']) for mode in ('Radiology','Technician')}))
    def write(self,body,actor='doctor',method='PUT'):return self.stack.request(method,'/worklist-columns',actor,body)
    def test_01_roundtrip_tombstone_and_layout_isolation(self):
        layout=self.stack.request('GET','/workspace-layout','doctor').body
        self.assertIsNone(self.get()['columns']);body=self.body();r=self.write(body)
        self.assertEqual(r.status,200,r.text);self.assertEqual(r.body['revision'],1)
        for mode in body['columns']['modes']:
            self.assertEqual(r.body['columns']['modes'][mode]['order'][:3],['name','id','age'])
            self.assertEqual(r.body['columns']['modes'][mode]['hidden'],['age'])
        self.assertEqual(self.get(),r.body);self.assertEqual(self.write(body).status,409)
        clear=dict(expectedOwner=body['expectedOwner'],revision=1)
        r=self.write(clear,method='DELETE');self.assertEqual(r.status,200,r.text)
        self.assertIsNone(r.body['columns']);self.assertEqual(r.body['revision'],2)
        self.assertEqual(self.write(body).status,409);self.assertEqual(self.write(clear,method='DELETE').status,409)
        body['revision']=2;self.assertEqual(self.write(body).body['revision'],3)
        self.assertEqual(self.stack.request('GET','/workspace-layout','doctor').body,layout)
    def test_02_owner_institution_roles(self):
        body=self.body();self.assertEqual(self.write(body).status,200);original=self.get()
        for actor in ['doctor2','kdoctor','tech','ktech','jmryu']:
            with self.subTest(actor=actor):
                own=self.get(actor);self.assertNotEqual(own['owner'],original['owner']);self.assertIsNone(own['columns'])
                self.assertEqual(self.write(body,actor).status,409)
                self.assertEqual(self.write(dict(expectedOwner=body['expectedOwner'],revision=1),actor,'DELETE').status,409)
                self.assertEqual(self.write(self.body(actor),actor).status,200);self.assertEqual(self.get(),original)
        self.assertNotEqual(self.get('kdoctor')['owner'][0],original['owner'][0])
    def test_03_strict_payload_preserves_original(self):
        body=self.body();self.assertEqual(self.write(body).status,200);body['revision']=1;original=self.get();bad=[]
        for field,value in [('version',2),('patient','forbidden'),('modes',[]),('modes',{})]:
            b=copy.deepcopy(body);b['columns'][field]=value;bad.append(b)
        for field,value in [('hidden',['id']),('hidden',['name']),('hidden',['age','age']),('hidden',['patient-data']),
                            ('order',['__proto__']),('order',['age']*65),('order',None),('hidden',[True]),('extra','data')]:
            b=copy.deepcopy(body);b['columns']['modes']['Radiology'][field]=value;bad.append(b)
        for field,value in [('revision',True),('revision',-1),('revision',1.5),('revision',2147483647),('owner','other')]:
            b=copy.deepcopy(body);b[field]=value;bad.append(b)
        bad.extend([None,[],{},dict(body,columns=None)])
        for b in bad:
            with self.subTest(body=b):self.assertEqual(self.write(b).status,400);self.assertEqual(self.get(),original)
    def test_04_concurrent_create_update_clear(self):
        body=self.body();self.stack.token('doctor')
        def race(items):
            gate=threading.Barrier(2)
            def send(item):gate.wait();return self.write(item[1],method=item[0])
            with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(send,items))
            self.assertEqual(sorted(r.status for r in results),[200,409],[r.text for r in results])
            winner=next(r.body for r in results if r.status==200);self.assertEqual(self.get(),winner);return winner
        winner=race([('PUT',body),('PUT',copy.deepcopy(body))]);body['revision']=winner['revision']
        race([('PUT',body),('DELETE',dict(expectedOwner=body['expectedOwner'],revision=winner['revision']))])
    def test_05_gateway_and_unauthenticated_denied(self):
        body=self.body();token=self.stack.service_token('gateway')
        for method in ['GET','PUT','DELETE']:
            payload=None if method=='GET' else body
            self.assertEqual(self.stack.request(method,'/worklist-columns',body=payload).status,401)
            self.assertEqual(self.stack.bearer_request(method,'/worklist-columns',token,payload).status,403)

    def test_06_server_allowlist_matches_current_browser_columns(self):
        source=(Path(__file__).resolve().parents[1]/'worklist-v0/hpacs-lite/main.html').read_text(encoding='utf-8')
        declaration=source.split('const COLS = {',1)[1].split('\n    };',1)[0]
        body=self.body()
        for mode in body['columns']['modes']:body['columns']['modes'][mode]=dict(order=[],hidden=[])
        result=self.write(body);self.assertEqual(result.status,200,result.text)
        for mode in body['columns']['modes']:
            part=declaration.split(mode+': [',1)[1].split('\n      ],',1)[0]
            self.assertEqual(result.body['columns']['modes'][mode]['order'],re.findall(r'k: "([^"]+)"',part))

    def test_07_applied_database_constraints_rollback_only(self):
        # Dedicated synthetic owner and transaction: no existing preference row
        # is updated even temporarily; exact new-table constraint probes mirror
        # the isolated product restore fixture's three new checks.
        subject=str(uuid.uuid4());institution='SYNTHETIC-columns-constraint'
        where=f"institution='{institution}' AND subject='{subject}'"
        self.assertEqual(psql(f'SELECT count(*) FROM "WorklistColumns" WHERE {where}'),['0'])
        result=psql(f'''BEGIN;
          INSERT INTO "WorklistColumns" (institution,subject,revision,value,"updatedAt")
            VALUES ('{institution}','{subject}',1,NULL,now());
          DO $$ BEGIN
            BEGIN INSERT INTO "WorklistColumns" SELECT * FROM "WorklistColumns" WHERE {where};
              RAISE EXCEPTION 'missing columns owner PK'; EXCEPTION WHEN unique_violation THEN NULL; END;
            BEGIN UPDATE "WorklistColumns" SET revision=0 WHERE {where};
              RAISE EXCEPTION 'missing columns revision constraint'; EXCEPTION WHEN check_violation THEN NULL; END;
            BEGIN UPDATE "WorklistColumns" SET value=repeat('x',8193) WHERE {where};
              RAISE EXCEPTION 'missing columns byte constraint'; EXCEPTION WHEN check_violation THEN NULL; END;
          END $$; ROLLBACK;
          SELECT count(*) FROM "WorklistColumns" WHERE {where};''')
        self.assertEqual(result,['0']);print('Applied PK/revision/byte checks PASS; synthetic transaction rolled back')

if __name__=='__main__':unittest.main(verbosity=2)
