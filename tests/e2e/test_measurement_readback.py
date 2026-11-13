# coding: utf-8
"""TEST-D04-MANUAL-READBACK: real saved receipts, source verification and UI."""
from pathlib import Path
import sys, json, unittest, uuid, subprocess
import math
from unittest.mock import patch
import test_viewer_history as history
from test_viewer_history import ViewerHistoryE2E, synthetic_ct, expect, literal, base
from test_worklist import ROOT


class MeasurementReadbackE2E(ViewerHistoryE2E):
    def specimen(self, slices=1):
        return synthetic_ct(self.stack, 'READBACK-'+uuid.uuid4().hex[:12], 'readback',
                            '20260908', [0, 0, 0], [1, 0, 0, 0, 1, 0], [.7, 1.3], slices=slices)

    def draw_length(self, p):
        self.open_measurement_tools(p)
        p.locator('#kin-viewer-history').get_by_role('button', name='Length', exact=True).click()
        box = p.locator('.cornerstone-canvas').bounding_box()
        x, y = box['x']+box['width']*.4, box['y']+box['height']*.4
        p.mouse.move(x, y); p.mouse.down(); p.mouse.move(x+65, y+32, steps=10); p.mouse.up()
        p.wait_for_function('''()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>
            a.metadata.toolName==='Length' && !a.invalidated && Object.values(a.data.cachedStats||{}).some(s=>Number.isFinite(s.length)))''')
        return p.locator('#kin-viewer-history section[data-kind=length]').last

    # What the measuring tools hold: [tool, points, distinct points] per mark, the list rows, the unsaved guard, and
    # whether a tool is still waiting for a press (the pinned interaction lock).
    DRAWINGS = '''()=>{const names=['Length','Angle','EllipticalROI'];
        const all=cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>names.includes(a.metadata.toolName));
        return {marks:all.map(a=>[a.metadata.toolName,a.data.handles.points.length,new Set(a.data.handles.points.map(String)).size]),
          rows:[...document.querySelectorAll('#kin-viewer-history section[data-kind] strong')].map(s=>s.textContent),
          unsaved:window.kinViewerHistoryHasUnsaved(),waiting:cornerstoneTools.state.isInteractingWithTool===true,
          selected:cornerstoneTools.annotation.selection.getAnnotationsSelected().length}}'''
    NOTHING = dict(marks=[], rows=[], unsaved=False, waiting=False, selected=0)

    def choose(self, p, name):
        p.locator('#kin-viewer-history').get_by_role('button', name=name, exact=True).click()

    def still_press(self, p, x, y):
        # The pinned viewer delivers a still press about 400 ms late (it waits to tell a double click).
        n = p.evaluate('()=>cornerstoneTools.annotation.state.getAllAnnotations().length')
        p.mouse.move(x, y); p.mouse.click(x, y)
        p.wait_for_function('n=>cornerstoneTools.annotation.state.getAllAnnotations().length>n&&cornerstoneTools.state.isInteractingWithTool===true', arg=n, timeout=10000)

    def finishing_press(self, p, x, y):
        p.mouse.move(x, y, steps=8); p.mouse.click(x, y)
        p.wait_for_function('()=>cornerstoneTools.state.isInteractingWithTool===false', timeout=10000)

    def drag(self, p, x, y, dx=65, dy=32):
        p.mouse.move(x, y); p.mouse.down(); p.mouse.move(x+dx, y+dy, steps=10); p.mouse.up()

    def settled(self, p):
        # Two rounds of the panel's own observation, so a row that should not appear has had its chance to.
        p.wait_for_timeout(600)
        return p.evaluate(self.DRAWINGS)

    def clear_drawn(self, p):
        p.evaluate('''()=>{for(const a of cornerstoneTools.annotation.state.getAllAnnotations())if(['Length','Angle','EllipticalROI'].includes(a.metadata.toolName)){
            cornerstoneTools.annotation.selection.setAnnotationSelected(a.annotationUID,false);cornerstoneTools.annotation.state.removeAnnotation(a.annotationUID);}
            cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').forEach(e=>e.render());}''')
        expect(p.locator('#kin-viewer-history section[data-kind]')).to_have_count(0)
        self.assertEqual(p.evaluate(self.DRAWINGS), self.NOTHING)

    def image_index(self, p):
        return p.evaluate("()=>cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails')[0].getViewports()[0].getCurrentImageIdIndex()")

    def test_01_lost_receipt_replay_keeps_verified_measurement(self):
        f = self.specimen(); w, p = self.open_viewer(f)
        self.addCleanup(w.close); self.addCleanup(p.close)
        original = self.hashes(); before = self.state(f), self.versions(f)
        row = self.draw_length(p); seen = []
        def lost(route):
            seen.append(route.request.post_data)
            response = route.fetch(); self.assertEqual(response.status, 200)
            route.abort('failed')
        p.route('**/viewer-items', lost)
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('저장 결과를 확인하지 못했습니다')
        self.assertEqual(len(self.saved(f)), 1)
        def rows():
            return base.psql(f'''SELECT to_jsonb(t)::text FROM "ViewerRevision" t
                WHERE "itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={literal(f.uid)})''')
        persisted = rows()
        p.unroute('**/viewer-items', lost)
        with p.expect_response(lambda r: r.request.method=='POST' and r.url.endswith('/viewer-items')) as response:
            row.get_by_role('button', name='Retry Request').click()
        receipt = response.value
        self.assertEqual(receipt.request.post_data, seen[0])
        self.assertEqual(receipt.json().get('referenceStatus'), 'verified')
        expect(row).to_contain_text('저장 완료')
        expect(p.locator('svg.svg-layer')).to_contain_text('mm')
        expect(p.locator('svg.svg-layer')).not_to_contain_text('재확인 필요')
        self.assertEqual(rows(), persisted)
        self.assertEqual((self.state(f), self.versions(f)), before)
        self.assertEqual(self.hashes(), original)

    def test_02_unverified_receipt_reports_saved_and_withholds_annotation(self):
        f = self.specimen(); w, p = self.open_viewer(f)
        self.addCleanup(w.close); self.addCleanup(p.close)
        row = self.draw_length(p)
        # A UI-only transport fault; server fault coverage is in test_03.
        def unverified(route):
            response = route.fetch(); self.assertEqual(response.status, 200)
            body = response.json(); body['referenceStatus'] = 'unverified'
            route.fulfill(response=response, json=body)
        p.route('**/viewer-items', unverified)
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('저장 완료')
        expect(row).to_contain_text('재확인 필요')
        expect(row.get_by_role('button', name='Edit', exact=True)).to_be_disabled()
        self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').length"), 0)
        self.assertEqual(len(self.saved(f)), 1)
        p.unroute('**/viewer-items', unverified)
        p.get_by_role('button', name='Refresh', exact=True).click()
        expect(p.locator('svg.svg-layer')).to_contain_text('mm')
        expect(row.get_by_role('button', name='Edit', exact=True)).to_be_enabled()
        # A hidden-head conflict may hold local edits while restore's response
        # is unverified. Refresh must recover those edits, not discard them.
        row.get_by_role('button', name='Edit', exact=True).click()
        row.get_by_label('Annotation Text').fill('보관한 내 수정')
        head = self.saved(f)[0]
        item = {k:v for k,v in head['item'].items() if k not in ['hidden', 'sourceDigest']}
        hidden = self.stack.request('POST', '/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions', 'doctor',
            dict(requestId=str(uuid.uuid4()), expectedRevision=head['revision'], action='hide', reason='다른 창 숨김', item=item))
        self.assertEqual(hidden.status, 200, hidden.text)
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('서버에 다른 판')
        row.get_by_role('button', name='Use Latest & Keep Changes').click()
        p.route('**/viewer-items/*/revisions', unverified)
        p.once('dialog', lambda dialog: dialog.accept('보관한 수정 복원'))
        row.get_by_role('button', name='Restore', exact=True).click()
        expect(row).to_contain_text('미저장 수정은 보관 중')
        expect(row).to_contain_text('재확인 필요')
        self.assertTrue(p.evaluate('()=>window.kinViewerHistoryHasUnsaved()'))
        self.assertFalse(p.evaluate("()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))"))
        p.unroute('**/viewer-items/*/revisions', unverified)
        waiting = []
        def unverified_list(route): waiting.append(route)
        p.route('**/viewer-items?*', unverified_list)
        p.get_by_role('button', name='Refresh', exact=True).click()
        for _ in range(100):
            if waiting: break
            p.wait_for_timeout(50)
        self.assertEqual(len(waiting), 1, 'The unverified refresh must actually be pending')
        expect(p.locator('#kin-viewer-history > [role=status]')).to_have_text('저장 항목 확인 중…')
        expect(row).to_contain_text('미저장 수정은 보관 중')
        self.assertTrue(p.evaluate('()=>window.kinViewerHistoryHasUnsaved()'))
        route = waiting.pop(); response = route.fetch(); body = response.json()
        for head in body['items']: head['referenceStatus'] = 'unverified'
        route.fulfill(response=response, json=body)
        # The held-draft text already existed before Refresh. Await this read's
        # completion before removing its fault or issuing the verified refresh.
        expect(p.locator('#kin-viewer-history > [role=status]')).to_contain_text('1개 저장 항목')
        expect(row).to_contain_text('미저장 수정은 보관 중')
        self.assertTrue(p.evaluate('()=>window.kinViewerHistoryHasUnsaved()'))
        p.unroute('**/viewer-items?*', unverified_list)
        p.get_by_role('button', name='Refresh', exact=True).click()
        expect(row.get_by_label('Annotation Text')).to_have_value('보관한 내 수정')
        expect(row).to_contain_text('보관한 수정은 아직 미저장')
        expect(p.locator('svg.svg-layer')).to_contain_text('mm')
        row.get_by_role('button', name='Save', exact=True).click()
        expect(row).to_contain_text('Saved r4')
        self.assertEqual(self.saved(f)[0]['item']['label'], '보관한 내 수정')

    def test_03_bounded_list_replay_and_current_permission(self):
        f = self.specimen(slices=8)
        original = self.hashes(); before = self.state(f), self.versions(f)
        institution = base.psql(f'SELECT "institutionId" FROM "StudyState" WHERE uid={literal(f.uid)}')[0]
        # This separate Node process uses the compiled product services and real
        # Prisma/Orthanc. Only its own HTTP transport is fault injected.
        payload = dict(uid=f.uid, caller=dict(sub=self.stack.user_ids['doctor'],
            actor=self.stack.actor('doctor'), institution=institution,
            kind='member', roles=['radiologist']))
        script = (Path(__file__).parents[1]/'viewer_readback_fault.cjs').read_text(encoding='utf-8')
        run = subprocess.run(['docker', 'compose', 'exec', '-T', 'api', 'node'], cwd=ROOT,
            input='const fixture = '+json.dumps(payload)+';\n'+script,
            text=True, encoding='utf-8', capture_output=True, timeout=70)
        self.assertEqual(run.returncode, 0, run.stdout+'\n'+run.stderr)
        self.assertIn('READBACK PASS', run.stdout)
        self.assertEqual((self.state(f), self.versions(f)), before)
        self.assertEqual(self.hashes(), original)

    def test_04_verified_restore_preserves_dragged_geometry(self):
        f=self.specimen(); w,p=self.open_viewer(f)
        self.addCleanup(w.close); self.addCleanup(p.close)
        row=self.draw_length(p)
        row.get_by_role('button',name='Save',exact=True).click(); expect(row).to_contain_text('저장 완료')
        head=self.saved(f)[0]; old=head['item']['points']
        row.get_by_role('button',name='Edit',exact=True).click()
        xy=p.evaluate('''()=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');
            const v=cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails')[0].getViewports()[0];
            const point=v.worldToCanvas(a.data.handles.points[1]),box=v.element.getBoundingClientRect();
            return [point[0]+box.x,point[1]+box.y];}''')
        p.mouse.move(*xy); p.mouse.down(); p.mouse.move(xy[0]+35,xy[1]+15,steps=12); p.mouse.up()
        p.wait_for_function('''old=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');
            return a&&!a.invalidated&&JSON.stringify(a.data.handles.points)!==JSON.stringify(old)}''',arg=old)
        changed=p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length').data.handles.points")
        self.assertNotEqual(changed,old)
        item={k:v for k,v in head['item'].items() if k not in ['hidden','sourceDigest']}
        hidden=self.stack.request('POST','/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions','doctor',
            dict(requestId=str(uuid.uuid4()),expectedRevision=1,action='hide',reason='합성 다른 창 숨김',item=item))
        self.assertEqual(hidden.status,200,hidden.text)
        row.get_by_role('button',name='Save',exact=True).click(); expect(row).to_contain_text('서버에 다른 판')
        row.get_by_role('button',name='Use Latest & Keep Changes').click()
        # Settle the hidden-head scan, or accept an implementation that removes
        # it immediately. The retained annotation used to carry the old points.
        p.wait_for_function('''old=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');
            return !a||JSON.stringify(a.data.handles.points)===JSON.stringify(old)}''',arg=old)
        p.once('dialog',lambda d:d.accept('보관 좌표 복원'))
        row.get_by_role('button',name='Restore',exact=True).click(); expect(row).to_contain_text('보관한 수정은 아직 미저장')
        p.wait_for_function('''points=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');
            return a&&!a.invalidated&&JSON.stringify(a.data.handles.points)===JSON.stringify(points)}''',arg=changed,timeout=5000)
        expect(p.locator('svg.svg-layer')).to_contain_text('mm')
        row.get_by_role('button',name='Save',exact=True).click(); expect(row).to_contain_text('Saved r4')
        saved=self.saved(f)[0]['item']; self.assertEqual(saved['points'],changed)
        self.assertAlmostEqual(saved['baseline']['values'][0],math.dist(*changed),places=5)

    def test_05_a_length_is_drawn_by_a_drag_or_by_press_move_press(self):
        # The pinned tool draws a Length by a drag, or by a press, a move and a second press. Between the two presses
        # the line is a drawing, not a measurement: on the image, not in the list, not unsaved work.
        f=self.specimen(); w,p=self.open_viewer(f)
        self.addCleanup(w.close); self.addCleanup(p.close)
        self.choose(p,'Length')
        box=p.locator('.cornerstone-canvas').bounding_box()
        x,y=box['x']+box['width']*.35,box['y']+box['height']*.3
        self.still_press(p,x,y)
        self.assertEqual(self.settled(p),dict(marks=[['Length',2,1]],rows=[],unsaved=False,waiting=True,selected=1))
        expect(p.locator('svg.svg-layer')).to_contain_text('측정을 완료하세요')
        # Its free end follows the pointer; still no row and nothing unsaved.
        p.mouse.move(x+65,y+32,steps=10)
        p.wait_for_function("()=>{const a=cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length');return a&&String(a.data.handles.points[0])!==String(a.data.handles.points[1])}")
        self.assertEqual(self.settled(p),dict(marks=[['Length',2,2]],rows=[],unsaved=False,waiting=True,selected=1))
        # The second press ends it: unsaved work the moment the tool reports it, before the panel has listed it.
        p.evaluate("()=>{window.guardAtEnd=[];cornerstone.eventTarget.addEventListener(cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED,()=>guardAtEnd.push(window.kinViewerHistoryHasUnsaved()))}")
        self.finishing_press(p,x+65,y+32)
        self.assertEqual(p.evaluate('()=>guardAtEnd'),[True])
        expect(p.locator('#kin-viewer-history section[data-kind=length]')).to_have_count(1)
        p.wait_for_function("()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='Length'&&!a.invalidated&&Object.values(a.data.cachedStats||{}).some(s=>Number.isFinite(s.length)&&s.length>0))")
        self.assertEqual(self.settled(p),dict(marks=[['Length',2,2]],rows=['Length · Unsaved'],unsaved=True,waiting=False,selected=1))
        expect(p.locator('svg.svg-layer')).to_contain_text('mm'); expect(p.locator('svg.svg-layer')).not_to_contain_text('측정을 완료하세요')
        # A drag draws the second one as before, listed only when the button is released.
        p.mouse.move(x,y+120); p.mouse.down(); p.mouse.move(x+65,y+152,steps=10)
        self.assertEqual(self.settled(p)['rows'],['Length · Unsaved'])
        p.mouse.up()
        expect(p.locator('#kin-viewer-history section[data-kind=length]')).to_have_count(2)
        # A drag brought back to the point it began at ends with two equal points: no measurement, nothing listed.
        p.mouse.move(x+140,y+60); p.mouse.down(); p.mouse.move(x+170,y+80,steps=6); p.mouse.move(x+140,y+60,steps=6); p.mouse.up()
        state=self.settled(p)
        self.assertEqual([state['marks'],state['rows'],state['waiting']],[[['Length',2,2],['Length',2,2]],['Length · Unsaved','Length · Unsaved'],False])
        self.assertEqual(self.saved(f),[])

    def test_06_refused_measurement_gives_its_reason_and_no_general_error(self):
        # A measurement the image cannot support is refused with its reason. The refusal is not a fault of the
        # viewer: nothing is raised and the pinned viewer's general error notice stays away.
        f=self.specimen(); w,p=self.open_viewer(f)
        self.addCleanup(w.close); self.addCleanup(p.close)
        # The pinned viewer cancels window error events for its own notice; record them as they happen.
        p.evaluate("()=>{window.refusalErrors=[];addEventListener('error',e=>refusalErrors.push(String(e.error?.stack||e.message)),true)}")
        # Fault injection into the display metadata only; source DICOM stays intact.
        spacing=p.evaluate('''()=>{const v=cornerstone.getEnabledElements()[0].viewport;
            const m=cornerstone.metaData.get('instance',v.getCurrentImageId());const old=m.PixelSpacing;m.PixelSpacing=null;return old;}''')
        p.locator('#kin-viewer-history').get_by_role('button', name='Length', exact=True).click()
        box=p.locator('.cornerstone-canvas').bounding_box()
        x,y=box['x']+box['width']*.4,box['y']+box['height']*.4
        p.mouse.move(x,y); p.mouse.down(); p.mouse.move(x+50,y+25,steps=6); p.mouse.up()
        expect(p.locator('#kin-viewer-history > [role=status]')).to_contain_text('간격')
        # The pinned notice appears a moment after a raised error; give it that moment.
        p.wait_for_timeout(1000)
        self.assertEqual([p.get_by_text('Something went wrong').count(),p.evaluate('()=>refusalErrors')],[0,[]])
        lengths="()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').length"
        self.assertEqual(p.evaluate(lengths),0)
        self.assertIsNot(p.evaluate('()=>cornerstoneTools.state?.isInteractingWithTool??null'),True)
        # With the spacing back the same drag measures.
        p.evaluate('''spacing=>{const v=cornerstone.getEnabledElements()[0].viewport;
            cornerstone.metaData.get('instance',v.getCurrentImageId()).PixelSpacing=spacing;}''',spacing)
        p.mouse.move(x,y); p.mouse.down(); p.mouse.move(x+50,y+25,steps=6); p.mouse.up()
        p.wait_for_function('''()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>
            a.metadata.toolName==='Length' && !a.invalidated && Object.values(a.data.cachedStats||{}).some(s=>Number.isFinite(s.length)))''')
        self.assertEqual(p.evaluate(lengths),1)
        self.assertEqual(p.evaluate('()=>refusalErrors'),[])
        self.assertEqual(self.saved(f),[])

    def test_07_an_unfinished_ellipse_or_angle_is_not_a_measurement(self):
        f=self.specimen(); w,p=self.open_viewer(f)
        self.addCleanup(w.close); self.addCleanup(p.close)
        box=p.locator('.cornerstone-canvas').bounding_box()
        x,y=box['x']+box['width']*.35,box['y']+box['height']*.3
        # Ellipse: one press is its centre and nothing more; no reason is given for a shape that is not there yet.
        self.choose(p,'Ellipse ROI'); self.still_press(p,x,y)
        self.assertEqual(self.settled(p),dict(marks=[['EllipticalROI',4,1]],rows=[],unsaved=False,waiting=True,selected=1))
        expect(p.locator('svg.svg-layer')).to_contain_text('측정을 완료하세요'); expect(p.locator('svg.svg-layer')).not_to_contain_text('지원하지 않습니다')
        self.finishing_press(p,x+50,y+35)
        expect(p.locator('#kin-viewer-history section[data-kind=ellipse]')).to_have_count(1)
        self.assertEqual(self.settled(p),dict(marks=[['EllipticalROI',4,4]],rows=['Ellipse ROI · Unsaved'],unsaved=True,waiting=False,selected=1))
        self.clear_drawn(p)
        # Angle: after its first arm it still waits for the last point. That state is a drawing too.
        self.choose(p,'Angle'); self.drag(p,x,y+110)
        p.wait_for_function("()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='Angle')")
        self.assertEqual(self.settled(p),dict(marks=[['Angle',2,2]],rows=[],unsaved=False,waiting=True,selected=1))
        p.evaluate("()=>{window.guardAtEnd=[];cornerstone.eventTarget.addEventListener(cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED,()=>guardAtEnd.push(window.kinViewerHistoryHasUnsaved()))}")
        self.finishing_press(p,x+85,y+95)
        self.assertEqual(p.evaluate('()=>guardAtEnd'),[True])
        expect(p.locator('#kin-viewer-history section[data-kind=angle]')).to_have_count(1)
        self.assertEqual(self.settled(p),dict(marks=[['Angle',3,3]],rows=['Angle · Unsaved'],unsaved=True,waiting=False,selected=1))
        self.assertEqual(self.saved(f),[])

    def test_08_an_unfinished_drawing_is_dropped_when_she_turns_away(self):
        # Escape, the wheel, another tool, another image and the end of the mode each drop the drawing, and the input
        # that follows does what it would do without one.
        f=self.specimen(slices=3); w,p=self.open_viewer(f)
        self.addCleanup(w.close); self.addCleanup(p.close)
        p.evaluate("()=>{window.turnErrors=[];addEventListener('error',e=>turnErrors.push(String(e.error?.stack||e.message)),true)}")
        box=p.locator('.cornerstone-canvas').bounding_box()
        x,y=box['x']+box['width']*.35,box['y']+box['height']*.3
        waiting=dict(marks=[['Length',2,1]],rows=[],unsaved=False,waiting=True,selected=1)
        def begin():
            self.choose(p,'Length'); self.still_press(p,x,y)
            self.assertEqual(p.evaluate(self.DRAWINGS),waiting)
        def draws_again():
            # The very next drag is a measurement of its own, not the end of the dropped line.
            self.drag(p,x,y+130)
            expect(p.locator('#kin-viewer-history section[data-kind=length]')).to_have_count(1)
            self.assertEqual(self.settled(p),dict(marks=[['Length',2,2]],rows=['Length · Unsaved'],unsaved=True,waiting=False,selected=1))
            self.clear_drawn(p)
        # Escape.
        begin(); p.keyboard.press('Escape')
        self.assertEqual(p.evaluate(self.DRAWINGS),self.NOTHING); draws_again()
        # The wheel: that first notch already moves the stack.
        p.mouse.move(x,y); start=self.image_index(p); p.mouse.wheel(0,240)
        p.wait_for_function('start=>cornerstone.getRenderingEngines().filter(e=>e.id!=="_thumbnails")[0].getViewports()[0].getCurrentImageIdIndex()!==start',arg=start)
        moved=self.image_index(p); begin(); p.mouse.wheel(0,-240)
        p.wait_for_function('moved=>cornerstone.getRenderingEngines().filter(e=>e.id!=="_thumbnails")[0].getViewports()[0].getCurrentImageIdIndex()!==moved',arg=moved)
        self.assertEqual(p.evaluate(self.DRAWINGS),self.NOTHING); draws_again()
        # Another tool chosen in the panel: the next drag starts that tool's drawing.
        begin(); self.choose(p,'Angle')
        self.assertEqual(p.evaluate(self.DRAWINGS),self.NOTHING)
        self.drag(p,x,y+130)
        p.wait_for_function("()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='Angle')")
        self.assertEqual(self.settled(p),dict(marks=[['Angle',2,2]],rows=[],unsaved=False,waiting=True,selected=1))
        # ... and Escape drops an Angle that waits for its last point.
        p.keyboard.press('Escape')
        self.assertEqual(p.evaluate(self.DRAWINGS),self.NOTHING)
        # A tool put aside without a press (as a shortcut does): gone within that same call.
        begin()
        self.assertEqual(p.evaluate('''()=>{const v=cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails')[0].getViewports()[0];
            const g=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId);g.setToolPassive('Length');
            const left=[cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').length,cornerstoneTools.state.isInteractingWithTool];
            g.setToolActive('Length',{bindings:[{mouseButton:cornerstoneTools.Enums.MouseBindings.Primary}]});return left;}'''),[0,False])
        self.assertEqual(p.evaluate(self.DRAWINGS),self.NOTHING); draws_again()
        # Another image by keyboard: dropped with the change, not left behind on the image she came from.
        begin(); here=self.image_index(p); p.keyboard.press('ArrowUp' if here>=2 else 'ArrowDown')
        p.wait_for_function('here=>cornerstone.getRenderingEngines().filter(e=>e.id!=="_thumbnails")[0].getViewports()[0].getCurrentImageIdIndex()!==here',arg=here)
        self.assertEqual(p.evaluate(self.DRAWINGS),self.NOTHING); draws_again()
        self.assertEqual(p.evaluate('()=>turnErrors'),[])
        # The end of the mode.
        begin()
        self.assertEqual(p.evaluate('''()=>{window.config.extensions.find(e=>e.id==='kin.viewer-history').onModeExit();
            return [cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').length,cornerstoneTools.state.isInteractingWithTool,
              cornerstoneTools.annotation.selection.getAnnotationsSelected().length,turnErrors];}'''),[0,False,0,[]])
        self.assertEqual(self.saved(f),[])

    def test_09_a_press_in_another_cell_drops_the_drawing_and_is_not_swallowed(self):
        f=self.specimen()
        hook=history.hook.replace('preRegistration({servicesManager})','preRegistration({servicesManager, commandsManager})').replace(
            'window.__d05c1.services=servicesManager.services;','window.__d05c1.services=servicesManager.services; window.__d05c1.commands=commandsManager;')
        with patch.object(history,'hook',hook): w,p=self.open_viewer(f,observer=True)
        self.addCleanup(w.close); self.addCleanup(p.close)
        # Two cells showing the same series.
        p.evaluate("()=>__d05c1.commands.runCommand('setViewportGridLayout',{numRows:1,numCols:2})")
        p.wait_for_function('()=>__d05c1.services.viewportGridService.getState().viewports.size===2')
        p.evaluate('''()=>{const g=__d05c1.services.viewportGridService,state=g.getState(),cells=[...state.viewports.values()];
            const shown=cells.find(c=>c.displaySetInstanceUIDs?.length).displaySetInstanceUIDs;
            for(const c of cells)if(!c.displaySetInstanceUIDs?.length)g.setDisplaySetsForViewport({viewportId:c.viewportId,displaySetInstanceUIDs:shown});}''')
        p.wait_for_function("()=>cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports()).filter(v=>v.type==='stack'&&v.getCurrentImageId()).length===2")
        cells=p.evaluate('''()=>{const s=__d05c1.services,active=s.viewportGridService.getActiveViewportId();
            return [...s.viewportGridService.getState().viewports.keys()].sort((a,b)=>(a===active?0:1)-(b===active?0:1)).map(id=>{
              const r=s.cornerstoneViewportService.getCornerstoneViewport(id).element.getBoundingClientRect();return {id,x:r.x,y:r.y,width:r.width,height:r.height};});}''')
        here,other=cells; self.assertEqual(len(cells),2)
        self.choose(p,'Length')
        x,y=here['x']+here['width']*.35,here['y']+here['height']*.3
        self.still_press(p,x,y)
        self.assertEqual(p.evaluate(self.DRAWINGS),dict(marks=[['Length',2,1]],rows=[],unsaved=False,waiting=True,selected=1))
        # A drag in the other cell: the waiting line is dropped and this drag is a measurement drawn there.
        ox,oy=other['x']+other['width']*.35,other['y']+other['height']*.55
        self.drag(p,ox,oy)
        expect(p.locator('#kin-viewer-history section[data-kind=length]')).to_have_count(1)
        self.assertEqual(self.settled(p),dict(marks=[['Length',2,2]],rows=['Length · Unsaved'],unsaved=True,waiting=False,selected=1))
        self.assertEqual(p.evaluate('()=>__d05c1.services.viewportGridService.getActiveViewportId()'),other['id'])
        self.assertEqual(self.saved(f),[])


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    suite = unittest.TestSuite(MeasurementReadbackE2E(name) for name in [
        'test_01_lost_receipt_replay_keeps_verified_measurement',
        'test_02_unverified_receipt_reports_saved_and_withholds_annotation',
        'test_03_bounded_list_replay_and_current_permission',
        'test_04_verified_restore_preserves_dragged_geometry',
        'test_05_a_length_is_drawn_by_a_drag_or_by_press_move_press',
        'test_06_refused_measurement_gives_its_reason_and_no_general_error',
        'test_07_an_unfinished_ellipse_or_angle_is_not_a_measurement',
        'test_08_an_unfinished_drawing_is_dropped_when_she_turns_away',
        'test_09_a_press_in_another_cell_drops_the_drawing_and_is_not_swallowed'])
    sys.exit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
