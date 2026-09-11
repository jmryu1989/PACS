"""REQ-HP-ACCOUNT: strict personal Hanging Protocol schema, owner isolation and CAS."""
import copy,json,unittest
from invariants_live import LiveStack,psql
from workspace_roaming_support import cleanup_workspace

RID='00000000-0000-4000-8000-000000000801'

class HangingProtocolApiLive(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.stack=LiveStack();cls.addClassCleanup(cls.stack.cleanup_test_identities)
  cls.stack.require_stack();cls.addClassCleanup(cleanup_workspace,cls.stack,'HangingProtocolPreference')
 def tearDown(self):cleanup_workspace(self.stack,'HangingProtocolPreference')
 def get(self,actor='doctor'):
  r=self.stack.request('GET','/hanging-protocols',actor);self.assertEqual(r.status,200,r.text);return r.body
 def put(self,body,actor='doctor'):return self.stack.request('PUT','/hanging-protocols',actor,body)
 def value(self):
  return dict(version=1,activeRuleId=RID,rules=[dict(id=RID,name='Chest CT',enabled=True,
   match=dict(modality='CT',retrieveAE=None,bodyPart='CHEST',description=dict(operator='contains',value='follow up')),
   selectors=[dict(alias='current',role='current',historical=False,modality='CT',retrieveAE=None,bodyPart='CHEST',description=None,laterality=None,order='ascending',occurrence=1),
    dict(alias='prior',role='related',historical=True,modality='CT',retrieveAE='PACS',bodyPart='CHEST',description=dict(operator='equals',value='prior'),laterality='L',order='descending',occurrence=2)],
   layout=dict(rows=1,cols=2,cells=['current','prior']))])
 def body(self,actor='doctor',value=None):
  head=self.get(actor);return dict(expectedOwner=head['owner'],revision=head['revision'],value=self.value() if value is None else value)
 def test_01_create_update_reset_and_aba_conflicts(self):
  head=self.get();self.assertEqual(head,dict(owner=head['owner'],revision=0,value=None));self.assertEqual(set(head['owner']),{'institution','subject'})
  b=self.body();created=self.put(b);self.assertEqual(created.status,200,created.text);self.assertEqual(created.body['revision'],1)
  self.assertEqual(created.body['value'],b['value'])
  self.assertEqual(self.put(b).status,409);updated=copy.deepcopy(created.body['value']);updated['rules'][0]['name']='Chest CT next'
  changed=self.put(dict(expectedOwner=head['owner'],revision=1,value=updated));self.assertEqual(changed.status,200,changed.text);self.assertEqual(changed.body['revision'],2)
  reset=self.put(dict(expectedOwner=head['owner'],revision=2,value=None));self.assertEqual(reset.status,200,reset.text);self.assertEqual(reset.body['revision'],3);self.assertIsNone(reset.body['value'])
  self.assertEqual(self.put(dict(expectedOwner=head['owner'],revision=2,value=updated)).status,409)
 def test_02_subject_institution_and_stale_session_are_isolated(self):
  b=self.body();self.assertEqual(self.put(b).status,200);saved=self.get()
  for actor in ('doctor2','kdoctor','tech','ktech','jmryu'):
   with self.subTest(actor=actor):
    other=self.get(actor);self.assertEqual(other['revision'],0);self.assertIsNone(other['value']);self.assertNotEqual(other['owner'],saved['owner'])
    self.assertEqual(self.put(b,actor).status,409);self.assertEqual(self.put(dict(expectedOwner=other['owner'],revision=0,value=dict(version=1,activeRuleId=None,rules=[])),actor).status,200);self.assertEqual(self.get(),saved)
 def test_03_strict_invalid_matrix_is_atomic(self):
  b=self.body();self.assertEqual(self.put(b).status,200);saved=self.get();b['revision']=1
  rule=b['value']['rules'][0]
  invalid=[{},dict(b,extra=True),dict(b,revision=True),dict(b,revision=-1),dict(b,revision=2147483647),dict(b,expectedOwner=[saved['owner']['institution'],saved['owner']['subject']]),
   dict(b,value=None,extra=True),dict(b,value={}),dict(b,value=[]),dict(b,value=dict(b['value'],extra=True)),dict(b,value=dict(b['value'],version=2)),dict(b,value=dict(b['value'],activeRuleId='bad')),
   dict(b,value=dict(b['value'],rules=[dict(rule,extra=True)])),dict(b,value=dict(b['value'],rules=[dict(rule,id='bad')])),dict(b,value=dict(b['value'],rules=[rule,dict(rule,id='00000000-0000-4000-8000-000000000802',name='chest ct')])),
   dict(b,value=dict(b['value'],rules=[dict(rule,enabled=1)])),dict(b,value=dict(b['value'],rules=[dict(rule,selectors=[])])),dict(b,value=dict(b['value'],rules=[dict(rule,selectors=[dict(rule['selectors'][0],alias='onclick=run')])])),
   dict(b,value=dict(b['value'],rules=[dict(rule,selectors=[dict(rule['selectors'][0],historical=True)])])),dict(b,value=dict(b['value'],rules=[dict(rule,layout=dict(rows=2,cols=1,cells=['current',None]))])),
   dict(b,value=dict(b['value'],rules=[dict(rule,layout=dict(rows=1,cols=2,cells=['missing',None]))])),dict(b,value=dict(b['value'],rules=[dict(rule,layout=dict(rows=1,cols=2,cells=['prior','prior']))])),
   dict(b,value=dict(b['value'],rules=[dict(rule,match=dict(rule['match'],modality='ct'))])),dict(b,value=dict(b['value'],rules=[dict(rule,match=dict(rule['match'],modality=' CT'))])),dict(b,value=dict(b['value'],rules=[dict(rule,match=dict(rule['match'],modality='X'*17))])),dict(b,value=dict(b['value'],rules=[dict(rule,match=dict(rule['match'],description=dict(operator='regex',value='x')))])),
   dict(b,value=dict(b['value'],rules=[dict(rule,selectors=[dict(rule['selectors'][0],occurrence=0)])])),dict(b,value=dict(b['value'],rules=[dict(rule,selectors=[dict(rule['selectors'][0],laterality='LEFT')])])),
   dict(b,value=dict(b['value'],rules=[dict(rule,layout=dict(rows=1,cols=2,cells=['current']))])),dict(b,value=dict(version=1,activeRuleId=RID,rules=[])),dict(b,value=dict(b['value'],rules=[])),
   dict(b,value={'version':1,'activeRuleId':None,'rules':[],'__proto__':{}}),dict(b,value=dict(version=1,activeRuleId=None,rules=[] ,pad='한'*65537))]
  for value in invalid:
   with self.subTest(value=str(value)[:160]):self.assertEqual(self.put(value).status,400);self.assertEqual(self.get(),saved)
 def test_04_explicit_repeat_empty_library_and_corrupt_row_fail_closed(self):
  value=self.value();value['rules'][0]['layout']['cells']=['current','current'];b=self.body(value=value)
  self.assertEqual(self.put(b).status,200);head=self.get();self.assertEqual(head['value']['rules'][0]['layout']['cells'],['current','current'])
  self.assertEqual(self.put(dict(expectedOwner=head['owner'],revision=1,value=dict(version=1,activeRuleId=None,rules=[]))).status,200)
  subject=head['owner']['subject'].replace("'","''");institution=head['owner']['institution'].replace("'","''")
  self.assertEqual(psql('UPDATE "HangingProtocolPreference" SET value=\'{}\'::jsonb WHERE institution=\''+institution+'\' AND subject=\''+subject+'\' RETURNING 1;'),['1'])
  result=self.stack.request('GET','/hanging-protocols','doctor');self.assertEqual(result.status,503,result.text)

if __name__=='__main__':unittest.main(verbosity=2)
