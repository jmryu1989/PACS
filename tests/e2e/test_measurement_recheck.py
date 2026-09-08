# coding: utf-8
"""D-MEASURE2 A3/A4: original replacement recovery and fresh native editing."""
import io, json, math, sys, unittest, uuid, hashlib
import numpy as np
from pydicom import dcmread
from test_measurement_panel import MeasurementPanelE2E, expect
from test_viewer_history import base, literal
from viewer_precision_support import canvas_ready


class MeasurementRecheckE2E(MeasurementPanelE2E):
    def test_recheck_01_editing_recalculation_recovers_both_sr_commands(self):
        f = self.specimen(); p = self.observed(f)
        row, panel = self.tracked(p)
        row.get_by_role('button', name='저장', exact=True).click(); expect(row).to_contain_text('저장 완료')
        head = self.saved(f)[0]
        item = {k:v for k,v in head['item'].items() if k not in ['hidden','sourceDigest']}
        item['baseline']['values'][0] += 10
        response = self.stack.request('POST', '/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions', 'doctor',
            dict(requestId=str(uuid.uuid4()), expectedRevision=1, action='edit', item=item))
        self.assertEqual(response.status, 200, response.text)
        p.get_by_role('button', name='새로고침', exact=True).click()
        expect(row).to_contain_text('재계산 값이 저장 당시와 다릅니다')
        p.evaluate('''()=>{
            panelAnnotation=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');
            panelCaptured=__d05c1.services.measurementService.getMeasurements();
        }''')
        row.get_by_role('button', name='편집', exact=True).click()
        self.assertTrue(p.evaluate('()=>panelAnnotation.data.kinUnverified'))
        # Hold native calculation, not the guard: changed handles alone cannot recover.
        p.evaluate('''()=>{
            const v=cornerstone.getEnabledElements()[0].viewport;
            panelTool=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId).getToolInstance('Length');
            panelCalc=panelTool._calculateCachedStats; panelThrottle=panelTool._throttledCalculateCachedStats;
            panelTool._calculateCachedStats=()=>{}; panelTool._throttledCalculateCachedStats=()=>{};
            panelAnnotation.data.handles.points[1][0]+=3; panelAnnotation.invalidated=false; v.render();
        }''')
        expect(panel).to_contain_text('재확인 필요')
        self.assertEqual(self.csv(p)[0]['Verification'], '재확인 필요')
        for command in ['downloadReport','storeMeasurements']:
            self.assertIn('재확인 필요', self.sr(p, command)['error'])
        p.evaluate('''()=>{
            panelTool._calculateCachedStats=panelCalc; panelTool._throttledCalculateCachedStats=panelThrottle;
            panelAnnotation.invalidated=true; cornerstone.getEnabledElements()[0].viewport.render();
        }''')
        expect(panel).to_contain_text('mm'); expect(panel).not_to_contain_text('재확인 필요')
        expect(p.locator('svg.svg-layer')).to_contain_text('mm')
        points = p.evaluate('()=>panelAnnotation.data.handles.points')
        self.assertAlmostEqual(float(self.csv(p)[0]['Length']), math.dist(*points), places=8)
        for command in ['downloadReport','storeMeasurements']:
            result = self.sr(p, command); self.assertIn('report', result, result)
        # manualSr already saves the fresh edit before preparing its document.
        expect(row).to_contain_text('저장됨 r3')
        saved = self.saved(f)[0]
        self.assertEqual(saved['item']['points'], points)
        self.assertAlmostEqual(saved['item']['baseline']['values'][0], math.dist(*points), places=8)

    def test_recheck_02_replaced_original_retains_draft_and_new_viewer_saves_fresh_measurement(self):
        f = self.specimen(slices=2); w,p = self.open_viewer(f)
        self.addCleanup(w.close); self.addCleanup(p.close)
        row = self.draw_length(p)
        row.get_by_role('button', name='저장', exact=True).click(); expect(row).to_contain_text('저장 완료')
        head = self.saved(f)[0]; baseline = self.state(f), self.versions(f); originals = self.hashes()
        row.get_by_role('button', name='편집', exact=True).click(); row.get_by_label('주석 문구').fill('원본 변경 중 보존할 내 수정')
        old_pixel = p.evaluate('''()=>{const v=cornerstone.getEnabledElements()[0].viewport;
            return cornerstone.cache.getImage(v.getCurrentImageId()).getPixelData()[0];}''')
        hits = self.stack._orthanc_request('POST','/tools/lookup',head['item']['sopUid'].encode()).body
        self.assertEqual(len(hits), 1); instance = hits[0]['ID']; path = '/instances/'+instance
        raw = self.stack.orthanc_bytes(path+'/file'); ds = dcmread(io.BytesIO(raw))
        self.assertIn(f.uid, self.stack.active); self.assertEqual(str(ds.StudyInstanceUID),f.uid)
        self.assertTrue(str(ds.PatientID).startswith('READBACK-'))
        ds.PixelData = (ds.pixel_array.astype(np.uint16)+37).astype('<u2').tobytes()
        stream = io.BytesIO(); ds.save_as(stream, write_like_original=False); replacement = stream.getvalue()
        self.assertNotEqual(hashlib.md5(raw).hexdigest(), hashlib.md5(replacement).hexdigest())
        def replace(expected, updated):
            # Only this run's exact synthetic instance may be replaced. Keeping
            # a second slice also preserves its parent Orthanc study/series.
            self.assertIn(f.uid, self.stack.active)
            self.assertEqual(self.stack.orthanc_bytes(path+'/file'), expected)
            self.assertEqual(self.stack._orthanc_request('DELETE',path).status,200)
            response = self.stack._orthanc_request('POST','/instances',updated)
            self.assertEqual(response.status,200,response.text)
            self.assertEqual(self.stack.orthanc_bytes(path+'/file'),updated)
        replace(raw,replacement)
        try:
            with p.expect_response(lambda r:r.request.method=='POST' and r.url.endswith('/revisions')) as response:
                row.get_by_role('button', name='저장', exact=True).click()
            self.assertEqual(response.value.status,409)
            expect(row.get_by_role('button',name='저장',exact=True)).to_be_disabled()
            expect(row.get_by_label('주석 문구')).to_have_value('원본 변경 중 보존할 내 수정')
            self.assertEqual(self.saved(f)[0]['revision'],head['revision'])
            self.assertEqual(self.saved(f)[0]['item'],head['item'])
            posts=[]; p.on('request', lambda r: posts.append(r.url) if r.method=='POST' and '/viewer-items' in r.url else None)
            for _ in range(2):
                with p.expect_response(lambda r:r.request.method=='GET' and '/viewer-items?' in r.url):
                    row.get_by_role('button',name='원본 다시 확인',exact=True).click()
            self.assertEqual(posts,[])
            with p.context.expect_page() as popup:
                row.get_by_role('link',name='새 뷰어에서 재측정').click()
            q=popup.value; self.addCleanup(q.close); canvas_ready(q,1)
            expect(q.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목')
            # The new tab must really fetch new pixels, rather than calculate on
            # the old tab's cached image and merely attach a new server digest.
            new_pixel=q.evaluate('''()=>{const v=cornerstone.getEnabledElements()[0].viewport;
                return cornerstone.cache.getImage(v.getCurrentImageId()).getPixelData()[0];}''')
            self.assertEqual(new_pixel,old_pixel+37)
            fresh=self.draw_length(q)
            fresh.get_by_role('button',name='저장',exact=True).click(); expect(fresh).to_contain_text('저장 완료')
            heads=self.saved(f); self.assertEqual(len(heads),2)
            new=next(h for h in heads if h['id']!=head['id'])
            self.assertEqual(new['referenceStatus'],'verified')
            self.assertEqual(new['item']['sourceDigest'],hashlib.md5(replacement).hexdigest())
            self.assertEqual(next(h for h in heads if h['id']==head['id'])['item'],head['item'])
            expect(row.get_by_label('주석 문구')).to_have_value('원본 변경 중 보존할 내 수정')
            self.assertTrue(p.evaluate('()=>window.kinViewerHistoryHasUnsaved()'))
        finally: replace(replacement,raw)
        self.assertEqual(self.hashes(),originals)
        self.assertEqual((self.state(f),self.versions(f)),baseline)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    names=[name for name in dir(MeasurementRecheckE2E) if name.startswith('test_recheck_')]
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(MeasurementRecheckE2E(name) for name in names))
    sys.exit(not result.wasSuccessful())
