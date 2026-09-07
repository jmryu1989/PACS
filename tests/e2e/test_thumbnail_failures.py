# coding: utf-8
"""D02G: stop scheduling thumbnail items after transport failure or HTTP401."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest
import uuid
from urllib.parse import urlsplit
from pydicom.uid import generate_uid
from playwright.sync_api import expect
from test_thumbnail_labels import ThumbnailLabelsE2E


class ThumbnailFailuresE2E(ThumbnailLabelsE2E):
    def variants(self,page,fixture):
        source=self.metadata(page,fixture)[0];series=[generate_uid() for _ in range(25)];items=[]
        for i,uid in enumerate(series):
            item=copy.deepcopy(source);item['0020000E']={'vr':'UI','Value':[uid]}
            item['00200011']={'vr':'IS','Value':[i+101]}
            item['0008103E']={'vr':'LO','Value':['D02G item '+str(i+1)]};items.append(item)
        pattern=f'**/dicom-web/studies/{fixture.uid}/instances';gets=[]
        def response(route):gets.append(route.request.url);route.fulfill(status=200,json=items)
        page.route(pattern,response);self.addCleanup(page.unroute,pattern)
        return series,gets

    def refresh_thumbnails(self,page):
        # The studies response precedes its render callback; wait until this new generation actually requests metadata.
        with page.expect_request(lambda r:'/dicom-web/studies/' in r.url and r.url.endswith('/instances')):
            self.refresh(page)

    def stopped(self,page,calls,series,label):
        page.evaluate('() => thumbDone')
        print('D02G requests '+json.dumps(dict(case=label,requests=len(calls))),flush=True)
        self.assertGreater(len(calls),0)
        self.assertLessEqual(len(calls),4,'First-wave common failure must not schedule the rest of 24 items')
        previews=page.locator('.thumb-preview').all_text_contents()
        self.assertEqual(len(previews),24)
        self.assertTrue(all('로딩' not in s for s in previews))
        self.assertGreaterEqual(sum('요청 중단' in s for s in previews),20)
        for index in range(24):self.label(page,index,index+1,str(index+101),'D02G item '+str(index+1),series[index])
        folder=Path(__file__).parent/'artifacts';folder.mkdir(exist_ok=True)
        page.locator('#thumbwrap').screenshot(path=str(folder/('D02G-'+label+'.png')))

    def setup_page(self):
        fixture=self.ct('D02G-'+uuid.uuid4().hex[:16],'current','20260801');self.seed_report(fixture)
        self.assertEqual(self.stack.request('PUT',f'/studies/{fixture.uid}/report','doctor',dict(
            findings='D02G private draft',conclusion='',recommendation='',baseVersion=1)).status,200)
        page=self.login();self.select(page,fixture);self.thumbs(page,1)
        return fixture,page,self.originals(),self.report_rows(fixture)

    def test_d02g_01_lookup_transport_failure_stops_unstarted_items(self):
        """STOP/FLOOD: controlled browser fetch failures, actual lookup request count."""
        fixture,page,originals,rows=self.setup_page();series,gets=self.variants(page,fixture);calls=[]
        def fail(route):calls.append(route.request.url);route.abort('connectionfailed')
        pattern='**/api/dicom/lookup';page.route(pattern,fail);self.addCleanup(page.unroute,pattern)
        writes=self.source_writes(page);self.refresh_thumbnails(page)
        self.stopped(page,calls,series,'lookup-network')
        self.assertEqual(len(gets),1);expect(page.locator('#findings')).to_have_value('D02G private draft')
        self.assertEqual(writes,[]);self.assertEqual(self.report_rows(fixture),rows);self.assertEqual(self.originals(),originals)

    def test_d02g_02_401_bound_and_real_session_end(self):
        """AUTH: isolated logout counting followed by a real BFF-revoked session and original logout."""
        fixture,page,originals,rows=self.setup_page();series,gets=self.variants(page,fixture);calls=[]
        page.evaluate('() => { window.d02gLogouts=0; KinAuth.logout=async()=>{ d02gLogouts++; }; }')
        def unauthorized(route):calls.append(route.request.url);route.fulfill(status=401,json={'message':'arbitrary 401 text'})
        pattern='**/api/dicom/lookup';page.route(pattern,unauthorized)
        self.refresh_thumbnails(page);self.stopped(page,calls,series,'lookup-401-observer')
        self.assertEqual(page.evaluate('d02gLogouts'),len(calls));self.assertLessEqual(len(calls),4)
        page.unroute(pattern,unauthorized)
        # Reload removes the observer; the next branch uses actual server401 and the product's unchanged logout.
        page.reload();page.wait_for_selector('#rows tr[data-uid]');self.select(page,fixture);self.thumbs(page,24)
        writes=self.source_writes(page);actual=[];logouts=[];navigations=[]
        page.on('framenavigated',lambda frame:navigations.append(urlsplit(frame.url).path) if frame==page.main_frame else None)
        page.on('response',lambda r:actual.append(r.status) if r.url.endswith('/api/dicom/lookup') else None)
        page.on('response',lambda r:logouts.append(r.status) if r.url.endswith('/api/auth/logout') else None)
        response=page.context.request.post(self.stack.api+'/auth/logout',headers={'X-KIN-CSRF':'1'})
        self.assertIn(response.status,(200,204));self.assertEqual(page.context.request.get(self.stack.api+'/me').status,401)
        with page.expect_response(lambda r:r.url.endswith('/api/dicom/lookup') and r.status==401):
            page.evaluate('() => { renderThumbs(); }')
        # Concurrent401 replies can replace one navigation, and index immediately starts login; observe the final form.
        expect(page.locator('#username')).to_be_visible()
        self.assertIn('/worklist/hpacs-lite/index.html',navigations)
        self.assertTrue(actual);self.assertTrue(all(x==401 for x in actual));self.assertLessEqual(len(actual),4)
        print('D02G real session '+json.dumps(dict(lookupStatus=actual,logoutStatus=logouts,
              indexObserved=True,finalPath=urlsplit(page.url).path)),flush=True)
        # The explicit revocation returned204; further logout calls carry no valid session and the auth guard returns401.
        self.assertTrue(logouts);self.assertTrue(all(x==401 for x in logouts),logouts)
        self.assertEqual(page.context.request.get(self.stack.api+'/me').status,401)
        self.assertEqual(writes,[]);self.assertEqual(self.report_rows(fixture),rows);self.assertEqual(self.originals(),originals)

    def test_d02g_03_preview_failures_individual_errors_and_retry(self):
        """RECOVER: preview transport/401 stops; per-item403/503 and a fresh generation still progress."""
        fixture,page,originals,rows=self.setup_page();series,gets=self.variants(page,fixture)
        pattern='**/instances/*/preview'
        for mode in ('network','401'):
            calls=[]
            def fail(route):
                calls.append(route.request.url)
                if mode=='network':route.abort('connectionfailed')
                else:route.fulfill(status=401,body='arbitrary preview401')
            page.route(pattern,fail);self.refresh_thumbnails(page)
            self.stopped(page,calls,series,'preview-'+mode);page.unroute(pattern,fail)
        lookup=[];preview=[]
        def one_lookup(route):
            lookup.append(route.request.url)
            if len(lookup)==1:route.fulfill(status=403,json={'message':'D02G item forbidden'})
            else:route.continue_()
        def one_preview(route):
            preview.append(route.request.url)
            if len(preview)==1:route.fulfill(status=503,body='D02G item unavailable')
            else:route.continue_()
        page.route('**/api/dicom/lookup',one_lookup);page.route(pattern,one_preview)
        self.refresh_thumbnails(page);page.evaluate('() => thumbDone');self.thumbs(page,22)
        self.assertEqual(len(lookup),24);self.assertEqual(len(preview),23)
        expect(page.locator('#thumbwrap')).not_to_contain_text('요청 중단')
        expect(page.locator('#thumbwrap')).to_contain_text('D02G item forbidden')
        expect(page.locator('#thumbwrap')).to_contain_text('HTTP 503')
        page.unroute('**/api/dicom/lookup',one_lookup);page.unroute(pattern,one_preview)
        self.refresh_thumbnails(page);self.thumbs(page,24)
        expect(page.locator('#thumbwrap')).not_to_contain_text('실패')
        expect(page.locator('#thumbwrap')).not_to_contain_text('요청 중단')
        page.locator('#thumb-next').click();self.thumbs(page,1)
        self.label(page,0,25,'125','D02G item 25',series[24])
        self.assertEqual(len(gets),4,'Three fault generations and explicit retry; cached page2 adds no metadata request')
        self.assertEqual(self.report_rows(fixture),rows);self.assertEqual(self.originals(),originals)


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(ThumbnailFailuresE2E(n) for n in loader.getTestCaseNames(ThumbnailFailuresE2E)
                              if n.startswith('test_d02g_'))

if __name__=='__main__':unittest.main(verbosity=2)
