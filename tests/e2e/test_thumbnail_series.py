# coding: utf-8
"""D02E: preserve thumbnail Study/Series identity through real pinned OHIF opening."""
from __future__ import annotations

import copy
import io
import json
from pathlib import Path
import re
import unittest
import uuid
from urllib.parse import parse_qs,urlsplit
from pydicom import dcmread
from pydicom.uid import generate_uid,CTImageStorage,ExplicitVRLittleEndian
from pynetdicom import AE
from playwright.sync_api import expect
import test_return_to_current as previous
from test_prior_selection import canvas_ready


class ThumbnailSeriesE2E(previous.ReturnToCurrentE2E):
    def multiple(self,patient,label,date):
        fixture=self.ct(patient,label,date)
        found=self.stack._orthanc_request("POST","/tools/lookup",fixture.uid.encode()).body
        orth=next(x["ID"] for x in found if x["Type"]=="Study")
        instances=self.stack._orthanc_request("GET",f"/studies/{orth}/instances").body
        originals=[dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+x['ID']+'/file'))) for x in instances]
        new_series=generate_uid();ae=AE(ae_title="HALLYM_CT")
        ae.add_requested_context(CTImageStorage,ExplicitVRLittleEndian)
        assoc=ae.associate("127.0.0.1",4242,ae_title="KINLAB");self.assertTrue(assoc.is_established)
        try:
            for original in originals:
                data=copy.deepcopy(original);data.SeriesInstanceUID=new_series;data.SeriesNumber=2
                data.SeriesDescription="D02E second series"
                data.SOPInstanceUID=generate_uid();data.file_meta.MediaStorageSOPInstanceUID=data.SOPInstanceUID
                data.PixelData=original.pixel_array[::-1,:].copy().astype("<u2").tobytes()
                self.assertEqual(assoc.send_c_store(data).Status,0)
        finally:assoc.release()
        return fixture

    def metadata(self,page,fixture):
        response=page.request.get(self.stack.proxy+f"/dicom-web/studies/{fixture.uid}/instances")
        self.assertEqual(response.status,200)
        return response.json()

    def representatives(self,metadata):
        groups={}
        for item in metadata:groups.setdefault(item["0020000E"]["Value"][0],[]).append(item)
        result=[]
        for series,items in groups.items():
            items.sort(key=lambda item:int(item["00200013"]["Value"][0]))
            middle=items[len(items)//2]
            result.append(dict(series=series,sop=middle["00080018"]["Value"][0],
                               sops=[x["00080018"]["Value"][0] for x in items]))
        return result

    def thumbs(self,page,count=2):
        expect(page.locator("#thumbwrap img")).to_have_count(count)
        page.wait_for_function("[...document.querySelectorAll('#thumbwrap img')].every(i=>i.naturalWidth>0)")

    def open_series(self,page,index,fixture,expected,all_series):
        with page.context.expect_page() as opened:page.locator("#thumbwrap img").nth(index).dblclick()
        viewer=opened.value
        try:
            viewer.wait_for_url("**/ohif/viewer?**");canvas_ready(viewer,1)
            images=viewer.evaluate("""() => cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails')
                .flatMap(e=>e.getViewports().map(v=>v.getCurrentImageId?.()))""")
            self.assertEqual(len(images),1)
            record=dict(study=fixture.uid,expected=expected,image=images[0],url=viewer.url)
            print("D02E actual opening "+json.dumps(record),flush=True)
            self.assertIn(f"/studies/{fixture.uid}/series/{expected['series']}/",images[0],
                          "The thumbnail's series must be the actual displayed image series")
            self.assertTrue(any(f"/instances/{sop}/" in images[0] for sop in expected['sops']))
            query=parse_qs(urlsplit(viewer.url).query)
            self.assertEqual(query['initialSeriesInstanceUID'],[expected['series']])
            self.assertEqual(query['StudyInstanceUIDs'],[fixture.uid]);self.assertNotIn('SeriesInstanceUIDs',query)
            self.assertNotIn('hangingProtocolId',query)
            viewer.wait_for_function("""({uid,count}) => services.displaySetService.getActiveDisplaySets()
                .filter(d=>d.StudyInstanceUID===uid).length===count""",arg=dict(uid=fixture.uid,count=len(all_series)))
            sets=viewer.evaluate("uid=>services.displaySetService.getActiveDisplaySets().filter(d=>d.StudyInstanceUID===uid).map(d=>d.SeriesInstanceUID)",fixture.uid)
            self.assertEqual(set(sets),set(all_series))
            folder=Path(__file__).parent/'artifacts';folder.mkdir(exist_ok=True)
            viewer.screenshot(path=str(folder/(self._testMethodName+f'-series-{index}.png')))
        finally:viewer.close()

    def test_d02e_01_each_thumbnail_opens_its_real_series(self):
        """SERIES/WRONG: one real CT study, two distinct series, both retained in the viewer."""
        fixture=self.multiple("D02E-"+uuid.uuid4().hex[:16],"current","20260801")
        originals=self.originals();rows=self.report_rows(fixture)
        page=self.login();self.select(page,fixture);self.thumbs(page)
        reps=self.representatives(self.metadata(page,fixture));self.assertEqual(len(reps),2)
        writes=self.source_writes(page)
        # Open the non-default metadata order first; the exact actual image identity decides success.
        for index in (1,0):self.open_series(page,index,fixture,reps[index],[x['series'] for x in reps])
        self.assertEqual(writes,[]);self.assertEqual(self.report_rows(fixture),rows);self.assertEqual(self.originals(),originals)

    def test_d02e_02_related_series_keeps_current_report_and_explicit_return(self):
        """CONTEXT/REPORT: series viewing never changes the currently authored report."""
        patient="D02E-"+uuid.uuid4().hex[:16]
        current=self.multiple(patient,"current","20260801");related=self.multiple(patient,"future","20260907")
        self.seed_report(current);self.seed_report(related,action="approve")
        values=dict(findings="D02E draft findings",conclusion="D02E draft conclusion",recommendation="D02E draft recommendation")
        self.assertEqual(self.stack.request("PUT",f"/studies/{current.uid}/report","doctor",dict(values,baseVersion=1)).status,200)
        self.assertEqual(self.stack.request("POST",f"/studies/{current.uid}/hold","doctor").status,201)
        originals=self.originals();rows={f.uid:self.report_rows(f) for f in (current,related)}
        page=self.login();self.select(page,current);self.related(page,related).click();self.thumbs(page)
        expect(page.locator('#prior-findings')).to_have_text(related.secret)
        reps=self.representatives(self.metadata(page,related));writes=self.source_writes(page)
        self.open_series(page,1,related,reps[1],[x['series'] for x in reps])
        expect(page.locator(f'#rows tr[data-uid="{current.uid}"]')).to_have_class(re.compile(r'\bsel\b'))
        expect(page.locator('#clinical')).to_contain_text('D03A future')
        for name,value in values.items():expect(page.locator('#'+name)).to_have_value(value)
        page.locator('#related-return').click();self.thumbs(page)
        expect(page.locator('#clinical')).to_contain_text('D03A current')
        reps=self.representatives(self.metadata(page,current))
        self.open_series(page,1,current,reps[1],[x['series'] for x in reps])
        self.assertEqual(self.state(current)['holder'],self.stack.actor('doctor'));self.assertEqual(writes,[])
        for f in (current,related):self.assertEqual(self.report_rows(f),rows[f.uid])
        self.assertEqual(self.originals(),originals)

    def test_d02e_03_cached_page_stale_handler_and_missing_series_guard(self):
        """BOUND/STALE: response-only pagination checks identity plumbing, not 25-series image loading."""
        current,related=self.pair();originals=self.originals()
        page=self.login();self.select(page,current);self.thumbnail_ready(page)
        template=self.metadata(page,current)[0];series=[generate_uid() for _ in range(25)]
        variant={'value':'many'};gets=[]
        def metadata(route):
            gets.append(route.request.url);items=[]
            for uid in (series if variant['value']=='many' else [variant['value']]):
                item=copy.deepcopy(template);item['0020000E']={'vr':'UI','Value':[uid]};items.append(item)
            route.fulfill(status=200,json=items)
        pattern=f'**/dicom-web/studies/{current.uid}/instances'
        page.route(pattern,metadata);self.addCleanup(page.unroute,pattern)
        page.evaluate('() => { window.d02eCalls=[]; openFilmbox=(...args)=>d02eCalls.push(args); }')
        self.refresh(page);self.thumbs(page,24)
        page.locator('#thumb-next').click();self.thumbs(page,1)
        expect(page.locator('#thumb-range')).to_have_text('시리즈 25–25 / 25')
        page.locator('#thumbwrap img').dblclick();self.assertEqual(page.evaluate('d02eCalls'),[[current.uid,None,series[24]]])
        page.locator('#thumb-prev').click();self.thumbs(page,24)
        self.assertEqual(len(gets),1,'Cached paging must not refetch instance metadata')
        page.evaluate("window.d02eOld=document.querySelector('#thumbwrap img')")
        self.select(page,related);self.thumbnail_ready(page);page.evaluate('d02eOld.ondblclick()')
        self.assertEqual(page.evaluate('d02eCalls'),[[current.uid,None,series[24]]])
        # Reload restores the real opener; missing/malformed metadata must not silently open a default series.
        page.reload();page.wait_for_selector('#rows tr[data-uid]')
        self.select(page,current)
        opened=[];page.context.on('page',lambda p:opened.append(p))
        for invalid in ('','1..2?unexpected'):
            variant['value']=invalid;self.refresh(page);self.thumbs(page,1)
            page.locator('#thumbwrap img').dblclick()
            expect(page.locator('body')).to_contain_text('시리즈 정보를 확인할 수 없어 열지 않았습니다')
        self.assertEqual(opened,[]);self.assertEqual(self.originals(),originals)


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(ThumbnailSeriesE2E(name) for name in loader.getTestCaseNames(ThumbnailSeriesE2E)
                              if name.startswith('test_d02e_'))

if __name__=='__main__':unittest.main(verbosity=2)
