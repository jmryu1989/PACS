"""REQ-D01-QUERY-SCOPE API: lean initialization and page permission regressions."""
import json,unittest
from study_pages_live import StudyPagesLive
class StudyQueryScopeLive(StudyPagesLive):
    def test_query_01_lean_bootstrap_omits_only_study_payload(self):
        with self.stack.fixture() as a:
            self.assert_status(self.stack.request('PUT',f'/studies/{a.uid}/report','doctor',{'findings':a.secret+' draft','conclusion':'','recommendation':''}),200)
            for actor in ['doctor','doctor2','tech','kdoctor']:
                full=self.stack.request('GET','/bootstrap',actor);lean=self.stack.request('GET','/bootstrap?states=omit',actor)
                self.assert_status(full,200);self.assert_status(lean,200)
                self.assertEqual(lean.body['states'],{});self.assertTrue(lean.body['statesOmitted'])
                for key in ['me','filters','templates','institutions','orders']:self.assertEqual(full.body[key],lean.body[key])
                self.assertNotIn(a.secret,json.dumps(lean.body));self.assertNotIn('statesOmitted',full.body)
                if actor=='doctor':self.assertLess(len(json.dumps(lean.body)),len(json.dumps(full.body)))
            for query in ['states=all','states=omit&states=omit','states=omit&extra=x']:
                self.assert_status(self.stack.request('GET','/bootstrap?'+query,'doctor'),400)
def load_tests(loader,tests,pattern):
    return unittest.TestSuite(StudyQueryScopeLive(name) for name in loader.getTestCaseNames(StudyQueryScopeLive) if name.startswith(('test_query_','test_pages_')))
if __name__=='__main__':unittest.main(verbosity=2)
