"""REQ-D01-READING-PREFERENCES: owner isolation, boolean schema and compare-and-swap."""
import unittest
from invariants_live import LiveStack
from workspace_roaming_support import cleanup_workspace

class ReadingPreferencesLive(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.stack=LiveStack();cls.addClassCleanup(cls.stack.cleanup_test_identities)
  cls.stack.require_stack();cls.addClassCleanup(cleanup_workspace,cls.stack,'ReadingPreferences')
 def tearDown(self):cleanup_workspace(self.stack,'ReadingPreferences')
 def get(self,actor='doctor'):
  r=self.stack.request('GET','/reading-preferences',actor);self.assertEqual(r.status,200,r.text);return r.body
 def write(self,body,actor='doctor'):return self.stack.request('PUT','/reading-preferences',actor,body)
 def body(self,actor='doctor'):
  head=self.get(actor);return dict(expectedOwner=head['owner'],revision=head['revision'],autoNote=True)
 def test_01_roundtrip_conflict_and_off(self):
  head=self.get();self.assertIsNone(head['autoNote']);self.assertEqual(head['revision'],0)
  b=self.body();r=self.write(b);self.assertEqual(r.status,200,r.text);self.assertIs(r.body['autoNote'],True)
  self.assertEqual(self.write(b).status,409);b.update(revision=1,autoNote=False)
  r=self.write(b);self.assertEqual(r.status,200);self.assertIs(self.get()['autoNote'],False);self.assertEqual(self.get()['revision'],2)
 def test_02_owners_do_not_mix(self):
  b=self.body();self.assertEqual(self.write(b).status,200);saved=self.get()
  for actor in ['doctor2','kdoctor','tech','ktech','jmryu']:
   with self.subTest(actor=actor):
    self.assertIsNone(self.get(actor)['autoNote']);self.assertEqual(self.write(b,actor).status,409)
    self.assertEqual(self.write(self.body(actor),actor).status,200);self.assertEqual(self.get(),saved)
 def test_03_bad_values_preserve_saved_preference(self):
  b=self.body();self.assertEqual(self.write(b).status,200);saved=self.get();b['revision']=1
  for field,value in [('autoNote',1),('autoNote','true'),('autoNote',None),('revision',True),('revision',-1),('revision',2147483647),('patient','forbidden')]:
   with self.subTest(field=field,value=value):
    self.assertEqual(self.write(dict(b,**{field:value})).status,400);self.assertEqual(self.get(),saved)
  self.assertEqual(self.stack.request('PUT','/reading-preferences','doctor',{}).status,400)
if __name__=='__main__':unittest.main(verbosity=2)
