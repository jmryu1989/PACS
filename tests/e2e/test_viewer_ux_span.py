# coding: utf-8
"""V-01 / U1-F1..F4 -> wrong target, lost work, clipped placement -> U1-T1..T4.

SpanBoundaryTests exercise the shipped geometry/registry APIs only. Synthetic
coordinates are request geometry, never evidence of physical spanning or DPI.
ViewerSpanE2E uses the real HTTPS workspace, API, DICOM and shipped OHIF. No
HTML assembly, controller replacement or fake renderer is used. U1-T4 remains
a physical three-monitor run (OS/browser/DPI, actual bounds and capture).
ViewerSpanEmulatedE2E uses CDP screen/window emulation under continuation 2;
that evidence is explicitly separate from physical-device acceptance.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]


class SpanBoundaryTests(unittest.TestCase):
    def node(self, script):
        node = os.environ.get('NODE') or shutil.which('node')
        if not node:
            self.fail('Node is required; set NODE to the installed executable')
        result = subprocess.run([node, '-e', script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_available_rectangles_preserve_negative_offset_gap_and_unequal_sizes(self):
        actual = self.node('''
          const m = require('./worklist-v0/hpacs-lite/viewer-display-layout.js');
          const screens = m.screens({screens: [
            {availLeft:-1920, availTop:-180, availWidth:1920, availHeight:1080},
            {availLeft:120, availTop:0, availWidth:2560, availHeight:1400}
          ]});
          console.log(JSON.stringify({rect:m.span(screens),reverse:m.span([...screens].reverse()),
            duplicate:m.span([screens[0],screens[0]]),single:m.span([screens[0]]),
            missing:m.span([screens[0],null])}));
        ''')
        expected = dict(left=-1920, top=-180, width=4600, height=1580)
        self.assertEqual(actual['rect'], expected)
        self.assertEqual(actual['reverse'], expected)
        self.assertIsNone(actual['duplicate'])
        self.assertIsNone(actual['single'])
        self.assertIsNone(actual['missing'])

    def test_display_edges_and_grid_split_are_exact_in_css_px(self):
        # 49t M-1: deterministic synthetic CSS geometry -> 0 px. Real-device rounding is recorded elsewhere.
        actual = self.node('''
          const m = require('./worklist-v0/hpacs-lite/viewer-display-layout.js');
          const landscape = [{left:-1920,top:0,width:1920,height:1080},{left:0,top:0,width:1920,height:1080}];
          // Owner PC measurement 2026-11-10: one window over both, 8px Windows frame a side.
          const desk = {screenX:-1920,screenY:0,outerWidth:3840,outerHeight:1040,innerWidth:3824,innerHeight:966};
          // Reading room: two portrait displays of unequal size and height offset.
          const portrait = [{left:0,top:0,width:1080,height:1920},{left:1080,top:-200,width:1200,height:1920}];
          const tall = {screenX:-8,screenY:-200,outerWidth:2296,outerHeight:1928,innerWidth:2280,innerHeight:1840};
          // Browser zoom 125%: CSS px are 1.25 DIPs; the OS scale is never applied again.
          const zoomed = {screenX:-1920,screenY:0,outerWidth:3840,outerHeight:1040,innerWidth:3059.2,innerHeight:772.8};
          console.log(JSON.stringify({
            desk:m.seams(landscape,desk,null), deskZoomKnown:m.seams(landscape,desk,1),
            split:m.split({left:284,right:3787},m.seams(landscape,desk,null)),
            portrait:m.seams(portrait,tall,null), zoomed:m.seams(landscape,zoomed,1.25),
            zoomUnknown:m.seams(landscape,zoomed,null),
            one:m.seams([landscape[1]],{screenX:0,screenY:0,outerWidth:1920,outerHeight:1040,innerWidth:1904,innerHeight:966},null),
            above:m.seams([{left:-1920,top:-1080,width:1920,height:1080}],desk,null),
            right:m.split({left:0,right:1000},[600]), quarter:m.split({left:0,right:1000},[200]), none:m.split({left:0,right:1000},[]),
            bad:m.seams(landscape,{screenX:NaN},null)}));
        ''')
        self.assertEqual(actual['desk'], [1912])
        self.assertEqual(actual['deskZoomKnown'], [1912])
        # Equal columns: the grid's middle lands on the seam; the longer side keeps the difference as margin.
        self.assertEqual(actual['split'], dict(seam=1912, left=0, right=247))
        self.assertEqual((284 + 3787 - 247) / 2, 1912)
        self.assertEqual(actual['portrait'], [1080])
        self.assertEqual(actual['zoomed'], [1529.6])
        self.assertEqual(actual['zoomUnknown'], [])
        self.assertEqual(actual['one'], [])
        self.assertEqual(actual['above'], [])
        self.assertEqual(actual['right'], dict(seam=600, left=200, right=0))
        self.assertIsNone(actual['quarter'])
        self.assertIsNone(actual['none'])
        self.assertEqual(actual['bad'], [])

    def test_single_window_ignores_saved_count_and_keeps_legacy_consumers(self):
        actual = self.node('''
          require('./tests/module_session_harness.cjs').install();
          const m = require('./worklist-v0/hpacs-lite/viewer-windows.js');
          const values = new Map(), url = n => '/ohif/viewer?StudyInstanceUIDs=1.2.'+n;
          const r = m.create({storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},
            owner:()=>'["site","reader"]',newId:()=> '00000000-0000-4000-8000-000000000001',
            origin:'https://localhost:9443',describe:p=>({kind:'viewer',href:p.href,ready:true})});
          const first = r.choose(url(1),4,{singleWindow:true});
          const a = {href:'https://localhost:9443'+url(1)}; r.attach(first,a);
          const reuse = r.choose(url(2),4,{singleWindow:true});
          const reload = r.choose(url(1),4,{singleWindow:true,freshDocument:true});
          const legacy = r.choose(url(2),4);
          const b = {href:'https://localhost:9443'+url(2)}; r.attach(legacy,b);
          const full = r.choose(url(3),4,{singleWindow:true});
          const found = r.choose(url(2),4,{singleWindow:true});
          const before = r.rows().map(row=>row.index);
          a.closed = true;
          const remaining = r.choose(url(3),4,{singleWindow:true});
          console.log(JSON.stringify({reuse:[reuse.index,reuse.fresh],reload:[reload.index,reload.fresh],
            full:!!full.full,found:found.index,before,remaining:[remaining.index,remaining.fresh],
            after:r.rows().map(row=>row.index)})); r.end();
        ''')
        self.assertEqual(actual, dict(reuse=[0, False], reload=[0, False], full=True,
                                     found=1, before=[0, 1], remaining=[1, False], after=[1]))


# The boundary-only CI invocation needs no browser/clinical fixture imports.
if '--boundary' not in sys.argv:
    from playwright.sync_api import expect
    from test_viewer_windows import ViewerWindowsE2E
    from test_prior_selection import canvas_ready

    class ViewerSpanE2E(ViewerWindowsE2E):
        def open_first(self, page, fixture):
            self.choose(page, fixture)
            with page.context.expect_page() as opened:
                page.locator('#m-filmbox').click()
            viewer = opened.value
            viewer.wait_for_url('**/ohif/viewer?**')
            self.loaded(viewer, fixture)
            return viewer

        def loaded(self, viewer, fixture):
            canvas_ready(viewer, 1)
            viewer.wait_for_function('() => typeof kinViewerJobWorkspaceState === "function" && !kinViewerJobWorkspaceState().busy && typeof kinViewerHistoryWorkspaceState === "function" && !kinViewerHistoryWorkspaceState().busy')
            self.assertEqual(self.ids(viewer), [fixture.uid])
            ids = viewer.evaluate("cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports().map(v=>v.getCurrentImageId?.())).filter(Boolean)")
            self.assertTrue(ids)
            self.assertTrue(all('/studies/' + fixture.uid + '/series/' in value for value in ids))

        def test_span_01_open_reuse_focus_close_reopen_preserves_workspace(self):
            a, b = self.pair()
            originals = self.originals()
            versions = {f.uid: self.versions(f) for f in [a, b]}
            p = self.sign_in(self.device())
            self.limit(p, 4)
            opened = []
            p.context.on('page', lambda page: opened.append(page))
            p.evaluate('''() => {const native=window.open;window.__u1OpenCalls=[];
              window.open=function(...args){__u1OpenCalls.push(args);return native.apply(this,args)};}''')
            viewer = self.open_first(p, a)
            workspace = p.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
            p.locator('#findings').fill('U1 WORKSPACE DRAFT')
            marker = viewer.evaluate('window.__u1Document = crypto.randomUUID()')
            p.locator('#m-filmbox').click()
            self.assertEqual(viewer.evaluate('__u1Document'), marker)
            self.manager(p)
            self.control(p, 0, 'focus').click()
            self.assertEqual(viewer.evaluate('__u1Document'), marker)
            self.assertEqual(p.evaluate('selectedUid'), a.uid)
            expect(p.locator('#findings')).to_have_value('U1 WORKSPACE DRAFT')
            for fixture in [b, a]:
                self.choose(p, fixture)
                p.locator('#m-filmbox').click()
                viewer.wait_for_url('**StudyInstanceUIDs=' + fixture.uid + '**')
                self.loaded(viewer, fixture)
            self.assertEqual(len(opened), 1)
            self.assertEqual(p.evaluate('__u1OpenCalls.length'), 1)
            self.assertEqual(p.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})'), workspace)
            expect(p.locator('#findings')).to_have_value('U1 WORKSPACE DRAFT')
            # Same-document focus and guarded latest-image refresh are distinct.
            viewer.evaluate('window.__u1Document = crypto.randomUUID()')
            self.manager(p)
            self.control(p, 0, 'latest').click()
            viewer.wait_for_function('() => !window.__u1Document')
            self.loaded(viewer, a)
            self.assertEqual(len(opened), 1)
            expect(p.locator('#viewer-windows-list')).to_contain_text('· Open ·')
            self.control(p, 0, 'close').click()
            expect(p.locator('.viewer-window-row')).to_have_count(0)
            self.assertTrue(viewer.is_closed())
            p.locator('#viewer-windows-done').click()
            self.close_toolbar_groups(p)
            viewer = self.open_first(p, a)
            self.assertEqual(len(opened), 2)
            self.assertEqual(p.evaluate('__u1OpenCalls.length'), 2)
            self.assertEqual(len(p.context.pages), 2)
            self.assertEqual(self.originals(), originals)
            self.assertEqual({f.uid: self.versions(f) for f in [a, b]}, versions)
            expect(p.locator('#findings')).to_have_value('U1 WORKSPACE DRAFT')
            self.capture(p, 'u1-single-window')

        def test_span_02_dirty_close_and_permission_denial_keep_targets(self):
            a, b = self.pair()
            p = self.sign_in(self.device())
            self.limit(p, 3)
            viewer = self.open_first(p, a)
            marker = viewer.evaluate('window.__u1Document = crypto.randomUUID()')
            viewer.get_by_role('button', name='Comparison', exact=True).click()
            viewer.get_by_label('Job Title', exact=True).fill('U1 UNSAVED JOB')
            self.choose(p, b)
            p.locator('#m-filmbox').click()
            expect(p.locator('#toast')).to_contain_text('저장하지 않은')
            self.loaded(viewer, a)
            self.assertEqual(viewer.evaluate('__u1Document'), marker)
            self.manager(p)
            self.control(p, 0, 'close').click()
            expect(p.locator('#viewer-windows-status')).to_contain_text('창을 닫지 않았습니다')
            self.control(p, 0, 'focus').click()
            self.assertEqual(p.evaluate('selectedUid'), b.uid)
            expect(viewer.get_by_label('Job Title', exact=True)).to_have_value('U1 UNSAVED JOB')
            # Actual browser permission denial, with no replacement of getScreenDetails.
            cdp = p.context.new_cdp_session(p)
            context_id = cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId']
            cdp.send('Browser.setPermission', dict(permission=dict(name='window-management'),
                     setting='denied', origin=self.stack.proxy, browserContextId=context_id))
            self.manager(p)
            p.locator('#viewer-windows-displays').click()
            expect(p.locator('#viewer-windows-status')).to_contain_text('직접 이동')
            self.assertEqual(viewer.evaluate('__u1Document'), marker)
            self.assertEqual(len(p.context.pages), 2)
            self.assertEqual(p.evaluate('selectedUid'), b.uid)
            expect(viewer.get_by_label('Job Title', exact=True)).to_have_value('U1 UNSAVED JOB')

    class ViewerSpanEmulatedE2E(ViewerSpanE2E):
        """Synthetic three-screen OS boundary; real served page, native windows.

        CDP screens feed window.screen/getScreenDetails and native move/resize.
        Geometry comes from U1's unequal/negative/gap boundary fixture, not a
        first-site minimum or a claim about physical monitors.
        """
        @classmethod
        def setUpClass(cls):
            super().setUpClass()
            probe = cls.browser.new_page()
            cdp = probe.context.new_cdp_session(probe)
            cls.emulated_screens = []
            cls.emulated_geometry = [dict(left=-4600, top=-180, width=1920, height=1080, devicePixelRatio=1),
                                     dict(left=-2560, top=0, width=2560, height=1400, devicePixelRatio=1.25)]
            for geometry in cls.emulated_geometry:
                cls.emulated_screens.append(cdp.send('Emulation.addScreen', geometry)['screenInfo'])
            probe.close()

        def device(self):
            context = self.browser.new_context(ignore_https_errors=True, no_viewport=True)
            self.contexts.append(context)
            self.window_requests = []
            context.expose_binding('__u1SetWindowBounds',
                                   lambda source, requested: self.window_requests.append((source['page'], requested)))
            # Headless Chromium's native resizeTo clamps to one virtual screen.
            # Emulate the OS window operations through CDP; the product still
            # calls its normal moveTo/resizeTo and reads the actual browser bounds.
            context.add_init_script("""(() => {
              const move=window.moveTo.bind(window),resize=window.resizeTo.bind(window);
              window.__u1RequestedBounds={};
              const request=bounds=>{Object.assign(window.__u1RequestedBounds,bounds);return window.__u1SetWindowBounds(bounds)};
              window.moveTo=(left,top)=>window.__u1NativeBounds ? move(left,top) : request({left,top});
              window.resizeTo=(width,height)=>window.__u1NativeBounds ? resize(width,height) : request({width,height});
            })()""")
            return context

        def flush_window_bounds(self, viewer, expected=None):
            # CDP commands must run outside the exposed-binding callback: a
            # synchronous command inside that callback blocks the browser reply.
            viewer.wait_for_function('''expected=>{
              const rect=window.__u1RequestedBounds;
              return rect && ['left','top','width','height'].every(key=>Number.isFinite(rect[key])) &&
                (!expected || Object.entries(expected).every(([key,value])=>rect[key]===value));
            }''',arg=expected)
            pending = {}
            while self.window_requests:
                page, bounds = self.window_requests.pop(0)
                pending.setdefault(page, {}).update(bounds)
            for page, bounds in pending.items():
                cdp = page.context.new_cdp_session(page)
                target = cdp.send('Browser.getWindowForTarget')
                cdp.send('Browser.setWindowBounds',dict(windowId=target['windowId'],bounds=bounds))
                cdp.detach()

        def open_first(self, page, fixture):
            viewer = super().open_first(page, fixture)
            self.flush_window_bounds(viewer)
            return viewer

        def test_span_03_emulated_three_screens_restore_move_and_reconnect(self):
            a, b = self.pair()
            p = self.sign_in(self.device())
            self.limit(p, 4)
            cdp = p.context.new_cdp_session(p)
            window = cdp.send('Browser.getWindowForTarget')
            cdp.send('Browser.setWindowBounds', dict(windowId=window['windowId'],
                     bounds=dict(left=0, top=0, width=800, height=600)))
            context_id = cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId']
            cdp.send('Browser.setPermission', dict(permission=dict(name='window-management'),
                     setting='granted', origin=self.stack.proxy, browserContextId=context_id))
            viewer = self.open_first(p, a)
            workspace = p.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
            p.locator('#findings').fill('EMULATED SPAN REPORT')
            marker = viewer.evaluate('window.__spanDocument = crypto.randomUUID()')
            viewer.get_by_role('button', name='Comparison', exact=True).click()
            viewer.get_by_label('Job Title', exact=True).fill('EMULATED SPAN JOB')
            self.manager(p)
            p.locator('#viewer-windows-displays').click()
            inventory = p.evaluate("""async () => {const d=await getScreenDetails();
              const rect=s=>({left:s.availLeft,top:s.availTop,width:s.availWidth,height:s.availHeight});
              return {screens:Array.from(d.screens,s=>({...rect(s),dpr:s.devicePixelRatio})),
              windowScreen:rect(window.screen),browser:navigator.userAgent,platform:navigator.platform}}""")
            targets = [screen for screen in inventory['screens'] if screen['left'] < 0]
            self.assertEqual(len(inventory['screens']), 3)
            self.assertEqual(len(targets), 2)
            self.assertEqual(inventory['windowScreen'], {k: next(t for t in inventory['screens'] if t['left']==0)[k] for k in ['left','top','width','height']})
            for number, target in enumerate(targets, 1):
                value = json.dumps([target[k] for k in ['left','top','width','height']], separators=(',', ':'))
                p.get_by_label('Viewer Display ' + str(number)).select_option(value)
            left, top = min(t['left'] for t in targets), min(t['top'] for t in targets)
            expected = dict(left=left,top=top,width=max(t['left']+t['width'] for t in targets)-left,
                            height=max(t['top']+t['height'] for t in targets)-top)
            p.get_by_role('button', name='Span Displays', exact=True).click()
            self.flush_window_bounds(viewer, expected)
            expect(p.locator('#viewer-windows-status')).to_have_text('지정 화면으로 이동하고 창 위치를 저장했습니다.')
            # Native bounds settle before OHIF finishes resizing its canvas.
            # Verify the real image again before accepting the spanning capture.
            self.loaded(viewer, a)
            actual = viewer.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
            for key in expected:
                self.assertLessEqual(abs(actual[key]-expected[key]), 16)
            self.assertEqual(viewer.evaluate('__spanDocument'), marker)
            self.assertEqual(self.ids(viewer), [a.uid])
            expect(viewer.get_by_label('Job Title', exact=True)).to_have_value('EMULATED SPAN JOB')
            expect(p.locator('#findings')).to_have_value('EMULATED SPAN REPORT')
            self.assertEqual(p.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})'), workspace)
            self.assertEqual(len(p.context.pages), 2)
            folder = Path(os.environ.get('KIN_EVIDENCE_DIR', str(ROOT/'tmp/viewer-ux-u1/emulated')))
            folder.mkdir(parents=True, exist_ok=True)
            observed = dict(scope='CDP synthetic screens and window operations; not physical-device or physician acceptance',
                            inventory=inventory,workspace=workspace,requested=expected,actual=actual,
                            viewerWindow=viewer.context.new_cdp_session(viewer).send('Browser.getWindowForTarget'))
            viewer.screenshot(path=str(folder/'span-viewer.png'))
            p.screenshot(path=str(folder/'span-workspace.png'))
            (folder/'span-observed.json').write_text(json.dumps(observed,ensure_ascii=False,indent=2),encoding='utf-8')
            # Disconnect/reconnect screen metadata never navigates or clears live work.
            removed = self.emulated_screens[1]
            cdp.send('Emulation.removeScreen', dict(screenId=removed['id']))
            try:
                p.wait_for_function('async () => (await getScreenDetails()).screens.length===2')
                self.assertEqual(viewer.evaluate('__spanDocument'), marker)
                expect(viewer.get_by_label('Job Title', exact=True)).to_have_value('EMULATED SPAN JOB')
                self.assertEqual(p.evaluate("JSON.parse(localStorage.getItem('kin.ohif.current.rect'))"), actual)
            finally:
                # CDP returns CSS dimensions but addScreen takes physical input;
                # reusing the returned dimensions would apply the scale twice.
                self.emulated_screens[1] = cdp.send('Emulation.addScreen', self.emulated_geometry[1])['screenInfo']
            p.wait_for_function('async () => (await getScreenDetails()).screens.length===3')
            reconnected = p.evaluate('''async()=>Array.from((await getScreenDetails()).screens,
              s=>({left:s.availLeft,top:s.availTop,width:s.availWidth,height:s.availHeight,dpr:s.devicePixelRatio}))''')
            self.assertEqual(sorted(reconnected,key=lambda s:s['left']),sorted(inventory['screens'],key=lambda s:s['left']))
            observed['reconnectedScreens'] = reconnected
            self.assertEqual(viewer.evaluate('__spanDocument'), marker)
            viewer.get_by_label('Job Title', exact=True).fill('')
            viewer.wait_for_function('() => !kinViewerJobWorkspaceState().dirty')
            self.control(p, 0, 'close').click()
            self.assertTrue(viewer.is_closed())
            p.locator('#viewer-windows-done').click()
            self.close_toolbar_groups(p)
            restored = self.open_first(p, a)
            restored.wait_for_function("""expected => {
              const actual={left:screenX,top:screenY,width:outerWidth,height:outerHeight};
              return Object.entries(expected).every(([k,v])=>Math.abs(actual[k]-v)<=16)
            }""", arg=actual)
            self.loaded(restored, a)
            restored.screenshot(path=str(folder/'span-restored-viewer.png'))
            observed['restored'] = restored.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
            self.assertEqual(len(p.context.pages), 2)
            expect(p.locator('#findings')).to_have_value('EMULATED SPAN REPORT')
            self.assertEqual(p.evaluate('selectedUid'), a.uid)
            (folder/'span-observed.json').write_text(json.dumps(observed,ensure_ascii=False,indent=2),encoding='utf-8')
            print(json.dumps(observed,ensure_ascii=False),flush=True)

        def test_span_05_native_clamp_keeps_saved_position_and_manual_recovery(self):
            a, _ = self.pair()
            p = self.sign_in(self.device())
            self.limit(p, 4)
            cdp = p.context.new_cdp_session(p)
            cid = cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId']
            cdp.send('Browser.setPermission', dict(permission=dict(name='window-management'),
                     setting='granted',origin=self.stack.proxy,browserContextId=cid))
            viewer = self.open_first(p, a)
            initial = viewer.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
            p.wait_for_function("""expected=>{
              const saved=JSON.parse(localStorage.getItem('kin.ohif.current.rect'));
              return saved && Object.entries(expected).every(([k,v])=>saved[k]===v);
            }""",arg=initial)
            saved = p.evaluate("JSON.parse(localStorage.getItem('kin.ohif.current.rect'))")
            self.assertIsNotNone(saved)
            marker = viewer.evaluate('window.__clampDocument=crypto.randomUUID()')
            p.locator('#findings').fill('MANUAL SPAN REPORT')
            self.manager(p)
            p.locator('#viewer-windows-displays').click()
            targets = p.evaluate('''async()=>Array.from((await getScreenDetails()).screens,
              s=>({left:s.availLeft,top:s.availTop,width:s.availWidth,height:s.availHeight})).filter(s=>s.left<0)''')
            for number,target in enumerate(targets,1):
                value=json.dumps([target[k] for k in ['left','top','width','height']],separators=(',',':'))
                p.get_by_label('Viewer Display '+str(number)).select_option(value)
            viewer.evaluate('window.__u1NativeBounds=true')
            p.get_by_role('button',name='Span Displays',exact=True).click()
            expect(p.locator('#viewer-windows-status')).to_contain_text('이전 저장 위치를 유지')
            self.assertEqual(p.evaluate("JSON.parse(localStorage.getItem('kin.ohif.current.rect'))"),saved)
            self.assertEqual(viewer.evaluate('__clampDocument'),marker)
            # Explicit user resize/move through the browser OS boundary.
            left,top=min(t['left'] for t in targets),min(t['top'] for t in targets)
            manual=dict(left=left,top=top,width=max(t['left']+t['width'] for t in targets)-left,
                        height=max(t['top']+t['height'] for t in targets)-top)
            window=viewer.context.new_cdp_session(viewer)
            target=window.send('Browser.getWindowForTarget')
            window.send('Browser.setWindowBounds',dict(windowId=target['windowId'],bounds=manual))
            p.wait_for_function('''expected=>{
              const actual=JSON.parse(localStorage.getItem('kin.ohif.current.rect'));
              return actual && Object.entries(expected).every(([key,value])=>actual[key]===value);
            }''',arg=manual)
            self.loaded(viewer, a)
            self.capture(viewer, 'manual-span')
            self.assertEqual(viewer.evaluate('__clampDocument'),marker)
            self.assertEqual(self.ids(viewer),[a.uid])
            expect(p.locator('#findings')).to_have_value('MANUAL SPAN REPORT')
            self.assertEqual(len(p.context.pages),2)

    import uuid
    from test_thumbnail_series import ThumbnailSeriesE2E
    from document_session import document_request

    SEAM_STATE = r'''async () => {
      // Independent of the product: real getScreenDetails screens, this window's CSS px (zoom 1 here).
      const d = await getScreenDetails(), left = screenX + (outerWidth - innerWidth) / 2;
      const seams = [...new Set(Array.from(d.screens).flatMap(s => [s.left, s.left + s.width]))]
        .map(x => x - left).filter(x => x >= 1 && x <= innerWidth - 1);
      const rect = e => { if (!e) return null; const r = e.getBoundingClientRect();
        return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width}; };
      const grid = document.querySelector('[data-cy="viewport-grid"]');
      return {seams, window: {screenX, outerWidth, innerWidth, dpr: devicePixelRatio},
        grid: rect(grid), column: rect(grid?.parentElement),
        panes: [...document.querySelectorAll('[data-cy="viewport-pane"]')].map(rect),
        mirrors: [...document.querySelectorAll('.kin-span-mirror')].map(m => ({name: m.getAttribute('aria-label'), ...rect(m),
          controls: m.querySelectorAll('button').length})),
        rows: ['.kin-patient-tabs', '.kin-ux-toolbar', '.kin-viewer-series-strip'].map(s => {
          const e = document.querySelector(s); return {row: s, shown: !!e && e.getClientRects().length > 0}; }),
        tools: [...document.querySelectorAll('.kin-ux-toolbar > .kin-ux-tools-bar [data-tool]')].map(b => [b.dataset.tool, rect(b)]),
        hiddenRows: document.body.classList.contains('kin-second-display-rows-off')};
    }'''
    ACTIVE_TOOL = '''() => services.toolGroupService.getToolGroupForViewport(
      services.viewportGridService.getActiveViewportId()).getActivePrimaryMouseButtonTool()'''
    ACTIVE_SERIES = '''() => { const v = services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
      return cornerstone.metaData.get('instance', v?.getCurrentImageId?.())?.SeriesDescription || null; }'''

    class ViewerSpanSeamEmulatedE2E(ViewerSpanE2E):
        """49t M-1/M-2: one viewer window across two synthetic CDP displays (left, adjacent,
        negative coordinates, DPR 1) and a second viewer window of the same group. Real served
        viewer, real getScreenDetails and window bounds; still not physical-device evidence
        (that is tests/e2e/test_physical_monitors.py style on the owner's two monitors)."""
        @classmethod
        def setUpClass(cls):
            super().setUpClass()
            probe = cls.browser.new_page()
            cdp = probe.context.new_cdp_session(probe)
            cls.displays = [dict(left=-3840, top=0, width=1920, height=1080, devicePixelRatio=1),
                            dict(left=-1920, top=0, width=1920, height=1080, devicePixelRatio=1)]
            for geometry in cls.displays:
                cdp.send('Emulation.addScreen', geometry)
            probe.close()

        def device(self):
            context = self.browser.new_context(ignore_https_errors=True, no_viewport=True)
            self.contexts.append(context)
            return context

        def grant(self, page):
            cdp = page.context.new_cdp_session(page)
            cid = cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId']
            cdp.send('Browser.setPermission', dict(permission=dict(name='window-management'), setting='granted',
                     origin=self.stack.proxy, browserContextId=cid))

        def bounds(self, page, rect):
            cdp = page.context.new_cdp_session(page)
            window = cdp.send('Browser.getWindowForTarget')['windowId']
            cdp.send('Browser.setWindowBounds', dict(windowId=window, bounds=dict(windowState='normal')))
            cdp.send('Browser.setWindowBounds', dict(windowId=window, bounds=rect))
            cdp.detach()
            page.wait_for_function('r => screenX === r.left && outerWidth === r.width', arg=rect)

        def viewer(self, p, url, name):
            with p.context.expect_page() as opened:
                p.evaluate('([u, n]) => { window.open(u, n, "popup=yes,width=900,height=700"); }', [url, name])
            page = opened.value
            page.wait_for_url('**/ohif/viewer?**')
            return page

        def settings(self, page, shown):
            page.get_by_role('button', name='Viewer Settings', exact=True).click()
            dialog = page.get_by_role('dialog', name='Viewer Settings')
            box = dialog.get_by_label('Show Rows on Second Display', exact=True)
            expect(box).to_be_visible()
            box.set_checked(shown)
            dialog.get_by_role('button', name='Save', exact=True).click()
            expect(dialog).to_be_hidden()

        def until(self, page, predicate, arg=None):
            # On timeout the failure carries the observed geometry, not just the timeout.
            try:
                page.wait_for_function(predicate, arg=arg)
            except Exception:
                state = page.evaluate(SEAM_STATE)
                state['product'] = page.evaluate('''() => ({mounted: typeof KinViewerDisplaySpan, layout: typeof KinViewerDisplayLayout,
                  rule: [...document.head.querySelectorAll('style[data-kin-ux-owned]')].map(s => s.textContent).filter(Boolean),
                  screen: {availLeft: screen.availLeft, availWidth: screen.availWidth, extended: screen.isExtended},
                  win: [screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight, devicePixelRatio],
                  cells: [...services.viewportGridService.getState().viewports.values()].map(c => [c.x, c.y, c.width, c.height]),
                  dnd: window.__dnd || null})''')
                state['console'] = getattr(self, 'console_errors', [])
                self.fail('Waited for ' + predicate[:120] + '\n' + json.dumps(state, ensure_ascii=False))

        @staticmethod
        def kept(settings):
            # The dialog's Save writes every tool's key (unassigned ones as null): compare the assigned ones.
            return dict(bar=settings['bar'], shortcuts={k: v for k, v in settings['shortcuts'].items() if v})

        def stored(self, page):
            return document_request(page, 'GET', '/api/workspace-shortcuts').json()

        def test_span_06_seam_rows_copies_and_second_display_setting(self):
            current = ThumbnailSeriesE2E.multiple(self, 'SPAN49T-' + uuid.uuid4().hex[:10], 'current', '20260801')
            prior = ThumbnailSeriesE2E.multiple(self, current.patient_id, 'prior', '20250701')
            p = self.sign_in(self.device())
            self.grant(p)
            # An existing account record without the new key: it reads as shown; its tools/keys are kept.
            record = self.stored(p)
            custom = dict(bar=['WindowLevel', 'Pan', 'Zoom', 'StackScroll'], shortcuts={'Zoom': 'j'})
            put = document_request(p, 'PUT', '/api/workspace-shortcuts', headers={'X-KIN-CSRF': '1'}, data=dict(expectedOwner=record['owner'],
                                   revision=record['revision'], viewerSettings=dict(version=2, **custom)))
            self.assertEqual(put.status, 200, put.text())
            self.assertNotIn('secondDisplayTools', self.stored(p)['viewerSettings'])
            group = str(uuid.uuid4())
            url = (self.stack.proxy + '/ohif/viewer?StudyInstanceUIDs=' + current.uid + ',' + prior.uid +
                   '&hangingProtocolId=@ohif/hpCompare#kin-window-group=' + group + '&kin-window-slot=')
            first = self.viewer(p, url + '0', 'span49t-0')
            self.console_errors = []
            first.on('console', lambda m: self.console_errors.append(m.text[:200]) if m.type == 'error' else None)
            first.on('pageerror', lambda e: self.console_errors.append('pageerror ' + str(e)[:200]))
            canvas_ready(first, 4)
            left, right = self.displays
            # One display: the stock grid, no copy, no rule.
            self.bounds(first, dict(left=right['left'], top=0, width=1920, height=1080))
            self.until(first, '() => !document.querySelector(".kin-span-mirror")')
            single = first.evaluate(SEAM_STATE)
            self.assertEqual(single['seams'], [])
            self.assertLessEqual(abs(single['grid']['left'] - single['column']['left']), 1)
            self.assertLessEqual(abs(single['grid']['right'] - single['column']['right']), 1)
            # Across both displays: the middle column edge is on the seam; no cell crosses it.
            self.bounds(first, dict(left=left['left'], top=0, width=3840, height=1080))
            self.until(first, '() => document.querySelectorAll(".kin-span-mirror").length === 3')
            canvas_ready(first, 4)
            span = first.evaluate(SEAM_STATE)
            self.assertEqual(len(span['seams']), 1, span)
            seam = span['seams'][0]
            middle = (span['grid']['left'] + span['grid']['right']) / 2
            # CDP window geometry is integral DIP; allow one px of observed rounding (0 px is the boundary test).
            self.assertLessEqual(abs(middle - seam), 1, span)
            self.assertFalse([pane for pane in span['panes'] if pane['left'] < seam - 1 and pane['right'] > seam + 1], span)
            self.assertEqual({m['name'] for m in span['mirrors']},
                             {'Patients (Second Display)', 'Image Tools (Second Display)', 'Series (Second Display)'})
            for copy in span['mirrors']:
                self.assertGreaterEqual(copy['left'], seam - 1, copy)
                self.assertGreater(copy['controls'], 0, copy)
            # The original rows keep their place and buttons.
            self.assertEqual([tool for tool, _ in span['tools']], [tool for tool, _ in single['tools']])
            for (_, a), (_, b) in zip(span['tools'], single['tools']):
                self.assertEqual((a['left'], a['top']), (b['left'], b['top']))
            # The copies work: a tool, a series click, a series drag onto a cell.
            tools = first.get_by_role('group', name='Image Tools (Second Display)')
            tools.get_by_role('button', name='Zoom', exact=True).click()
            self.assertEqual(first.evaluate(ACTIVE_TOOL), 'Zoom')
            series = first.get_by_role('group', name='Series (Second Display)')
            series.locator('.kin-series-card').filter(has_text='D02E second series').click()
            first.wait_for_function('() => (' + ACTIVE_SERIES + ')() === "D02E second series"')
            # Drag from the copy onto the prior's cell on the second display (the original drop path assigns it).
            target = dict(x=seam + 200, y=span['grid']['top'] + 120)
            in_cell = '''([x, y, uid]) => [...services.viewportGridService.getState().viewports.keys()].some(id => {
              const v = services.cornerstoneViewportService.getCornerstoneViewport(id), r = v?.element?.getBoundingClientRect();
              if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
              const m = cornerstone.metaData.get('instance', v.getCurrentImageId?.());
              return m?.StudyInstanceUID === uid && m?.SeriesDescription === 'D02E second series'; })'''
            self.assertFalse(first.evaluate(in_cell, [target['x'], target['y'], current.uid]))
            first.evaluate('''() => { window.__dnd = []; for (const type of ['dragstart', 'dragenter', 'drop', 'dragend'])
              document.addEventListener(type, e => __dnd.push([type, String(e.target?.className || e.target?.nodeName).slice(0, 40), e.isTrusted,
                !!e.dataTransfer, e.defaultPrevented]), true); }''')
            # Grab the thumbnail, as test_viewer_tools does: a press on the card's text starts no dragover in headless Chromium.
            grip = series.locator('.kin-series-card').filter(has_text='D02E second series').locator('.kin-series-preview').bounding_box()
            first.mouse.move(grip['x'] + grip['width'] / 2, grip['y'] + grip['height'] / 2)
            first.mouse.down()
            first.mouse.move(target['x'], target['y'], steps=15)
            first.mouse.up()
            self.until(first, in_cell, [target['x'], target['y'], current.uid])
            patients = first.get_by_role('group', name='Patients (Second Display)')
            self.assertEqual(patients.get_by_role('tab').count(), first.locator('.kin-patient-tabs > [role=tablist] [role=tab]').count())
            # A second window of the group shows its rows by default and they work.
            second = self.viewer(p, url + '1', 'span49t-1')
            canvas_ready(second, 4)
            self.bounds(second, dict(left=right['left'], top=0, width=1920, height=1080))
            self.assertTrue(all(row['shown'] for row in second.evaluate(SEAM_STATE)['rows']))
            second.get_by_role('region', name='Image Tools', exact=True).get_by_role('button', name='Pan', exact=True).click()
            self.assertEqual(second.evaluate(ACTIVE_TOOL), 'Pan')
            # Off from the first window: copies go, the second window shows images only; the first keeps its rows.
            self.settings(first, False)
            self.until(first, '() => !document.querySelector(".kin-span-mirror")')
            second.wait_for_function('() => document.body.classList.contains("kin-second-display-rows-off")')
            self.assertFalse(any(row['shown'] for row in second.evaluate(SEAM_STATE)['rows']))
            off = first.evaluate(SEAM_STATE)
            self.assertTrue(all(row['shown'] for row in off['rows']))
            self.assertEqual(off['tools'], span['tools'])
            self.assertLessEqual(abs((off['grid']['left'] + off['grid']['right']) / 2 - seam), 1)
            saved = self.stored(p)
            self.assertIs(saved['viewerSettings']['secondDisplayTools'], False)
            self.assertEqual(self.kept(saved['viewerSettings']), custom)
            # Kept after reopening, in a new browser profile of the same account; another account is separate.
            again = self.sign_in(self.device())
            self.assertIs(self.stored(again)['viewerSettings']['secondDisplayTools'], False)
            other = self.sign_in(self.device(), 'tech')
            self.assertNotIn('secondDisplayTools', (self.stored(other)['viewerSettings'] or {}))
            # Back on from the first window: both return without reopening.
            self.settings(first, True)
            self.until(first, '() => document.querySelectorAll(".kin-span-mirror").length === 3')
            second.wait_for_function('() => !document.body.classList.contains("kin-second-display-rows-off")')
            self.assertTrue(all(row['shown'] for row in second.evaluate(SEAM_STATE)['rows']))
            on = self.stored(p)
            self.assertIs(on['viewerSettings']['secondDisplayTools'], True)
            self.assertEqual(self.kept(on['viewerSettings']), custom)
            # The second window followed the new revision: its own save succeeds.
            self.settings(second, True)
            self.assertEqual(self.stored(p)['revision'], on['revision'] + 1)
            self.assertEqual(self.kept(self.stored(p)['viewerSettings']), custom)
            # A dialog already open keeps its revision: the other window's save makes it a conflict.
            first.wait_for_timeout(1500)  # the first window reads the second window's revision (broadcast)
            second.get_by_role('button', name='Viewer Settings', exact=True).click()
            dialog = second.get_by_role('dialog', name='Viewer Settings')
            self.settings(first, False)
            first.wait_for_timeout(1500)  # the broadcast reaches the second window while its dialog is open
            # The open form was read before that save: its Save meets the conflict, never reverts it.
            dialog.get_by_role('button', name='Save', exact=True).click()
            expect(dialog).to_be_visible()
            expect(dialog.get_by_role('status')).not_to_have_text('')
            self.assertIs(self.stored(p)['viewerSettings']['secondDisplayTools'], False)
            # Closing the dialog reads the newer revision it held back: the second window now follows Off.
            dialog.get_by_role('button', name='Cancel', exact=True).click()
            second.wait_for_function('() => document.body.classList.contains("kin-second-display-rows-off")')
            self.settings(first, True)
            self.until(first, '() => document.querySelectorAll(".kin-span-mirror").length === 3')
            second.wait_for_function('() => !document.body.classList.contains("kin-second-display-rows-off")')
            # Keys on a copied patient tab run the original tab's handler; focus stays on the copy's display.
            patients = first.get_by_role('group', name='Patients (Second Display)')
            patients.get_by_role('tab').first.focus()
            first.keyboard.press('Home')
            first.wait_for_function('''() => { const a = document.activeElement;
              return !!a?.closest('.kin-span-mirror') && a.getAttribute('role') === 'tab' && a.getAttribute('aria-selected') === 'true'; }''')
            # The copied list pages by itself and keeps its scroll when it is copied again.
            first.add_style_tag(content='.kin-span-mirror .kin-series-card { flex-basis: 1400px !important; width: 1400px !important; }')
            probe = '''value => { document.querySelector('.kin-viewer-series-strip > .kin-series-list').setAttribute('data-probe', value); }'''
            copied = '''value => document.querySelector('.kin-viewer-series-strip .kin-span-mirror .kin-series-list')?.dataset.probe === value'''
            first.evaluate(probe, '1'); first.wait_for_function(copied, arg='1')  # a change of the original list copies it again
            next_series = first.get_by_role('button', name='Next Series (Second Display)', exact=True)
            expect(next_series).to_be_visible()
            next_series.click()
            first.wait_for_function('() => document.querySelector(".kin-viewer-series-strip .kin-span-mirror .kin-series-list").scrollLeft > 0')
            scrolled = first.evaluate('() => document.querySelector(".kin-viewer-series-strip .kin-span-mirror .kin-series-list").scrollLeft')
            first.evaluate(probe, '2'); first.wait_for_function(copied, arg='2')
            self.assertEqual(first.evaluate('() => document.querySelector(".kin-viewer-series-strip .kin-span-mirror .kin-series-list").scrollLeft'), scrolled)
            # A tool dragged within the copied bar is moved by the original bar (saved to the account).
            revision = self.stored(p)['revision']
            tools.locator('[data-tool="StackScroll"]').drag_to(tools.locator('[data-tool="WindowLevel"]'))
            moved = None
            for _ in range(50):
                moved = self.stored(p)
                if moved['revision'] > revision:
                    break
                first.wait_for_timeout(200)
            self.assertEqual(moved['viewerSettings']['bar'][:2], ['StackScroll', 'WindowLevel'], moved['viewerSettings']['bar'])
            folder = Path(os.environ.get('KIN_EVIDENCE_DIR', str(ROOT / 'tmp/viewer-ux-u1/seam')))
            folder.mkdir(parents=True, exist_ok=True)
            first.screenshot(path=str(folder / 'seam-span-viewer.png'))
            (folder / 'seam-observed.json').write_text(json.dumps(dict(
                scope='CDP synthetic displays and window bounds; not physical-device evidence',
                single=single, span=span, off=off), ensure_ascii=False, indent=2), encoding='utf-8')

        def test_span_07_copied_patient_tabs_switch_and_close_keep_focus(self):
            # A switch or close from the copied tabs remounts the viewer; focus returns to the copy's selected tab.
            a = ThumbnailSeriesE2E.multiple(self, 'SPANTA-' + uuid.uuid4().hex[:10], 'tabs A', '20260801')
            b = ThumbnailSeriesE2E.multiple(self, 'SPANTB-' + uuid.uuid4().hex[:10], 'tabs B', '20260801')
            p = self.sign_in(self.device())
            self.grant(p)
            viewer = self.open_first(p, a)
            left, _ = self.displays
            self.bounds(viewer, dict(left=left['left'], top=0, width=3840, height=1080))
            self.until(viewer, '() => document.querySelectorAll(".kin-span-mirror").length === 3')
            self.choose(p, b)
            p.locator('#m-filmbox').click()
            copies = viewer.get_by_role('group', name='Patients (Second Display)')
            expect(copies.get_by_role('tab')).to_have_count(2, timeout=45000)
            focused = '''id => { const a = document.activeElement;
              return !!a?.closest('.kin-span-mirror') && a.getAttribute('role') === 'tab' &&
                a.getAttribute('aria-selected') === 'true' && a.textContent.includes(id); }'''
            copies.get_by_role('tab', selected=True).focus()
            viewer.keyboard.press('ArrowLeft')
            viewer.wait_for_function(focused, arg=a.patient_id, timeout=45000)
            self.assertIn(a.uid, viewer.url)
            viewer.keyboard.press('Delete')
            viewer.wait_for_function(focused, arg=b.patient_id, timeout=45000)
            expect(copies.get_by_role('tab')).to_have_count(1)
    from test_viewer_display_layout import ViewerDisplayLayoutE2E

    class ViewerSpanPhysicalE2E(ViewerDisplayLayoutE2E):
        def test_span_04_three_displays_restore_one_window(self):
            p, viewer, fixture, marker = self.setup_viewer()
            p.locator('#viewer-windows-displays').click()
            inventory = p.evaluate('''async () => {
              const details = await getScreenDetails();
              return {current:usableScreenRect(details.currentScreen),
                screens:Array.from(details.screens, s=>({...usableScreenRect(s),dpr:s.devicePixelRatio})),
                browser:navigator.userAgent,platform:navigator.platform};
            }''')
            targets = [s for s in inventory['screens'] if
                       {k: s[k] for k in ['left','top','width','height']} != inventory['current']]
            self.assertEqual(len(targets), 2, 'U1-T4 requires one workspace and two actual viewer displays')
            workspace = p.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
            for number, target in enumerate(targets, 1):
                value = json.dumps([target[k] for k in ['left','top','width','height']], separators=(',', ':'))
                p.get_by_label('Viewer Display ' + str(number)).select_option(value)
            left, top = min(t['left'] for t in targets), min(t['top'] for t in targets)
            expected = dict(left=left, top=top,
                            width=max(t['left']+t['width'] for t in targets)-left,
                            height=max(t['top']+t['height'] for t in targets)-top)
            p.get_by_role('button', name='Span Displays', exact=True).click()
            p.wait_for_function('() => !document.querySelector("[data-window-action=span]").disabled')
            actual = viewer.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
            folder = Path(os.environ.get('KIN_EVIDENCE_DIR', str(ROOT/'tmp/viewer-ux-u1/physical')))
            folder.mkdir(parents=True, exist_ok=True)
            observed = dict(inventory=inventory, workspace=workspace, requested=expected, actual=actual,
                            message=p.locator('#viewer-windows-status').inner_text())
            (folder/'span-observed.json').write_text(json.dumps(observed, ensure_ascii=False, indent=2), encoding='utf-8')
            viewer.screenshot(path=str(folder/'span-viewer.png'))
            p.screenshot(path=str(folder/'span-workspace.png'))
            print(json.dumps(observed, ensure_ascii=False), flush=True)
            expect(p.locator('#viewer-windows-status')).to_have_text('지정 화면으로 이동하고 창 위치를 저장했습니다.')
            for key in expected:
                # Existing display-layout browser measurement tolerance.
                self.assertLessEqual(abs(actual[key]-expected[key]), 16)
            self.assertEqual(viewer.evaluate('__displayDocument'), marker)
            self.assertEqual(p.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})'), workspace)
            self.assertEqual(len(p.context.pages), 2)
            viewer.close()
            p.locator('#viewer-windows-done').click()
            self.close_toolbar_groups(p)
            with p.context.expect_page() as opened:
                p.locator('#thumbwrap img').first.dblclick()
            restored = opened.value
            restored.wait_for_url('**/ohif/viewer?**')
            canvas_ready(restored, 1)
            p.wait_for_function('''expected => {
              const row = viewerWindows.rows()[0], popup = row?.popup;
              return popup && !ohifPlacementWrites.get(popup)?.pending &&
                Object.entries(expected).every(([k,v])=>Math.abs(popupRect(popup)[k]-v)<=16);
            }''', arg=actual)
            self.assertEqual(len(p.context.pages), 2)
            self.assertEqual(p.evaluate('selectedUid'), fixture.uid)
            expect(p.locator('#findings')).to_have_value('DISPLAY MOVE UNSAVED REPORT')
            observed['restored'] = restored.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
            (folder/'span-observed.json').write_text(json.dumps(observed, ensure_ascii=False, indent=2), encoding='utf-8')


def load_tests(loader, tests, pattern):
    suite = loader.loadTestsFromTestCase(SpanBoundaryTests)
    if '--boundary' not in sys.argv:
        suite.addTests(ViewerSpanE2E(name) for name in ViewerSpanE2E.__dict__ if name.startswith('test_span_'))
        suite.addTests(ViewerSpanEmulatedE2E(name) for name in ViewerSpanEmulatedE2E.__dict__ if name.startswith('test_span_'))
        suite.addTests(ViewerSpanSeamEmulatedE2E(name) for name in ViewerSpanSeamEmulatedE2E.__dict__ if name.startswith('test_span_'))
    return suite


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if '--boundary' in sys.argv:
        # Keep the switch until load_tests has selected only the pure boundary.
        unittest.main(argv=[sys.argv[0]], verbosity=2)
    else:
        unittest.main(verbosity=2)
