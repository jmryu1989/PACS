# coding: utf-8
"""D02H: numeric thumbnail ordering retains source identity and cached pagination."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest
import uuid
from playwright.sync_api import expect
from test_thumbnail_failures import ThumbnailFailuresE2E


class ThumbnailSortE2E(ThumbnailFailuresE2E):
    def setup_sorted_page(self):
        fixture=self.ct('D02H-'+uuid.uuid4().hex[:16],'current','20260801')
        self.seed_report(fixture)
        page=self.login();self.select(page,fixture);self.thumbs(page,1)
        return fixture,page

    def sort_variants(self,page,fixture):
        source=self.metadata(page,fixture)[0]
        numbers=['10','2','0','-3','+2','','  ','1e2','1.5','9007199254740993']+[str(i) for i in range(20,35)]
        series=['1.2.826.0.1.3680043.10.543.90208.'+str(i+1) for i in range(25)]
        items=[]
        for i,(uid,number) in enumerate(zip(series,numbers)):
            item=copy.deepcopy(source);item['0020000E']={'vr':'UI','Value':[uid]}
            item['00200011']={'vr':'IS','Value':[number]}
            item['0008103E']={'vr':'LO','Value':['D02H item '+str(i+1)]}
            if i==5:del item['00200011']
            items.append(item)
        state=dict(items=items);gets=[]
        pattern=f'**/dicom-web/studies/{fixture.uid}/instances'
        def respond(route):gets.append(route.request.url);route.fulfill(status=200,json=state['items'])
        page.route(pattern,respond);self.addCleanup(page.unroute,pattern)
        # Expected orders are explicit fixture outcomes, independent of the product comparator.
        ascending=[3,2,1,4,0]+list(range(10,25))+[9,5,6,7,8]
        descending=list(range(24,9,-1))+[0,1,4,2,3]+[9,5,6,7,8]
        return numbers,series,state,gets,ascending,descending

    def choose(self,page,value,count=24):
        page.get_by_label('시리즈 정렬').select_option(value)
        page.evaluate('() => thumbDone');self.thumbs(page,count)
        expect(page.get_by_label('시리즈 정렬')).to_have_value(value)

    def order(self,page,indices,numbers,series,start=0):
        self.assertEqual(page.locator('.thumb-card').count(),len(indices))
        for position,index in enumerate(indices):
            self.label(page,position,start+position+1,numbers[index].strip(),
                       'D02H item '+str(index+1),series[index])

    def shot(self,page,name):
        folder=Path(__file__).parent/'artifacts';folder.mkdir(exist_ok=True)
        page.locator('#thumbwrap').screenshot(path=str(folder/('D02H-'+name+'.png')))

    def test_d02h_01_numeric_missing_ties_and_response_order(self):
        """ORDER:25 response-only series exercise numeric boundaries and deterministic ties."""
        fixture,page=self.setup_sorted_page();originals=self.originals();rows=self.report_rows(fixture)
        numbers,series,state,gets,asc,desc=self.sort_variants(page,fixture)
        self.refresh_thumbnails(page);self.thumbs(page,24)
        self.order(page,list(range(24)),numbers,series)
        expect(page.get_by_label('시리즈 정렬')).to_be_visible()
        expect(page.get_by_label('시리즈 정렬')).to_have_value('source')
        writes=self.source_writes(page)
        self.choose(page,'number-asc');self.order(page,asc[:24],numbers,series)
        page.locator('#thumb-next').click();self.thumbs(page,1);self.order(page,asc[24:],numbers,series,24)
        self.choose(page,'number-desc');self.order(page,desc[:24],numbers,series)
        page.set_viewport_size(dict(width=900,height=1400))
        expect(page.get_by_label('시리즈 정렬')).to_be_in_viewport()
        dimensions=page.locator('#thumbwrap').evaluate('e=>({width:e.clientWidth,scroll:e.scrollWidth})')
        self.assertLessEqual(dimensions['scroll'],dimensions['width']+1)
        self.shot(page,'descending-portrait')
        state['items']=list(reversed(state['items']))
        self.refresh_thumbnails(page);self.thumbs(page,24)
        expect(page.get_by_label('시리즈 정렬')).to_have_value('number-desc')
        self.order(page,desc[:24],numbers,series)
        self.choose(page,'number-asc');self.order(page,asc[:24],numbers,series)
        self.choose(page,'source');self.order(page,list(range(24,0,-1)),numbers,series)
        self.assertEqual(len(gets),2,'Only explicit fresh metadata generations may fetch metadata')
        self.assertEqual(writes,[]);self.assertEqual(self.report_rows(fixture),rows);self.assertEqual(self.originals(),originals)
        print('D02H explicit orders '+json.dumps(dict(ascending=asc,descending=desc,metadataRequests=len(gets))),flush=True)

    def test_d02h_02_real_series_opening_and_related_report_identity(self):
        """IDENTITY:real2-series current/related CT, actual OHIF image identity and preserved authoring."""
        patient='D02H-'+uuid.uuid4().hex[:16]
        current=self.multiple(patient,'current','20260801');related=self.multiple(patient,'future','20260907')
        self.seed_report(current);self.seed_report(related,action='approve')
        values=dict(findings='D02H current draft',conclusion='D02H conclusion',recommendation='D02H recommendation')
        self.assertEqual(self.stack.request('PUT',f'/studies/{current.uid}/report','doctor',dict(values,baseVersion=1)).status,200)
        self.assertEqual(self.stack.request('POST',f'/studies/{current.uid}/hold','doctor').status,201)
        originals=self.originals();rows={f.uid:self.report_rows(f) for f in (current,related)}
        page=self.login();self.select(page,current);self.thumbs(page);writes=self.source_writes(page)
        for fixture,mode in [(current,'number-desc'),(related,'number-asc')]:
            if fixture==related:self.related(page,related).click();self.thumbs(page)
            metadata=self.metadata(page,fixture);reps=self.representatives(metadata)
            by_sop={x['00080018']['Value'][0]:x for x in metadata}
            ordered=sorted(reps,key=lambda r:int(by_sop[r['sop']]['00200011']['Value'][0]),reverse=mode=='number-desc')
            self.choose(page,mode,2)
            for i,rep in enumerate(ordered):
                data=by_sop[rep['sop']]
                self.label(page,i,i+1,str(data['00200011']['Value'][0]),data['0008103E']['Value'][0],rep['series'])
                self.open_series(page,i,fixture,rep,[x['series'] for x in reps])
            self.shot(page,'real-'+mode)
        expect(page.locator('#prior-findings')).to_have_text(related.secret)
        page.locator('#related-return').click();self.thumbs(page)
        expect(page.get_by_label('시리즈 정렬')).to_have_value('number-asc')
        for name,value in values.items():expect(page.locator('#'+name)).to_have_value(value)
        self.assertEqual(self.state(current)['holder'],self.stack.actor('doctor'))
        self.assertEqual(writes,[])
        for fixture in (current,related):self.assertEqual(self.report_rows(fixture),rows[fixture.uid])
        self.assertEqual(self.originals(),originals)

    def test_d02h_03_cached_pages_stale_handlers_and_reload(self):
        """CACHE:sort resets page, retains complete identity set and rejects superseded handlers."""
        current,related=self.pair();originals=self.originals()
        page=self.login();self.select(page,current);self.thumbs(page,1)
        numbers,series,state,gets,asc,desc=self.sort_variants(page,current)
        self.refresh_thumbnails(page);self.thumbs(page,24)
        page.evaluate('() => { window.d02hCalls=[]; openFilmbox=(...args)=>d02hCalls.push(args); }')
        page.locator('#thumb-next').click();self.thumbs(page,1)
        self.choose(page,'number-desc');self.order(page,desc[:24],numbers,series)
        expect(page.locator('#thumb-range')).to_have_text('시리즈 1–24 / 25')
        page.locator('#thumb-next').click();self.thumbs(page,1);self.order(page,desc[24:],numbers,series,24)
        page.locator('#thumbwrap img').dblclick()
        self.assertEqual(page.evaluate('d02hCalls'),[[current.uid,None,series[desc[24]]]])
        self.choose(page,'source');self.order(page,list(range(24)),numbers,series)
        self.assertEqual(len(gets),1)
        page.evaluate("""() => {
          window.d02hOldSort=document.querySelector('#thumb-sort');
          window.d02hOldImage=document.querySelector('#thumbwrap img');
          const select=document.querySelector('#thumb-sort');
          select.value='number-asc';select.dispatchEvent(new Event('change'));
          select.value='number-desc';select.dispatchEvent(new Event('change'));
        }""")
        self.thumbs(page,24);page.evaluate('() => thumbDone')
        expect(page.get_by_label('시리즈 정렬')).to_have_value('number-asc')
        self.order(page,asc[:24],numbers,series)
        self.select(page,related);self.thumbs(page,1)
        expect(page.get_by_label('시리즈 정렬')).to_have_value('number-asc')
        page.evaluate("() => { d02hOldSort.value='number-desc';d02hOldSort.onchange();d02hOldImage.ondblclick(); }")
        expect(page.get_by_label('시리즈 정렬')).to_have_value('number-asc')
        expect(page.locator('#thumbwrap')).not_to_contain_text('D02H item')
        self.assertEqual(page.evaluate('d02hCalls'),[[current.uid,None,series[desc[24]]]])
        self.select(page,current);self.thumbs(page,24);self.order(page,asc[:24],numbers,series)
        self.assertEqual(len(gets),2)
        page.reload();page.wait_for_selector('#rows tr[data-uid]');self.select(page,current);self.thumbs(page,24)
        expect(page.get_by_label('시리즈 정렬')).to_have_value('source')
        self.order(page,list(range(24)),numbers,series);self.shot(page,'source-reload')
        self.assertEqual(self.originals(),originals)


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(ThumbnailSortE2E(n) for n in loader.getTestCaseNames(ThumbnailSortE2E)
                              if n.startswith('test_d02h_'))

if __name__=='__main__':unittest.main(verbosity=2)
