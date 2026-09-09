"""TEST-TEXT-ROAM-API: numeric shape, owner isolation and atomic revision conflict."""
import unittest
from invariants_live import LiveStack
from workspace_roaming_support import cleanup_workspace

class ReadingAppearanceLive(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.stack=LiveStack();cls.addClassCleanup(cls.stack.cleanup_test_identities)
  cls.stack.require_stack();cls.addClassCleanup(cleanup_workspace,cls.stack,'ReadingAppearance')
 def tearDown(self):cleanup_workspace(self.stack,'ReadingAppearance')
 def get(self,actor='doctor'):
  r=self.stack.request('GET','/reading-appearance',actor);self.assertEqual(r.status,200,r.text);return r.body
 def body(self,actor='doctor'):
  head=self.get(actor);return dict(expectedOwner=head['owner'],revision=head['revision'],sizes=dict(version=1,list=16,current=18,prior=20))
 def write(self,b,actor='doctor'):return self.stack.request('PUT','/reading-appearance',actor,b)
 def test_01_roundtrip_conflict_and_reset(self):
  self.assertEqual(self.get()['revision'],0);self.assertIsNone(self.get()['sizes'])
  b=self.body();r=self.write(b);self.assertEqual(r.status,200,r.text);self.assertEqual(r.body['sizes'],b['sizes'])
  self.assertEqual(self.write(b).status,409);b.update(revision=1,sizes=dict(version=1,list=12,current=12,prior=12))
  self.assertEqual(self.write(b).status,200);self.assertEqual(self.get()['revision'],2);self.assertEqual(self.get()['sizes'],b['sizes'])
  saved=self.get()
  for stale in [1,3]:
   self.assertEqual(self.write(dict(b,revision=stale)).status,409);self.assertEqual(self.get(),saved)
 def test_02_owner_isolation(self):
  b=self.body();self.assertEqual(self.write(b).status,200);saved=self.get()
  for actor in ['doctor2','kdoctor','tech','ktech','jmryu']:
   with self.subTest(actor=actor):
    self.assertIsNone(self.get(actor)['sizes']);self.assertEqual(self.write(b,actor).status,409)
    self.assertEqual(self.write(self.body(actor),actor).status,200);self.assertEqual(self.get(),saved)
 def test_03_invalid_payload_never_changes_saved_value(self):
  b=self.body();self.assertEqual(self.write(b).status,200);saved=self.get();b['revision']=1
  invalid=[dict(b,sizes=v) for v in [None,[],{},dict(b['sizes'],current='18'),dict(b['sizes'],list=True),dict(b['sizes'],prior=21),dict(b['sizes'],patient='forbidden'),dict(b['sizes'],version=2)]]
  invalid += [dict(b,revision=v) for v in [True,-1,2147483647]]+[dict(b,extra='no'),{}]
  for value in invalid:
   with self.subTest(value=value):self.assertEqual(self.write(value).status,400);self.assertEqual(self.get(),saved)
 def test_04_combined_roundtrip_upgrade_and_legacy_refusal(self):
  b=self.body();self.assertEqual(self.write(b).status,200)
  b.update(revision=1,sizes=dict(b['sizes'],version=2,fonts=dict(version=1,list='sans',current='mono',prior='serif'),colors=dict(version=1,list='warm',current='white',prior='cool')))
  r=self.write(b);self.assertEqual(r.status,200,r.text);self.assertEqual(r.body['sizes'],b['sizes']);self.assertEqual(self.get(),r.body)
  self.assertIsNone(self.get('doctor2')['sizes']);self.assertEqual(self.write(b,'doctor2').status,409)
  saved=self.get();legacy=self.body();self.assertEqual(legacy['revision'],2)
  self.assertEqual(self.write(legacy).status,409);self.assertEqual(self.get(),saved)
  self.assertEqual(self.write(b).status,409);b['revision']=2;self.assertEqual(self.write(b).status,200)
 def test_05_combined_invalid_values_are_atomic(self):
  import copy
  b=self.body();b['sizes'].update(version=2,fonts=dict(version=1,list='default',current='serif',prior='mono'),colors=dict(version=1,list='default',current='warm',prior='cool'))
  self.assertEqual(self.write(b).status,200);saved=self.get();b['revision']=1
  for field,bad in [('fonts',None),('fonts',{}),('colors',[]),('colors',dict(version=1,list='white',current='black',prior='cool'))]:
   invalid=copy.deepcopy(b);invalid['sizes'][field]=bad;self.assertEqual(self.write(invalid).status,400);self.assertEqual(self.get(),saved)
  for field in ['fonts','colors']:
   for bad in ['url(https://invalid.example/x)', '__proto__', ['default'], True, None]:
    invalid=copy.deepcopy(b);invalid['sizes'][field]['current']=bad;self.assertEqual(self.write(invalid).status,400);self.assertEqual(self.get(),saved)
   invalid=copy.deepcopy(b);invalid['sizes'][field]['patient']='forbidden';self.assertEqual(self.write(invalid).status,400);self.assertEqual(self.get(),saved)
 def dock_body(self):
  b=self.body();b['sizes'].update(version=3,fonts=dict(version=1,list='sans',current='mono',prior='serif'),colors=dict(version=1,list='warm',current='white',prior='cool'),dock=dict(version=1,placement='top',panel=1));return b
 def test_06_dock_roundtrip_old_writers_and_conflict(self):
  b=self.dock_body();r=self.write(b);self.assertEqual(r.status,200,r.text);self.assertEqual(r.body['sizes'],b['sizes']);saved=self.get()
  for version in [1,2]:
   legacy=self.body();legacy['sizes']['version']=version
   if version==2:legacy['sizes'].update(fonts=b['sizes']['fonts'],colors=b['sizes']['colors'])
   self.assertEqual(self.write(legacy).status,409);self.assertEqual(self.get(),saved)
  self.assertEqual(self.write(b).status,409);self.assertEqual(self.write(b,'doctor2').status,409);self.assertIsNone(self.get('doctor2')['sizes'])
  b['revision']=1;b['sizes']['dock']=dict(version=1,placement='bottom',panel=-1);self.assertEqual(self.write(b).status,200);self.assertEqual(self.get()['sizes'],b['sizes'])
 def test_07_invalid_dock_never_partially_updates_text(self):
  import copy
  b=self.dock_body();self.assertEqual(self.write(b).status,200);saved=self.get();b['revision']=1;b['sizes']['current']=12
  for dock in [None,{},[],dict(version=1,placement='left',panel=0),dict(version=1,placement='top',panel=True),dict(version=1,placement='top',panel=2),dict(version=2,placement='top',panel=0),dict(version=1,placement='top',panel=0,uid='forbidden')]:
   invalid=copy.deepcopy(b);invalid['sizes']['dock']=dock;self.assertEqual(self.write(invalid).status,400);self.assertEqual(self.get(),saved)
  invalid=copy.deepcopy(b);del invalid['sizes']['dock'];self.assertEqual(self.write(invalid).status,400);self.assertEqual(self.get(),saved)
  cleanup_workspace(self.stack,'ReadingAppearance');old=self.body();old['sizes'].update(version=2,fonts=b['sizes']['fonts'],colors=b['sizes']['colors']);self.assertEqual(self.write(old).status,200)
  b['revision']=1;self.assertEqual(self.write(b).status,200);self.assertEqual(self.get()['sizes'],b['sizes'])
if __name__=='__main__':unittest.main(verbosity=2)
