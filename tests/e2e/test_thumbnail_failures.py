# coding: utf-8
"""D02G: stop scheduling thumbnail items after transport failure or HTTP401."""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path
import unittest
import uuid
from urllib.parse import urlsplit
from pydicom.uid import generate_uid
from playwright.sync_api import expect
from test_thumbnail_labels import ThumbnailLabelsE2E
from document_session import document_request


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
        """Plain 401 stops only its wave; a bound ENDED clears the document without a second logout. A session the server
        ended (not a person's Log out) leaves no landing to stand on: the next document starts the ordinary login by itself
        and the person meets the provider's form with an empty user name (session-end design v2 section 3.2, A005)."""
        fixture,page,originals,rows=self.setup_page();series,gets=self.variants(page,fixture);calls=[];logouts=[];logins=[]
        page.on('request',lambda request:logouts.append(request.url) if request.url.endswith('/api/auth/logout') else None)
        page.on('request',lambda request:logins.append((request.method,'x-kin-session' in request.headers))
                if request.url.split('?')[0].endswith('/api/auth/login') else None)
        def unauthorized(route):calls.append(route.request.url);route.fulfill(status=401,json={'message':'arbitrary 401 text'})
        pattern='**/api/dicom/lookup';page.route(pattern,unauthorized)
        self.refresh_thumbnails(page);self.stopped(page,calls,series,'lookup-plain-401')
        self.assertEqual(page.evaluate('KinWorkContext.state()'),'active');self.assertEqual(logouts,[])
        expect(page.locator('#findings')).to_have_value('D02G private draft')
        page.unroute(pattern,unauthorized)
        self.refresh_thumbnails(page);self.thumbs(page,24)
        writes=self.source_writes(page);actual=[]
        page.on('response',lambda response:actual.append((response.status,response.headers.get('x-kin-auth-code')))
                if response.url.endswith('/api/dicom/lookup') else None)
        response=document_request(page,'POST',self.stack.api+'/auth/logout',headers={'X-KIN-CSRF':'1'})
        self.assertEqual(response.status,204)
        self.assertIn('kin_sid',[cookie['name'] for cookie in page.context.cookies()])
        ended=document_request(page,'GET',self.stack.api+'/me')
        self.assertEqual(ended.status,401);self.assertEqual(ended.json()['code'],'AUTH_SESSION_ENDED')
        with page.expect_response(lambda response:response.url.endswith('/api/dicom/lookup') and response.status==401):
            page.evaluate('() => { renderThumbs(); }')
        # The work document closes; the next document goes on to the provider's form by itself.
        page.wait_for_url(re.compile(r'/auth/realms/kin/'),timeout=30000)
        name=page.locator('#username')
        expect(name).to_be_visible();expect(name).to_be_editable();expect(name).to_have_value('')
        expect(page.locator('#password')).to_be_visible()
        page.wait_for_timeout(500)
        # No second logout; one ordinary login start (a plain link, not bound to the ended session, no re-authentication
        # POST); and no product session came of it.
        self.assertEqual(logouts,[]);self.assertEqual(logins,[('GET',False)])
        self.assertEqual(page.context.request.get(self.stack.api+'/me',headers={'X-KIN-CSRF':'1'}).status,401)
        self.assertTrue(actual);self.assertLessEqual(len(actual),4)
        self.assertTrue(all(reply==(401,'AUTH_SESSION_ENDED') for reply in actual),actual)
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
