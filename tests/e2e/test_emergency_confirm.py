"""REQ-D01-EMERGENCY-CONFIRM / RISK-FALSE-SAVE/OWNER/REPORT-LOSS."""
import sys
import time
import unittest
from playwright.sync_api import expect
from test_worklist import WorklistE2E
from test_template_preservation import TemplatePreservationE2E


class EmergencyConfirmE2E(WorklistE2E):
    report_rows=TemplatePreservationE2E.report_rows

    def wait_pending(self,p,pending):
        deadline=time.monotonic()+10
        while not pending and time.monotonic()<deadline:p.wait_for_timeout(50)
        self.assertEqual(len(pending),1)

    def badge(self,p,f):
        index=p.locator('#heads [data-key="em"]').evaluate('el=>Array.from(el.parentElement.children).indexOf(el)')
        return p.locator(f'#rows tr[data-uid="{f.uid}"] td').nth(index)

    def technician(self,f):
        p=self.login('tech');p.locator('[data-tab="Technician"]').click();self.select(p,f);return p

    def test_emergency_01_pending_confirm_unknown_refresh_and_retry(self):
        f=self.fixture();self.patch(f,em='N');before=self.report_rows(f);p=self.technician(f)
        pattern=f'**/api/studies/{f.uid}';pending=[]
        def hold(route):
            if route.request.method=='PATCH':pending.append(route)
            else:route.continue_()
        p.route(pattern,hold);self.context_action(p,f,'Switch to Emergency');self.wait_pending(p,pending)
        expect(self.badge(p,f)).to_have_text('Saving');self.assertEqual(p.evaluate('(uid)=>appState[uid].em',f.uid),'N')
        p.locator(f'#rows tr[data-uid="{f.uid}"]').click(button='right')
        expect(p.locator('#ctx [role=menuitem]',has_text='Saving Emergency Status')).to_have_attribute('aria-disabled','true')
        p.keyboard.press('Escape');pending.pop().continue_();expect(self.badge(p,f)).to_have_text('E')
        self.assertEqual(self.state(f)['em'],'E');p.unroute(pattern)
        p.route(pattern,lambda route:route.fulfill(status=503,json={'message':'synthetic unavailable'}))
        self.context_action(p,f,'Switch to Normal');expect(self.badge(p,f)).to_have_text('Unverified')
        self.assertEqual(self.state(f)['em'],'E');p.unroute(pattern)
        self.context_action(p,f,'Refresh Status');expect(self.badge(p,f)).to_have_text('E')
        self.context_action(p,f,'Switch to Normal');expect(self.badge(p,f)).to_have_text('');self.assertEqual(self.state(f)['em'],'N')
        self.assertEqual(self.report_rows(f),before);p.screenshot(path='../tmp/emergency-confirm/saved.png')

    def test_emergency_02_lost_response_old_list_and_report_draft(self):
        f=self.fixture();self.seed_report(f);before=self.report_rows(f)
        doctor=self.login();self.select(doctor,f);doctor.locator('#findings').fill('unsaved emergency confirmation')
        p=self.technician(f);old=[];p.route('**/api/studies?*',lambda route:old.append(route))
        p.locator('#refresh').click();self.wait_pending(p,old);snapshot=old[0].fetch();self.assertEqual(snapshot.status,200)
        self.context_action(p,f,'Switch to Emergency');expect(self.badge(p,f)).to_have_text('E')
        old.pop().fulfill(response=snapshot);p.unroute('**/api/studies?*');p.wait_for_timeout(200)
        expect(self.badge(p,f)).to_have_text('E');self.assertEqual(p.evaluate('(uid)=>appState[uid].em',f.uid),'E')
        pattern=f'**/api/studies/{f.uid}'
        def lost(route):
            result=route.fetch();self.assertEqual(result.status,200);route.abort('failed')
        p.route(pattern,lost);self.context_action(p,f,'Switch to Normal');expect(self.badge(p,f)).to_have_text('Unverified')
        self.assertEqual(self.state(f)['em'],'N');p.unroute(pattern)
        self.context_action(p,f,'Refresh Status');expect(self.badge(p,f)).to_have_text('')
        doctor.locator('#refresh').click();expect(doctor.locator('#findings')).to_have_value('unsaved emergency confirmation')
        self.assertEqual(self.report_rows(f),before)

    def test_emergency_03_menu_intent_and_pending_report_commit(self):
        f=self.fixture();self.seed_report(f);before=self.report_rows(f)
        p=self.login('jmryu');p.locator('[data-tab="Technician"]').click();self.select(p,f)
        pattern=f'**/api/studies/{f.uid}';pending=[];p.route(pattern,lambda route:pending.append(route))
        self.context_action(p,f,'Switch to Emergency');self.wait_pending(p,pending)
        p.locator('[data-tab="Radiology"]').click();expect(p.locator('#b-save')).to_be_disabled()
        p.evaluate("commitReport('save')");self.assertEqual(self.report_rows(f),before)
        pending.pop().continue_();p.unroute(pattern);expect(p.locator('#b-save')).to_be_enabled()
        p.locator('[data-tab="Technician"]').click();self.select(p,f)
        p.locator(f'#rows tr[data-uid="{f.uid}"]').click(button='right')
        expect(p.locator('#ctx [role=menuitem]',has_text='Switch to Normal')).to_be_visible()
        self.patch(f,em='N');p.evaluate('load()')
        with p.expect_request(lambda r:r.method=='PATCH' and r.url.endswith('/studies/'+f.uid)) as sent:
            p.locator('#ctx [role=menuitem]',has_text='Switch to Normal').click()
        self.assertEqual(sent.value.post_data_json,{'em':'N'})
        expect(self.badge(p,f)).to_have_text('');self.assertEqual(self.state(f)['em'],'N')
        self.assertEqual(self.report_rows(f),before)


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(EmergencyConfirmE2E(name) for name in EmergencyConfirmE2E.__dict__ if name.startswith('test_emergency_'))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
