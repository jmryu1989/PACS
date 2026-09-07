# coding: utf-8
"""D02F: source series labels stay bound to thumbnails through paging and failure."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest
import uuid
from pydicom.uid import generate_uid
from playwright.sync_api import expect
from test_thumbnail_series import ThumbnailSeriesE2E


class ThumbnailLabelsE2E(ThumbnailSeriesE2E):
    def label(self, page, index, ordinal, number, description, series):
        card = page.locator('#thumbwrap .thumb-card').nth(index)
        first = f'항목 {ordinal} · '+(f'번호 {number}' if number else '번호 없음')
        expect(card.locator('.thumb-number')).to_have_text(first)
        expect(card.locator('.thumb-description')).to_have_text(description or '설명 없음')
        title = card.get_attribute('title')
        for value in (first, description or '설명 없음', f'Series UID: {series}'):
            self.assertIn(value, title)
        return card

    def snapshot(self, page, name):
        folder = Path(__file__).parent/'artifacts';folder.mkdir(exist_ok=True)
        page.locator('#thumbwrap').screenshot(path=str(folder/('D02F-'+name+'.png')))

    def test_d02f_01_source_labels_open_real_series_and_keep_report(self):
        """LABEL/IDENTITY: real metadata, actual viewport identity and unchanged authoring state."""
        current = self.multiple('D02F-'+uuid.uuid4().hex[:16], 'current', '20260801')
        self.seed_report(current)
        values = dict(findings='D02F private findings', conclusion='D02F private conclusion',
                      recommendation='D02F private recommendation')
        self.assertEqual(self.stack.request('PUT', f'/studies/{current.uid}/report', 'doctor',
                         dict(values, baseVersion=1)).status, 200)
        self.assertEqual(self.stack.request('POST', f'/studies/{current.uid}/hold', 'doctor').status, 201)
        originals = self.originals();rows = self.report_rows(current)
        page = self.login();self.select(page, current);self.thumbs(page)
        metadata = self.metadata(page, current);reps = self.representatives(metadata)
        by_sop = {x['00080018']['Value'][0]: x for x in metadata}
        writes = self.source_writes(page)
        for index, rep in enumerate(reps):
            source = by_sop[rep['sop']]
            number = str(source['00200011']['Value'][0])
            description = source['0008103E']['Value'][0]
            card = self.label(page, index, index+1, number, description, rep['series'])
            expect(card.locator('.thumb-number')).to_be_in_viewport()
            expect(card.locator('.thumb-description')).to_be_in_viewport()
            expect(card.locator('img')).to_have_attribute('alt', f'항목 {index+1} · 번호 {number} · {description}')
            self.open_series(page, index, current, rep, [x['series'] for x in reps])
            print('D02F actual label '+json.dumps(dict(index=index,number=number,description=description,
                  series=rep['series'],sop=rep['sop']),ensure_ascii=False),flush=True)
        self.snapshot(page, 'real-labels')
        for name,value in values.items():expect(page.locator('#'+name)).to_have_value(value)
        self.assertEqual(self.state(current)['holder'],self.stack.actor('doctor'))
        self.assertEqual(writes,[]);self.assertEqual(self.report_rows(current),rows)
        self.assertEqual(self.originals(),originals)

    def test_d02f_02_literal_missing_duplicate_and_failure_identity(self):
        """TEXT/FAILURE: response variants test labels, not fabricated-series image support."""
        current = self.ct('D02F-'+uuid.uuid4().hex[:16], 'current', '20260801')
        originals = self.originals();page = self.login();self.select(page,current);self.thumbs(page,1)
        source = self.metadata(page,current)[0]
        literal = '<img src=x onerror="window.d02fBad=1"> & 설명 '+('긴문자'*90)
        numbers = ['', '0', '7', '7', '  ', '<b>9</b>']
        descriptions = ['', '영점', '같은 설명', '같은 설명', literal, '원문 번호']
        series = [generate_uid() for _ in numbers];items=[]
        for index,(number,description) in enumerate(zip(numbers,descriptions)):
            item = copy.deepcopy(source)
            item['0020000E']={'vr':'UI','Value':[series[index]]}
            item['00200013']={'vr':'IS','Value':[2]}
            item['00200011']={'vr':'IS','Value':[number]}
            item['0008103E']={'vr':'LO','Value':[description]}
            if index==0:
                del item['00200011'];del item['0008103E']
            items.append(item)
        # A different first-instance value must not be mixed into the chosen representative's caption.
        first=copy.deepcopy(items[1]);first['00200013']['Value']=[1]
        first['00200011']['Value']=['99'];first['0008103E']['Value']=['first, not representative']
        items.insert(1,first)
        pattern=f'**/dicom-web/studies/{current.uid}/instances'
        page.route(pattern,lambda route:route.fulfill(status=200,json=items));self.addCleanup(page.unroute,pattern)
        page.set_viewport_size(dict(width=900,height=1400))
        self.refresh(page);self.thumbs(page,6)
        for index in range(6):self.label(page,index,index+1,numbers[index].strip(),descriptions[index],series[index])
        self.assertIsNone(page.evaluate('window.d02fBad'))
        expect(page.locator('.thumb-number b, .thumb-description img')).to_have_count(0)
        sizes=page.locator('#thumbwrap .thumb-card').evaluate_all('cards=>cards.map(c=>({width:c.clientWidth,scroll:c.scrollWidth,desc:c.querySelector(".thumb-description").scrollWidth}))')
        self.assertTrue(all(x['scroll']<=x['width']+1 for x in sizes),sizes)
        self.assertGreater(sizes[4]['desc'],sizes[4]['width'])
        self.snapshot(page,'literal-portrait')
        page.locator('.thumb-card').nth(4).screenshot(path=str(Path(__file__).parent/'artifacts'/'D02F-long-label.png'))
        failures=[]
        def lookup(route):
            if not failures:
                failures.append('lookup');route.fulfill(status=503,json={'message':'D02F lookup unavailable'})
            else:route.continue_()
        def preview(route):
            if 'preview' not in failures:
                failures.append('preview');route.fulfill(status=503,body='D02F preview unavailable')
            else:route.continue_()
        page.route('**/api/dicom/lookup',lookup);page.route('**/instances/*/preview',preview)
        self.refresh(page)
        expect(page.locator('#thumbwrap .thumb-card')).to_have_count(6)
        expect(page.locator('#thumbwrap img')).to_have_count(4)
        expect(page.locator('#thumbwrap')).to_contain_text('D02F lookup unavailable')
        expect(page.locator('#thumbwrap')).to_contain_text('HTTP 503')
        for index in range(6):self.label(page,index,index+1,numbers[index].strip(),descriptions[index],series[index])
        errors=page.locator('.thumb-preview').all_text_contents()
        self.assertEqual(sum('실패' in text for text in errors),2)
        self.snapshot(page,'item-failures')
        page.unroute('**/api/dicom/lookup',lookup);page.unroute('**/instances/*/preview',preview)
        self.refresh(page);self.thumbs(page,6)
        expect(page.locator('#thumbwrap')).not_to_contain_text('실패')
        self.assertEqual(self.originals(),originals)

    def test_d02f_03_cached_labels_and_old_handler(self):
        """CACHE/STALE: 25 response-only identities stay paired across cached page navigation."""
        current,related=self.pair();originals=self.originals()
        page=self.login();self.select(page,current);self.thumbs(page,1)
        source=self.metadata(page,current)[0];series=[generate_uid() for _ in range(25)];items=[];gets=[]
        for index,uid in enumerate(series):
            item=copy.deepcopy(source);item['0020000E']={'vr':'UI','Value':[uid]}
            item['00200011']={'vr':'IS','Value':[100-index]}
            item['0008103E']={'vr':'LO','Value':['D02F page '+str(index+1)]};items.append(item)
        pattern=f'**/dicom-web/studies/{current.uid}/instances'
        def metadata(route):gets.append(route.request.url);route.fulfill(status=200,json=items)
        page.route(pattern,metadata);self.addCleanup(page.unroute,pattern)
        page.evaluate('() => { window.d02fCalls=[]; openFilmbox=(...args)=>d02fCalls.push(args); }')
        self.refresh(page);self.thumbs(page,24)
        self.label(page,0,1,'100','D02F page 1',series[0])
        page.locator('#thumb-next').click();self.thumbs(page,1)
        self.label(page,0,25,'76','D02F page 25',series[24])
        page.locator('#thumbwrap img').dblclick()
        self.assertEqual(page.evaluate('d02fCalls'),[[current.uid,None,series[24]]])
        self.snapshot(page,'cached-page2')
        page.locator('#thumb-prev').click();self.thumbs(page,24)
        self.label(page,0,1,'100','D02F page 1',series[0]);self.assertEqual(len(gets),1)
        page.evaluate("window.d02fOld=document.querySelector('#thumbwrap img')")
        self.select(page,related);self.thumbs(page,1);page.evaluate('d02fOld.ondblclick()')
        self.assertEqual(page.evaluate('d02fCalls'),[[current.uid,None,series[24]]])
        expect(page.locator('#thumbwrap')).not_to_contain_text('D02F page')
        self.assertEqual(self.originals(),originals)


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(ThumbnailLabelsE2E(name) for name in loader.getTestCaseNames(ThumbnailLabelsE2E)
                              if name.startswith('test_d02f_'))

if __name__=='__main__':unittest.main(verbosity=2)
