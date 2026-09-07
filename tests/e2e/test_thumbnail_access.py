# coding: utf-8
"""Accessible series disclosure and explicit opening retain source and report identity."""
from __future__ import annotations
import copy
import json
from pathlib import Path
import unittest
from playwright.sync_api import expect
from test_thumbnail_sort import ThumbnailSortE2E
from test_prior_selection import canvas_ready


class ThumbnailAccessE2E(ThumbnailSortE2E):
    def shot(self,page,name):
        folder=Path(__file__).parent/'artifacts';folder.mkdir(exist_ok=True)
        page.locator('#thumbwrap').screenshot(path=str(folder/('D02I-'+name+'.png')))

    def open_series(self,page,index,fixture,expected,all_series):
        action=getattr(self,'open_count',0)%3;self.open_count=getattr(self,'open_count',0)+1
        button=page.locator('.thumb-open').nth(index)
        expect(button).to_be_enabled()
        with page.context.expect_page() as opened:
            if action==2:button.click()
            else:
                button.focus();expect(button).to_be_focused();button.press(['Enter','Space'][action])
        viewer=opened.value
        try:
            viewer.wait_for_url('**/ohif/viewer?**');canvas_ready(viewer,1)
            images=viewer.evaluate("() => cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports().map(v=>v.getCurrentImageId?.()))")
            self.assertEqual(len(images),1)
            self.assertIn(f"/studies/{fixture.uid}/series/{expected['series']}/",images[0])
            self.assertTrue(any(f'/instances/{sop}/' in images[0] for sop in expected['sops']))
            viewer.wait_for_function('({uid,count})=>services.displaySetService.getActiveDisplaySets().filter(d=>d.StudyInstanceUID===uid).length===count',arg=dict(uid=fixture.uid,count=len(all_series)))
            sets=viewer.evaluate('uid=>services.displaySetService.getActiveDisplaySets().filter(d=>d.StudyInstanceUID===uid).map(d=>d.SeriesInstanceUID)',fixture.uid)
            self.assertEqual(set(sets),set(all_series))
            print('D02I actual opening '+json.dumps(dict(action=['Enter','Space','click'][action],study=fixture.uid,series=expected['series'],image=images[0],displaySets=sets)),flush=True)
        finally:viewer.close()

    def test_d02i_01_full_literal_identity_keyboard_and_portrait(self):
        fixture,page=self.setup_sorted_page();originals=self.originals();source=self.metadata(page,fixture)[0]
        literal='<img src=x onerror="window.d02iBad=1"> & '+('긴 설명 '*60)
        items=[]
        for number,desc in [('',literal),('7','같은 설명'),('7','같은 설명')]:
            item=copy.deepcopy(source);index=len(items)
            item['0020000E']={'vr':'UI','Value':['1.2.826.0.1.3680043.10.543.90209.'+'1'*30+str(index)]}
            item['00200011']={'vr':'IS','Value':[number]};item['0008103E']={'vr':'LO','Value':[desc]};items.append(item)
        pattern=f'**/dicom-web/studies/{fixture.uid}/instances';gets=[]
        def metadata(route):gets.append(1);route.fulfill(status=200,json=items)
        page.route(pattern,metadata);self.addCleanup(page.unroute,pattern)
        self.refresh_thumbnails(page);self.thumbs(page,3)
        page.set_viewport_size(dict(width=900,height=1400));writes=self.source_writes(page)
        for index,item in enumerate(items):
            card=page.locator('.thumb-card').nth(index);summary=card.locator('summary')
            expect(summary).to_be_visible();summary.focus();expect(summary).to_be_focused()
            summary.press('Enter');expect(card.locator('details')).to_have_attribute('open','')
            full=card.locator('.thumb-full')
            number=item['00200011']['Value'][0];desc=item['0008103E']['Value'][0];uid=item['0020000E']['Value'][0]
            expect(full).to_have_text(f"항목 {index+1} · "+(f'번호 {number}' if number else '번호 없음')+f'\n{desc}\nSeries UID: {uid}')
            expect(full).to_be_visible();self.assertIn(uid,card.locator('.thumb-open').get_attribute('aria-label'))
            size=card.evaluate('e=>({width:e.clientWidth,scroll:e.scrollWidth})');self.assertLessEqual(size['scroll'],size['width']+1)
            summary.press('Space');self.assertIsNone(card.locator('details').get_attribute('open'))
            summary.click()
        self.assertIsNone(page.evaluate('window.d02iBad'))
        expect(page.locator('.thumb-full img')).to_have_count(0)
        self.assertEqual(len(gets),1);self.assertEqual(writes,[]);self.shot(page,'full-portrait')
        self.assertEqual(self.originals(),originals)

    def test_d02i_02_real_keyboard_click_opening_preserves_report(self):
        # Reuse the real two-series current/related fixture and report preservation assertions.
        self.test_d02h_02_real_series_opening_and_related_report_identity()
        self.assertEqual(self.open_count,4)

    def test_d02i_03_cached_stale_failures_and_invalid_identity(self):
        current,related=self.pair();originals=self.originals()
        page=self.login();self.select(page,current);self.thumbs(page,1)
        numbers,series,state,gets,asc,desc=self.sort_variants(page,current)
        self.refresh_thumbnails(page);self.thumbs(page,24)
        page.evaluate('() => { window.d02iCalls=[];window.d02iRealOpen=openFilmbox;openFilmbox=(...a)=>d02iCalls.push(a);window.d02iOld=document.querySelector(".thumb-open"); }')
        page.locator('#thumb-next').click();self.thumbs(page,1);page.locator('.thumb-open').press('Enter')
        self.assertEqual(page.evaluate('d02iCalls'),[[current.uid,None,series[24]]])
        self.choose(page,'number-desc');page.evaluate('d02iOld.onclick()')
        self.select(page,related);self.thumbs(page,1);self.select(page,current);self.thumbs(page,24)
        page.evaluate('d02iOld.onclick()');self.assertEqual(page.evaluate('d02iCalls'),[[current.uid,None,series[24]]])
        self.assertEqual(len(gets),2,'Only new study generations fetch metadata')
        # Lookup and preview failures must never enable the new action, including decode failures.
        for mode in ['lookup','preview','decode','network']:
            pattern='**/api/dicom/lookup' if mode in ['lookup','network'] else '**/instances/*/preview'
            def fail(route):
                if mode=='network':route.abort('failed')
                elif mode=='decode':route.fulfill(status=200,content_type='image/png',body='invalid image')
                elif mode=='lookup':route.fulfill(status=503,json={'message':'D02I unavailable'})
                else:route.fulfill(status=503,body='D02I unavailable')
            page.route(pattern,fail);self.refresh_thumbnails(page);page.evaluate('() => thumbDone')
            expect(page.locator('.thumb-open')).to_have_count(24)
            expect(page.locator('.thumb-preview img')).to_have_count(0)
            self.assertTrue(all(page.locator('.thumb-open').nth(i).is_disabled() for i in range(24)))
            page.evaluate('document.querySelector(".thumb-open").onclick()')
            self.assertEqual(page.evaluate('d02iCalls'),[[current.uid,None,series[24]]])
            page.unroute(pattern,fail)
        self.refresh_thumbnails(page);self.thumbs(page,24)
        expect(page.locator('.thumb-open').first).to_be_enabled()
        self.shot(page,'restored')
        page.evaluate('openFilmbox=d02iRealOpen');opened=[];page.context.on('page',lambda p:opened.append(p))
        for invalid in ['', '1..2?unexpected']:
            item=copy.deepcopy(state['items'][0]);item['0020000E']['Value']=[invalid];state['items']=[item]
            self.refresh_thumbnails(page);self.thumbs(page,1);page.locator('.thumb-open').click()
            expect(page.locator('body')).to_contain_text('시리즈 정보를 확인할 수 없어 열지 않았습니다')
        self.assertEqual(opened,[]);self.assertEqual(self.originals(),originals)


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(ThumbnailAccessE2E(n) for n in loader.getTestCaseNames(ThumbnailAccessE2E) if n.startswith('test_d02i_'))

if __name__=='__main__':unittest.main(verbosity=2)
