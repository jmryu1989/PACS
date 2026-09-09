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
if __name__=='__main__':unittest.main(verbosity=2)
