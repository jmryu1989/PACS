# coding: utf-8
"""TEST-D04-MANUAL-PANEL: pinned OHIF panel and numeric export boundary."""
import sys, unittest, csv, io, math
from unittest.mock import patch
import test_viewer_history as history
from test_measurement_readback import MeasurementReadbackE2E, expect


def numeric_values(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'NumericValue': yield float(item)
            else: yield from numeric_values(item)
    elif isinstance(value, list):
        for item in value: yield from numeric_values(item)


class MeasurementPanelE2E(MeasurementReadbackE2E):
    def observed(self, f):
        hook = history.hook.replace('preRegistration({servicesManager})',
            'preRegistration({servicesManager, commandsManager})').replace(
            'window.__d05c1.services=servicesManager.services;',
            'window.__d05c1.services=servicesManager.services; window.__d05c1.commands=commandsManager;'
            'window.__d05c1.originalMeasurements=servicesManager.services.measurementService.getMeasurements;')
        with patch.object(history, 'hook', hook):
            w, p = self.open_viewer(f, observer=True)
        self.addCleanup(w.close); self.addCleanup(p.close)
        return p

    def tracked(self, p):
        row = self.draw_length(p)
        p.get_by_role('button', name='Yes', exact=True).click()
        p.locator('[data-cy=trackedMeasurements-btn]').click()
        panel = p.locator('[data-cy=trackedMeasurements-panel]')
        expect(panel).to_contain_text('mm')
        p.evaluate('''()=>{
            window.panelAnnotation=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');
            window.panelCaptured=__d05c1.services.measurementService.getMeasurements();
            window.panelReport=panelCaptured[0].getReport;
        }''')
        return row, panel

    def csv(self, p):
        with p.expect_download() as download:
            p.locator('[data-cy=trackedMeasurements-panel]').get_by_text('CSV', exact=True).click()
        return list(csv.DictReader(io.StringIO(download.value.path().read_text(encoding='utf-8'))))

    def sr(self, p, command='downloadReport'):
        # Exercise the product's guarded server-generated download. Storage and
        # independent binary readback are covered by test_manual_sr.py; there
        # is no synthetic TEST_CAPTURED storage exception in this path now.
        return p.evaluate('''async command=>{
            try {
                const report=await __d05c1.commands.runCommand(command, {measurementData:panelCaptured}, 'CORNERSTONE_STRUCTURED_REPORT');
                return {report};
            } catch(e) {return {error:e.message};}
        }''', command)

    def test_01_panel_and_csv_gate(self):
        f = self.specimen(); p = self.observed(f)
        original = self.hashes(); before = self.state(f), self.versions(f)
        _, panel = self.tracked(p)
        good = self.csv(p)
        self.assertEqual(len(good), 1); self.assertGreater(float(good[0]['Length']), 0)
        # Simulate the already-tested saved-baseline mismatch signal. This
        # test specifically observes the native panel and real CSV download.
        p.evaluate('''()=>{panelAnnotation.data.kinUnverified=true; cornerstone.getEnabledElements()[0].viewport.render();}''')
        expect(p.locator('svg.svg-layer')).to_contain_text('재확인 필요')
        expect(panel).to_contain_text('재확인 필요')
        expect(panel).not_to_contain_text('mm')
        bad = self.csv(p)
        self.assertEqual(bad[0]['Verification'], '재확인 필요')
        self.assertNotIn('Length', bad[0]); self.assertNotIn('Unit', bad[0])
        self.assertEqual(p.evaluate('()=>panelReport().values'), ['재확인 필요'])
        for command in ['storeMeasurements', 'downloadReport']:
            result = self.sr(p, command)
            self.assertNotIn('report', result, result)
            self.assertIn('재확인 필요', result.get('error',''), result)
        # SR identifies native annotations by UID. A copied selection's missing
        # toolName must not bypass the current native annotation check.
        p.evaluate('()=>panelCaptured=panelCaptured.map(({toolName,...m})=>m)')
        self.assertIn('재확인 필요', self.sr(p)['error'])
        p.evaluate('''()=>{panelAnnotation.data.kinUnverified=false; cornerstone.getEnabledElements()[0].viewport.render();}''')
        expect(panel).to_contain_text('mm'); expect(panel).not_to_contain_text('재확인 필요')
        self.assertEqual(self.csv(p)[0]['Length'], good[0]['Length'])
        # A valid cache with unsupported image calibration must also fail.
        p.evaluate('''()=>{const m=cornerstone.metaData.get('instance',panelAnnotation.metadata.referencedImageId);
            m.PixelSpacingCalibrationType='FIDUCIAL';}''')
        expect(panel).to_contain_text('재확인 필요')
        self.assertEqual(self.csv(p)[0]['Verification'], '재확인 필요')
        self.assertIn('재확인 필요', self.sr(p)['error'])
        p.evaluate("()=>delete cornerstone.metaData.get('instance',panelAnnotation.metadata.referencedImageId).PixelSpacingCalibrationType")
        expect(panel).to_contain_text('mm')
        self.assertEqual((self.state(f), self.versions(f)), before)
        self.assertEqual(self.hashes(), original)

    def test_02_stale_geometry_and_recovery(self):
        f = self.specimen(); p = self.observed(f)
        _, panel = self.tracked(p)
        old = float(self.csv(p)[0]['Length'])
        p.evaluate('''()=>{
            const v=cornerstone.getEnabledElements()[0].viewport;
            const t=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId).getToolInstance('Length');
            window.panelTool=t; window.panelCalc=t._calculateCachedStats; window.panelThrottle=t._throttledCalculateCachedStats;
            t._throttledCalculateCachedStats=()=>{}; t._calculateCachedStats=()=>{};
            panelAnnotation.data.cachedStats['volumeId:removed']={length:999,unit:'mm'};
            panelAnnotation.data.handles.points[1][0]+=3;
            panelAnnotation.invalidated=false; v.render();
        }''')
        expect(panel).to_contain_text('재확인 필요'); expect(panel).not_to_contain_text('mm')
        self.assertEqual(p.evaluate('()=>panelReport().values'), ['재확인 필요'])
        self.assertEqual(self.csv(p)[0]['Verification'], '재확인 필요')
        self.assertIn('재확인 필요', self.sr(p)['error'])
        p.evaluate('''()=>{
            panelTool._calculateCachedStats=panelCalc; panelTool._throttledCalculateCachedStats=panelThrottle;
            panelAnnotation.invalidated=true; cornerstone.getEnabledElements()[0].viewport.render();
        }''')
        expect(panel).to_contain_text('mm'); expect(panel).not_to_contain_text('재확인 필요')
        points=p.evaluate('()=>panelAnnotation.data.handles.points')
        actual=float(self.csv(p)[0]['Length'])
        self.assertNotEqual(actual, old); self.assertAlmostEqual(actual, math.dist(*points), places=8)
        captured=p.evaluate('()=>panelReport()')
        self.assertEqual(captured['values'][captured['columns'].index('Length')], actual)
        self.assertIn('report', self.sr(p))

    def test_03_valid_sr_and_ended_session(self):
        f = self.specimen(); p = self.observed(f)
        self.tracked(p)
        result = self.sr(p)
        self.assertIn('report', result, result)
        self.assertNotIn('error', result, result)
        self.assertEqual(result['report']['Modality'], 'SR')
        expected = math.dist(*p.evaluate('()=>panelAnnotation.data.handles.points'))
        self.assertTrue(any(abs(value-expected)<.001 for value in numeric_values(result['report'])))
        p.evaluate("()=>window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended',newValue:'test'}))")
        self.assertEqual(p.evaluate('()=>panelReport().values'), ['재확인 필요'])
        for command in ['downloadReport', 'storeMeasurements']:
            result = self.sr(p, command)
            self.assertNotIn('report', result, result)
            self.assertIn('다시 로그인한 뒤 뷰어를 여세요', result['error'])
        self.assertTrue(p.evaluate('''()=>{
            const plugin=window.config.extensions.find(e=>e.id==='kin.viewer-history');
            const before=__d05c1.commands.getCommand('storeMeasurements','CORNERSTONE_STRUCTURED_REPORT');
            plugin.onModeExit();
            return __d05c1.services.measurementService.getMeasurements===__d05c1.originalMeasurements &&
                __d05c1.commands.getCommand('storeMeasurements','CORNERSTONE_STRUCTURED_REPORT')!==before;
        }'''))

    def test_04_mixed_tools_and_missing_display_set(self):
        f = self.specimen(); p = self.observed(f)
        _, panel = self.tracked(p)
        for index, (tool, label) in enumerate([('Angle','수동 각도'), ('EllipticalROI','수동 ROI')]):
            p.get_by_role('button', name=label, exact=True).click()
            box=p.locator('.cornerstone-canvas').bounding_box()
            x,y=box['x']+box['width']*.4,box['y']+box['height']*(.43+index*.15)
            p.mouse.move(x,y); p.mouse.down(); p.mouse.move(x+65,y+32,steps=10); p.mouse.up()
            if tool=='Angle': p.mouse.move(x+85,y-15,steps=8); p.mouse.click(x+85,y-15)
            try:
                p.wait_for_function('''tool=>{const v=cornerstone.getEnabledElements()[0].viewport;
                    const t=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId).getToolInstance(tool);
                    return !t.isDrawing && cornerstoneTools.annotation.state.getAllAnnotations().some(a=>
                        a.metadata.toolName===tool && !a.invalidated && Object.keys(a.data.cachedStats).length);
                }''',arg=tool,timeout=5000)
            except Exception:
                print('MIXED TOOL',tool,p.evaluate('''()=>cornerstoneTools.annotation.state.getAllAnnotations().map(a=>({tool:a.metadata.toolName,points:a.data.handles?.points,invalidated:a.invalidated,stats:a.data.cachedStats}))'''))
                print(p.locator('#kin-viewer-history').inner_text())
                raise
        expect(panel).to_contain_text('Measurements (3)')
        expect(panel).not_to_contain_text('재확인 필요')
        rows=self.csv(p)
        self.assertEqual(len(rows),3)
        self.assertEqual({r['AnnotationType'] for r in rows},
            {'Cornerstone:Length','Cornerstone:Angle','Cornerstone:EllipticalROI'})
        p.evaluate('''()=>{
            window.panelEllipse=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='EllipticalROI');
            panelEllipse.data.kinUnverified=true;
            panelCaptured=__d05c1.services.measurementService.getMeasurements();
        }''')
        expect(panel).to_contain_text('재확인 필요')
        rows=self.csv(p)
        self.assertEqual(sum(r.get('Verification')=='재확인 필요' for r in rows),1)
        self.assertTrue(any(r.get('Length') and float(r['Length'])>0 for r in rows))
        self.assertTrue(any(r.get('Angle (°)') and float(r['Angle (°)'])>0 for r in rows))
        self.assertIn('재확인 필요',self.sr(p)['error'])
        p.evaluate('()=>panelEllipse.data.kinUnverified=false')
        try:
            expect(panel).not_to_contain_text('재확인 필요')
        except Exception:
            print('ELLIPSE RECOVERY',p.evaluate('''()=>({same:cornerstoneTools.annotation.state.getAnnotation(panelEllipse.annotationUID)===panelEllipse,
              annotations:cornerstoneTools.annotation.state.getAllAnnotations().map(a=>({uid:a.annotationUID,tool:a.metadata.toolName,invalidated:a.invalidated,data:a.data})),
              history:document.querySelector('#kin-viewer-history').innerText})'''))
            raise
        sr=self.sr(p); self.assertIn('report',sr,sr)
        values=list(numeric_values(sr['report']))
        points=p.evaluate('''()=>Object.fromEntries(cornerstoneTools.annotation.state.getAllAnnotations()
            .filter(a=>['Length','Angle','EllipticalROI'].includes(a.metadata.toolName))
            .map(a=>[a.metadata.toolName,a.data.handles.points]))''')
        first,vertex,last=points['Angle']
        u=[a-b for a,b in zip(first,vertex)]; v=[a-b for a,b in zip(last,vertex)]
        angle=math.degrees(math.acos(sum(a*b for a,b in zip(u,v))/math.hypot(*u)/math.hypot(*v)))
        bottom,top,left,right=points['EllipticalROI']
        area=math.pi*math.dist(bottom,top)*math.dist(left,right)/4
        for expected in [math.dist(*points['Length']),angle,area]:
            self.assertTrue(any(abs(value-expected)<.001 for value in values),(expected,values))
        # A vanished display set must withhold only the affected measurement,
        # not throw out of the whole native panel's getMeasurements call.
        p.evaluate('''()=>{
            const ds=__d05c1.services.displaySetService;
            window.panelLookup=ds.getDisplaySetForSOPInstanceUID;
            ds.getDisplaySetForSOPInstanceUID=()=>undefined;
        }''')
        expect(panel).to_contain_text('재확인 필요')
        self.assertEqual(p.evaluate('()=>__d05c1.services.measurementService.getMeasurements().length'),3)
        self.assertEqual(p.evaluate('()=>panelReport().values'),['재확인 필요'])
        p.evaluate('()=>__d05c1.services.displaySetService.getDisplaySetForSOPInstanceUID=panelLookup')
        expect(panel).not_to_contain_text('재확인 필요')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    suite = unittest.TestSuite(MeasurementPanelE2E(name) for name in [
        'test_01_panel_and_csv_gate',
        'test_02_stale_geometry_and_recovery',
        'test_03_valid_sr_and_ended_session',
        'test_04_mixed_tools_and_missing_display_set',
    ])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(not result.wasSuccessful())
