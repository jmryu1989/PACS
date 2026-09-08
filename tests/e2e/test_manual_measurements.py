# coding: utf-8
"""Manual measurement roundtrip on owned anisotropic CT; no physician acceptance."""
import copy, math, unittest, uuid, io
import numpy as np
from pydicom import dcmread
from test_viewer_history import ViewerHistoryE2E
from viewer_precision_fixture import synthetic_ct
from playwright.sync_api import expect


class ManualMeasurementE2E(ViewerHistoryE2E):
    def test_manual_roundtrip(self):
        f = synthetic_ct(self.stack, 'MANUAL-'+uuid.uuid4().hex[:12], 'manual',
                         '20260908', [0, 0, 0], [1, 0, 0, 0, 1, 0], [.7, 1.3], slices=1)
        original = self.hashes()
        self.addCleanup(lambda: self.assertEqual(self.hashes(), original))
        before = self.state(f), self.versions(f)
        w, p = self.open_viewer(f)
        self.addCleanup(w.close)
        self.addCleanup(p.close)
        snapshots = {}
        for index, (kind, tool, label) in enumerate([
                ('length', 'Length', '수동 길이'), ('angle', 'Angle', '수동 각도'),
                ('ellipse', 'EllipticalROI', '수동 ROI')]):
            p.get_by_role('button', name=label, exact=True).click()
            box = p.locator('.cornerstone-canvas').bounding_box()
            x, y = box['x']+box['width']*.38, box['y']+box['height']*.3+index*95
            p.mouse.move(x, y); p.mouse.down(); p.mouse.move(x+65, y+32, steps=10); p.mouse.up()
            if kind == 'angle':
                p.mouse.move(x+85, y-15, steps=8); p.mouse.click(x+85, y-15)
            p.wait_for_timeout(350)  # pinned native calculator's trailing 100 ms throttle
            p.wait_for_function('''tool => cornerstoneTools.annotation.state.getAllAnnotations().some(a =>
                a.metadata.toolName === tool && !a.invalidated && Object.keys(a.data.cachedStats || {}).length)''', arg=tool)
            a = p.evaluate('''tool => {const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName===tool);
                return {points:a.data.handles.points, stats:Object.values(a.data.cachedStats)[0]};}''', tool)
            if kind == 'length':
                self.assertAlmostEqual(a['stats']['length'], math.dist(*a['points']), places=5)
            if kind == 'angle':
                first, vertex, last = np.array(a['points'])
                u, v = first-vertex, last-vertex
                expected = math.degrees(math.acos(np.dot(u,v)/np.linalg.norm(u)/np.linalg.norm(v)))
                self.assertAlmostEqual(a['stats']['angle'], expected, places=5)
            if kind == 'ellipse':
                ds = dcmread(io.BytesIO(self.stack.orthanc_bytes(next(iter(original)))))
                bottom, top, left, right = np.array(a['points']); center = (bottom+top+left+right)/4
                u, v = right-left, bottom-top; ru, rv = np.linalg.norm(u)/2, np.linalg.norm(v)/2
                yy, xx = np.mgrid[:int(ds.Rows), :int(ds.Columns)]
                world = np.stack([xx*float(ds.PixelSpacing[1]), yy*float(ds.PixelSpacing[0]), np.zeros_like(xx)], axis=-1)
                d = world-center; mask = (d@(u/np.linalg.norm(u))/ru)**2+(d@(v/np.linalg.norm(v))/rv)**2 <= 1
                values = ds.pixel_array[mask].astype(float)*float(ds.RescaleSlope)+float(ds.RescaleIntercept)
                stats = {s['name']:s['value'] for s in a['stats']['statsArray']}
                self.assertEqual(stats['min'], values.min()); self.assertEqual(stats['max'], values.max())
                self.assertEqual(stats['count'], values.size)
                self.assertAlmostEqual(stats['mean'], values.mean(), places=5)
                self.assertAlmostEqual(a['stats']['area'], math.pi*ru*rv, delta=.01)
                self.assertIn('Min:', p.locator('body').inner_text())
            row = p.locator('#kin-viewer-history section[data-kind='+kind+']')
            row.get_by_label('주석 문구').fill('합성 '+kind)
            row.get_by_role('button', name='저장', exact=True).click()
            expect(row).to_contain_text('저장 완료')
            snapshots[kind] = a['points']
        heads = self.saved(f)
        self.assertEqual({h['item']['kind'] for h in heads}, set(snapshots))
        self.assertTrue(all(h['referenceStatus']=='verified' for h in heads))
        for head in heads:
            item = {k:v for k,v in head['item'].items() if k not in ('hidden', 'sourceDigest')}
            invalid = copy.deepcopy(item); invalid['points'][0][2] += 5
            response = self.stack.request('POST', '/studies/'+f.uid+'/viewer-items', 'doctor',
                {'requestId':str(uuid.uuid4()), 'item':invalid})
            self.assertEqual(response.status, 400, response.text)
            response = self.stack.request('POST', '/studies/'+f.uid+'/viewer-items', 'tech',
                {'requestId':str(uuid.uuid4()), 'item':item})
            self.assertEqual(response.status, 403, response.text)
        self.assertEqual(len(self.saved(f)), 3)
        p.close(); w.close()
        w, p = self.open_viewer(f)
        self.addCleanup(w.close); self.addCleanup(p.close)
        for kind, tool in [('length', 'Length'), ('angle', 'Angle'), ('ellipse', 'EllipticalROI')]:
            p.wait_for_function('''tool=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName===tool)''', arg=tool)
            points = p.evaluate('''tool=>cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName===tool).data.handles.points''', tool)
            self.assertEqual(points, snapshots[kind])
            try:
                p.wait_for_function('''tool=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>
                    a.metadata.toolName===tool && !a.invalidated && a.data.kinUnverified===false)''', arg=tool, timeout=5000)
            except Exception:
                print('REOPEN', tool, p.evaluate('''()=>cornerstoneTools.annotation.state.getAllAnnotations().map(a=>({tool:a.metadata.toolName,invalidated:a.invalidated,unverified:a.data.kinUnverified,stats:a.data.cachedStats}))'''), flush=True)
                print('BASELINES', [h['item'].get('baseline') for h in heads], flush=True)
                raise
        # A client may submit only a non-authoritative baseline witness. A
        # changed witness must never be presented as a valid recomputed value.
        head = next(h for h in heads if h['item']['kind']=='length')
        item = {k:v for k,v in head['item'].items() if k not in ('hidden', 'sourceDigest')}
        item['baseline']['values'][0] += 10
        response = self.stack.request('POST', '/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions', 'doctor',
            {'requestId':str(uuid.uuid4()), 'expectedRevision':head['revision'], 'action':'edit', 'item':item})
        self.assertEqual(response.status, 200, response.text)
        p.get_by_role('button', name='새로고침', exact=True).click()
        expect(p.locator('#kin-viewer-history section[data-kind=length]')).to_contain_text('재확인 필요')
        self.assertEqual((self.state(f), self.versions(f)), before)

    def test_metadata_gates(self):
        f = synthetic_ct(self.stack, 'GATE-'+uuid.uuid4().hex[:12], 'manual-gates',
                         '20260908', [0, 0, 0], [1, 0, 0, 0, 1, 0], [.7, 1.3], slices=1)
        w, p = self.open_viewer(f)
        self.addCleanup(w.close); self.addCleanup(p.close)
        # Fault injection into the display metadata only; source DICOM stays intact.
        for tool, field, value, message in [('수동 길이', 'PixelSpacing', None, '간격'), ('수동 ROI', 'RescaleType', 'OD', 'HU 보정')]:
            old = p.evaluate('''([field,value])=>{const v=cornerstone.getEnabledElements()[0].viewport;
                const m=cornerstone.metaData.get('instance',v.getCurrentImageId());const old=m[field];m[field]=value;return old;}''', [field,value])
            p.get_by_role('button', name=tool, exact=True).click()
            box=p.locator('.cornerstone-canvas').bounding_box();x,y=box['x']+box['width']*.4,box['y']+box['height']*.4
            p.mouse.move(x,y);p.mouse.down();p.mouse.move(x+50,y+25);p.mouse.up()
            expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text(message)
            annotations = p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().map(a=>a.metadata.toolName).filter(n=>['Length','Angle','EllipticalROI'].includes(n))")
            self.assertEqual(annotations,[],annotations)
            p.evaluate('''([field,value])=>{const v=cornerstone.getEnabledElements()[0].viewport;
                cornerstone.metaData.get('instance',v.getCurrentImageId())[field]=value;}''',[field,old])
        self.assertEqual(self.saved(f),[])
        p.get_by_role('button',name='수동 길이',exact=True).click()
        p.evaluate("()=>window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended',newValue:'test'}))")
        p.mouse.move(x,y);p.mouse.down();p.mouse.move(x+50,y+25);p.mouse.up()
        expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('로그인 확인')
        self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>['Length','Angle','EllipticalROI'].includes(a.metadata.toolName)).length"),0)


if __name__ == '__main__':
    import sys
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([
        ManualMeasurementE2E('test_manual_roundtrip'), ManualMeasurementE2E('test_metadata_gates')]))
    sys.exit(not result.wasSuccessful())
