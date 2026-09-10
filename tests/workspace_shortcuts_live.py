"""Account shortcut identity, input boundaries and atomic revision conflicts."""
import unittest,json,subprocess
from concurrent.futures import ThreadPoolExecutor
from invariants_live import LiveStack
from workspace_roaming_support import cleanup_workspace

DEFAULTS=dict(list='Digit1',image='Digit2',prior='Digit3',report='Digit4',context='Digit5',note='Digit6',tools='Digit7',nativeTools='Digit9',previous='ArrowLeft',next='ArrowRight')
class ShortcutAccountLive(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.stack=LiveStack();cls.addClassCleanup(cls.stack.cleanup_test_identities);cls.stack.require_stack();cls.addClassCleanup(cleanup_workspace,cls.stack,'WorkspaceShortcuts')
 def tearDown(self):cleanup_workspace(self.stack,'WorkspaceShortcuts')
 def get(self,actor='doctor'):
  r=self.stack.request('GET','/workspace-shortcuts',actor);self.assertEqual(r.status,200,r.text);return r.body
 def body(self,actor='doctor'):
  h=self.get(actor);return dict(expectedOwner=h['owner'],revision=h['revision'],bindings=dict(DEFAULTS,report='KeyR'))
 def put(self,b,actor='doctor'):return self.stack.request('PUT','/workspace-shortcuts',actor,b)
 def test_01_roundtrip_stale_and_new_revision(self):
  self.assertEqual(self.get()['revision'],0);self.assertIsNone(self.get()['bindings']);b=self.body();r=self.put(b);self.assertEqual(r.status,200,r.text);self.assertEqual(r.body['bindings'],b['bindings'])
  self.assertEqual(self.put(b).status,409);b.update(revision=1,bindings=DEFAULTS);self.assertEqual(self.put(b).status,200);self.assertEqual(self.get()['revision'],2);self.assertEqual(self.get()['bindings'],DEFAULTS)
 def test_02_account_and_institution_isolation(self):
  b=self.body();self.assertEqual(self.put(b).status,200);saved=self.get()
  for actor in ['doctor2','kdoctor','tech','ktech']:
   self.assertIsNone(self.get(actor)['bindings']);self.assertEqual(self.put(b,actor).status,409);self.assertEqual(self.put(self.body(actor),actor).status,200);self.assertEqual(self.get(),saved)
 def test_03_reject_invalid_without_mutation(self):
  b=self.body();self.assertEqual(self.put(b).status,200);saved=self.get();b['revision']=1
  invalid=[dict(b,bindings=v) for v in [None,[],{},dict(DEFAULTS,report='Digit2'),dict(DEFAULTS,report='KeyC'),dict(DEFAULTS,report='Digit8'),dict(DEFAULTS,report='F5'),dict(DEFAULTS,report=True),dict(DEFAULTS,patient='forbidden'),dict(DEFAULTS,report='X'*10000)]]
  invalid += [dict(b,revision=v) for v in [True,-1,2147483647]]+[dict(b,extra='no'),{}]
  for value in invalid:self.assertEqual(self.put(value).status,400);self.assertEqual(self.get(),saved)
 def test_04_concurrent_create_and_update(self):
  b=self.body()
  with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:self.put(b).status,range(2)))
  self.assertEqual(sorted(results),[200,409]);b['revision']=1
  with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:self.put(b).status,range(2)))
  self.assertEqual(sorted(results),[200,409]);self.assertEqual(self.get()['revision'],2)
 def test_05_invalid_stored_bindings_can_be_replaced(self):
  b=self.body();self.assertEqual(self.put(b).status,200);institution,subject=b['expectedOwner'];self.assertIn(subject,self.stack.user_ids.values())
  quote=lambda value:"'"+value.replace("'","''")+"'"
  sql='UPDATE "WorkspaceShortcuts" SET bindings='+quote('{}')+'::jsonb WHERE institution='+quote(institution)+' AND subject='+quote(subject)+' AND revision=1 RETURNING revision'
  result=subprocess.check_output(['docker','exec','kin-db','psql','-XqAt','-v','ON_ERROR_STOP=1','-U','kin','-d','kin','-c',sql]).decode().strip();self.assertEqual(result,'1')
  head=self.get();self.assertTrue(head['invalid']);self.assertIsNone(head['bindings']);self.assertEqual(head['revision'],1)
  b['revision']=1;self.assertEqual(self.put(b).status,200);self.assertFalse(self.get()['invalid']);self.assertEqual(self.get()['bindings'],b['bindings'])
 def test_06_client_server_acceptance_agrees(self):
  js="const s=require('./worklist-v0/hpacs-lite/workspace-shortcuts.js');console.log(JSON.stringify(['KeyR','KeyC','Digit8','ArrowLeft','KeyZ','KeyAA','Digit0','F5'].map(report=>{const bindings={...s.defaults,report};return {bindings,valid:s.valid(bindings)}})))"
  cases=json.loads(subprocess.check_output(['node','-e',js]));saved=self.get()
  for case in cases:
   body=dict(expectedOwner=saved['owner'],revision=saved['revision'],bindings=case['bindings']);response=self.put(body);self.assertEqual(response.status,200 if case['valid'] else 400,case)
   if case['valid']:saved=response.body
   else:self.assertEqual(self.get(),saved)
if __name__=='__main__':unittest.main(verbosity=2)
