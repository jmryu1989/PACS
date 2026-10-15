"""Account shortcut identity, input boundaries and atomic revision conflicts."""
import unittest,json,subprocess
from concurrent.futures import ThreadPoolExecutor
from invariants_live import LiveStack,ROOT
from workspace_roaming_support import cleanup_workspace

DEFAULTS=dict(list='Digit1',image='Digit2',prior='Digit3',report='Digit4',context='Digit5',note='Digit6',tools='Digit7',nativeTools='Digit9',previous='ArrowLeft',next='ArrowRight')
DEFAULTS_V2=dict(version=2, **{key:'Control+Alt+'+value for key,value in DEFAULTS.items()}, finalize='Control+KeyS')
class ShortcutAccountLive(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.stack=LiveStack();cls.addClassCleanup(cls.stack.cleanup_test_identities);cls.stack.require_stack();cls.addClassCleanup(cleanup_workspace,cls.stack,'WorkspaceShortcuts')
 def tearDown(self):cleanup_workspace(self.stack,'WorkspaceShortcuts')
 def get(self,actor='doctor'):
  r=self.stack.request('GET','/workspace-shortcuts',actor);self.assertEqual(r.status,200,r.text);return r.body
 def body(self,actor='doctor'):
  h=self.get(actor);return dict(expectedOwner=h['owner'],revision=h['revision'],bindings=dict(DEFAULTS_V2,report='Control+Alt+KeyR'))
 def put(self,b,actor='doctor'):return self.stack.request('PUT','/workspace-shortcuts',actor,b)
 def test_01_roundtrip_stale_and_new_revision(self):
  self.assertEqual(self.get()['revision'],0);self.assertIsNone(self.get()['bindings']);b=self.body();r=self.put(b);self.assertEqual(r.status,200,r.text);self.assertEqual(r.body['bindings'],b['bindings'])
  self.assertEqual(self.put(b).status,409);b.update(revision=1,bindings=DEFAULTS_V2);self.assertEqual(self.put(b).status,200);self.assertEqual(self.get()['revision'],2);self.assertEqual(self.get()['bindings'],DEFAULTS_V2)
 def test_02_account_and_institution_isolation(self):
  b=self.body();self.assertEqual(self.put(b).status,200);saved=self.get()
  for actor in ['doctor2','kdoctor','tech','ktech']:
   self.assertIsNone(self.get(actor)['bindings']);self.assertEqual(self.put(b,actor).status,409);self.assertEqual(self.put(self.body(actor),actor).status,200);self.assertEqual(self.get(),saved)
 def test_03_reject_invalid_without_mutation(self):
  b=self.body();self.assertEqual(self.put(b).status,200);saved=self.get();b['revision']=1
  invalid=[dict(b,bindings=v) for v in [None,[],{},dict(DEFAULTS,report='Digit2'),dict(DEFAULTS,report='KeyC'),dict(DEFAULTS,report='Digit8'),dict(DEFAULTS,report='F5'),dict(DEFAULTS,report=True),dict(DEFAULTS,patient='forbidden'),dict(DEFAULTS,report='X'*10000)]]
  invalid += [dict(b,bindings=v) for v in [dict(DEFAULTS_V2,version=3),dict(DEFAULTS_V2,report='Control+KeyS'),dict(DEFAULTS_V2,report='Control+Alt+KeyC'),dict(DEFAULTS_V2,report='Control+Alt+Digit8'),dict(DEFAULTS_V2,report='KeyR'),dict(DEFAULTS_V2,extra=None)]]
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
  result=subprocess.check_output(['docker','compose','exec','-T','db','psql','-XqAt','-v','ON_ERROR_STOP=1','-U','kin','-d','kin','-c',sql],cwd=ROOT).decode().strip();self.assertEqual(result,'1')
  head=self.get();self.assertTrue(head['invalid']);self.assertIsNone(head['bindings']);self.assertEqual(head['revision'],1)
  b['revision']=1;self.assertEqual(self.put(b).status,200);self.assertFalse(self.get()['invalid']);self.assertEqual(self.get()['bindings'],b['bindings'])
 def test_06_client_server_acceptance_agrees(self):
  # Legacy cases precede the upgrade, so every valid v1 case remains a roundtrip,
  # while the separate current-revision downgrade case below expects 409.
  js="""const s=require('./worklist-v0/hpacs-lite/workspace-shortcuts.js');
  const cases=[
   ...['KeyR','KeyC','Digit8','ArrowLeft','KeyZ','KeyAA','Digit0','F5'].map(report=>({...s.defaults,report})),
   ...['Control+Alt+KeyR','Control+Alt+KeyC','Control+Alt+Digit8','Control+Alt+ArrowLeft','Control+Alt+KeyZ','Control+KeyS',null,'KeyR'].map(report=>({...s.defaultsV2,report}))
  ];console.log(JSON.stringify(cases.map(bindings=>({bindings,valid:s.valid(bindings)}))));"""
  cases=json.loads(subprocess.check_output(['node','-e',js]));saved=self.get()
  for case in cases:
   body=dict(expectedOwner=saved['owner'],revision=saved['revision'],bindings=case['bindings']);response=self.put(body);self.assertEqual(response.status,200 if case['valid'] else 400,case)
   if case['valid']:saved=response.body
   else:self.assertEqual(self.get(),saved)
 def test_07_v1_upgrade_current_revision_downgrade_refused_and_preserved(self):
  b=self.body();b['bindings']=dict(DEFAULTS,report='KeyR')
  legacy=self.put(b);self.assertEqual(legacy.status,200,legacy.text);self.assertEqual(self.get()['bindings'],b['bindings'])
  js="const s=require('./worklist-v0/hpacs-lite/workspace-shortcuts.js');const map=s.migrate(JSON.parse(process.argv[1])).map;console.log(JSON.stringify({map,command:s.action(map,{ctrlKey:true,altKey:false,code:'KeyS'})}))"
  migrated=json.loads(subprocess.check_output(['node','-e',js,json.dumps(b['bindings'])]))
  self.assertEqual(migrated['command'],'finalize')
  for key,value in b['bindings'].items():self.assertEqual(migrated['map'][key],'Control+Alt+'+value)
  upgraded=self.put(dict(b,revision=legacy.body['revision'],bindings=migrated['map']))
  self.assertEqual(upgraded.status,200,upgraded.text);saved=self.get();self.assertEqual(saved,upgraded.body)
  refused=self.put(dict(b,revision=saved['revision']))
  self.assertEqual(refused.status,409,refused.text);self.assertEqual(self.get(),saved)
if __name__=='__main__':unittest.main(verbosity=2)
