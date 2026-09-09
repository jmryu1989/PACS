"""REQ-D01-PAGE-TRANSFER -> RISK-TENANT-LEAK/STALE-REPORT -> TEST-D01-PAGE-TRANSFER."""
import unittest
from urllib.parse import quote
from invariants_live import LiveInvariantTests

class StudyPagesLive(LiveInvariantTests):
    def page(self,actor='doctor',after=None,limit=1):
        return self.stack.request('GET','/studies?limit='+str(limit)+('&after='+quote(after,safe='') if after else ''),actor)
    def collect(self,actor='doctor'):
        result=[];after=None
        for _ in range(100):
            response=self.page(actor,after);self.assert_status(response,200);body=response.body
            self.assertEqual(body['pagination']['offset'],len(result));result.extend(body['studies']);after=body['pagination']['next']
            if after is None:
                self.assertEqual(body['pagination']['total'],len(result));return result
        self.fail('pagination did not terminate')
    def test_pages_01_collection_matches_legacy_and_tenant_scope(self):
        with self.stack.fixture() as a,self.stack.fixture('KIN 판독센터') as other:
            self.assert_status(self.commit(a,'doctor','save',0),201)
            for actor in ['doctor','doctor2','jmryu','kdoctor','tech']:
                legacy=self.stack.request('GET','/studies',actor);self.assert_status(legacy,200)
                paged=self.collect(actor)
                self.assertEqual(paged,sorted(legacy.body['studies'],key=lambda s:s['uid']))
                self.assertNotIn(other.uid if actor!='kdoctor' else a.uid,[s['uid'] for s in paged])
            cursor=self.page().body['pagination']['next'];self.assertIsNotNone(cursor)
            for actor in ['doctor2','jmryu','kdoctor']:
                self.assert_status(self.page(actor,cursor),409)
            for token in [cursor+'!',cursor[:-2]+'xx','invalid']:
                self.assert_status(self.page(after=token),409)
            self.assert_status(self.page(after=cursor,limit=2),409)
    def test_pages_02_collection_change_and_invalid_query_rejected(self):
        with self.stack.fixture():
            cursor=self.page().body['pagination']['next'];self.assertIsNotNone(cursor)
            with self.stack.fixture():
                changed=self.page(after=cursor);self.assert_status(changed,409);self.assertEqual(changed.body['code'],'STUDY_LIST_CHANGED')
            for query in ['limit=0','limit=101','limit=01','limit=1&limit=2','after=bad','limit=1&other=x']:
                self.assert_status(self.stack.request('GET','/studies?'+query,'doctor'),400)
    def test_pages_03_preliminary_and_personal_draft_visibility_unchanged(self):
        with self.stack.fixture() as a:
            self.assert_status(self.stack.request('PUT',f'/studies/{a.uid}/report','doctor',{'findings':a.secret+' draft','conclusion':'','recommendation':''}),200)
            first=next(s for s in self.collect() if s['uid']==a.uid)
            second=next(s for s in self.collect('doctor2') if s['uid']==a.uid)
            self.assertIn(a.secret,str(first));self.assertNotIn(a.secret,str(second))
            self.preliminary(a)
            self.assertEqual(next(s for s in self.collect('doctor2') if s['uid']==a.uid)['state'],next(s for s in self.stack.request('GET','/studies','doctor2').body['studies'] if s['uid']==a.uid)['state'])

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(StudyPagesLive(name) for name in loader.getTestCaseNames(StudyPagesLive) if name.startswith('test_pages_'))
if __name__=='__main__':unittest.main(verbosity=2)
