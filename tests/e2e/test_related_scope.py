"""REQ-D03-RELATED-SCOPE / RISK-TARGET/IDENTITY/PARTIAL/STALE / TEST-RELATED-SCOPE."""
import json
import sys
import unittest
import uuid
from playwright.sync_api import expect
from test_related_filter import RelatedFilterE2E
from test_prior_selection import synthetic_ct


class RelatedScopeE2E(RelatedFilterE2E):
    def part_ct(self,patient,label,part):
        return synthetic_ct(self.stack,patient,label,'20260801' if label=='current' else '20260701',slices=2,body_part=part)

    def wait_pending(self,p,pending):
        import time
        deadline=time.monotonic()+10
        while not pending and time.monotonic()<deadline:p.wait_for_timeout(50)
        self.assertEqual(len(pending),1)

    def load_parts(self,p,total):
        p.locator('#related-load-parts').click()
        expect(p.locator('#related-cancel-parts')).not_to_be_visible(timeout=25000)
        expect(p.locator('#related-parts-status')).to_contain_text(f'부위 확인 {total}/')

    def test_scope_01_real_parts_current_return_filter_and_single_open(self):
        patient='PART-'+uuid.uuid4().hex[:16]
        current=self.part_ct(patient,'current','CHEST');prior=self.part_ct(patient,'prior','ABDOMEN');empty=self.part_ct(patient,'empty',None)
        self.seed_report(current);self.seed_report(prior,action='approve')
        originals=self.originals();rows={f.uid:self.report_rows(f) for f in (current,prior,empty)}
        p=self.login();self.select(p,current);p.locator('#related-options-open').click();p.locator('#findings').fill('unsaved related scope')
        self.load_parts(p,3)
        p.locator('#related-body-part').select_option(json.dumps('ABDOMEN'));self.shown(p,[prior])
        self.related(p,prior).click();self.thumbnail_ready(p);expect(p.locator('#prior-findings')).to_have_text(prior.secret)
        p.locator('#related-include-current').check();p.locator('#related-body-part').select_option(json.dumps('CHEST'));self.shown(p,[current])
        expect(p.locator('#related-filter-hidden')).to_be_visible();self.assertEqual(p.evaluate('relatedUid'),prior.uid)
        self.related(p,current).click();self.thumbnail_ready(p);self.assertIsNone(p.evaluate('relatedUid'))
        expect(self.related(p,current)).to_contain_text('Reading Target');expect(p.locator('#findings')).to_have_value('unsaved related scope')
        self.viewer(p,self.related(p,current),[current])
        p.locator('#related-body-part').select_option(json.dumps(''));self.shown(p,[empty])
        p.locator('#related-body-part').select_option('?');self.shown(p,[])
        p.locator('#related-body-part').select_option('');self.shown(p,[current,prior,empty])
        p.screenshot(path='../tmp/related-scope/controls.png')
        for f in (current,prior,empty):self.assertEqual(self.report_rows(f),rows[f.uid])
        self.assertEqual(self.originals(),originals)

    def test_scope_02_failed_lookup_retry_cancel_and_target_change(self):
        patient='PART-'+uuid.uuid4().hex[:16]
        current=self.part_ct(patient,'current','CHEST');prior=self.part_ct(patient,'prior','ABDOMEN')
        other=self.part_ct(patient+'other','other','HEAD')
        p=self.login();self.select(p,current);p.locator('#related-options-open').click();pattern=f'**/dicom-web/studies/{prior.uid}/series?*'
        p.route(pattern,lambda route:route.fulfill(status=503,body='unavailable'))
        self.load_parts(p,1);p.locator('#related-body-part').select_option('?');self.shown(p,[prior])
        p.unroute(pattern);self.load_parts(p,2);self.shown(p,[])
        p.locator('#related-body-part').select_option(json.dumps('ABDOMEN'));self.shown(p,[prior])
        pending=[];p.route(pattern,lambda route:pending.append(route));p.locator('#related-load-parts').click()
        self.wait_pending(p,pending)
        self.assertEqual(len(pending),1);p.locator('#related-cancel-parts').click()
        pending.pop().continue_();p.wait_for_timeout(200);self.shown(p,[])
        p.locator('#related-load-parts').click();self.wait_pending(p,pending);self.assertEqual(len(pending),1)
        self.select(p,other);pending.pop().continue_();p.wait_for_timeout(200)
        expect(p.locator('#related-body-part')).to_have_value('');expect(p.locator('#related-parts-status')).to_contain_text('부위 확인 0/1')
        self.assertNotIn('ABDOMEN',p.locator('#related-body-part option').all_text_contents());self.assertEqual(p.evaluate('selectedUid'),other.uid)
        p.unroute(pattern)


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(RelatedScopeE2E(name) for name in RelatedScopeE2E.__dict__ if name.startswith('test_scope_'))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
