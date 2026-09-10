"""REQ-D01-STARTUP-SELECTION / RISK-RETARGET/DEFAULT-SCOPE/OWNER / TEST-WORKLIST-STARTUP."""
import sys
import time
import unittest
import uuid
from playwright.sync_api import expect
from test_saved_filter_manager import SavedFilterManagerE2E
from test_workspace_persistence import WorkspacePersistenceE2E


class WorklistStartupE2E(SavedFilterManagerE2E):
    device=WorkspacePersistenceE2E.device
    sign_in=WorkspacePersistenceE2E.sign_in
    sign_out=WorkspacePersistenceE2E.sign_out

    def enable(self,p):
        p.locator('#image-opening-open').click();expect(p.locator('#worklist-select-first')).not_to_be_checked()
        p.locator('#worklist-select-first').check();expect(p.locator('#worklist-startup-status')).to_contain_text('다음 로그인')
        p.locator('#image-opening-done').click()

    def test_startup_01_default_search_first_result_relogin_and_other_account(self):
        a=self.fixture();b=self.fixture();context=self.device();p=self.sign_in(context);self.select(p,b)
        self.enable(p);self.assertEqual(p.evaluate('selectedUid'),b.uid)
        saved=self.stack.request('POST','/filters','doctor',dict(name='START-'+uuid.uuid4().hex[:10],mode='Radiology',days=-1,
            quick=a.patient_id,cols={'$compound':dict(version=2,quickMatch='exact',join='and',rules=[])},sortKey='id',sortDir=-1,isDefault=True))
        self.assertEqual(saved.status,201);self.addCleanup(self.remove_filter,saved.body['id'])
        self.sign_out(p);fresh=self.sign_in(context)
        fresh.wait_for_function('(uid)=>selectedUid===uid',arg=a.uid)
        expect(fresh.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(fresh.locator('#quick-match')).to_have_value('exact');self.assertEqual(len(context.pages),1)
        fresh.screenshot(path='../tmp/worklist-startup/first-result.png')
        c=self.fixture();fresh.locator('#refresh').click()
        fresh.wait_for_function('(uid)=>studies.some(s=>s.uid===uid)',arg=c.uid)
        self.assertEqual(fresh.evaluate('selectedUid'),a.uid)
        fresh.locator('#image-opening-open').click();fresh.locator('#image-opening-reset').click()
        expect(fresh.locator('#worklist-select-first')).not_to_be_checked();fresh.locator('#image-opening-done').click()
        self.assertEqual(fresh.evaluate('selectedUid'),a.uid)
        self.sign_out(fresh);other=self.sign_in(context,'doctor2')
        expect(other.locator(f'#rows tr[data-uid="{c.uid}"]')).to_be_visible();self.assertIsNone(other.evaluate('selectedUid'))
        other.locator('#image-opening-open').click();expect(other.locator('#worklist-select-first')).not_to_be_checked()

    def test_startup_02_user_input_during_initial_read_prevents_selection(self):
        a=self.fixture();b=self.fixture();context=self.device();p=self.sign_in(context);self.select(p,a);self.enable(p);self.sign_out(p)
        waiting=[];context.route('**/api/studies?*',lambda route:waiting.append(route))
        fresh=self.sign_in(context);fresh.locator('#quick').fill(b.patient_id)
        deadline=time.monotonic()+10
        while not waiting and time.monotonic()<deadline:fresh.wait_for_timeout(100)
        self.assertEqual(len(waiting),1);waiting[0].continue_();context.unroute('**/api/studies?*')
        expect(fresh.locator(f'#rows tr[data-uid="{b.uid}"]')).to_be_visible();self.assertIsNone(fresh.evaluate('selectedUid'))
        fresh.locator(f'#rows tr[data-uid="{b.uid}"]').click();self.assertEqual(fresh.evaluate('selectedUid'),b.uid)


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(WorklistStartupE2E(name) for name in WorklistStartupE2E.__dict__ if name.startswith('test_startup_'))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
