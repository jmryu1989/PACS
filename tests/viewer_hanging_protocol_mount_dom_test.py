# coding: utf-8
"""TEST-HP-MOUNT: actual config mount, source filtering and stale async boundaries."""
from pathlib import Path
from urllib.parse import urlparse
import time
import unittest

from playwright.sync_api import sync_playwright, expect, Error as PlaywrightError
from viewer_hanging_protocol_dom_test import library, plane

ROOT = Path(__file__).resolve().parents[1]
CONFIG = (ROOT / 'config' / 'ohif.js').read_text(encoding='utf-8')
INTEGRATION = CONFIG[CONFIG.index('const kinViewerLayoutModel ='):CONFIG.index('function kinCreateCTSync(')] + \
    ';window.viewerLayoutExtension=kinCreateViewerLayout();'
MODEL = (ROOT / 'worklist-v0' / 'hpacs-lite' / 'hanging-protocol-model.js').read_text(encoding='utf-8')
EDITOR = (ROOT / 'worklist-v0' / 'hpacs-lite' / 'viewer-hanging-protocol.js').read_text(encoding='utf-8')

CURRENT, RELATED = '9.9.2', '1.1.1'  # Canonical recent-layout order is the reverse of URL role order.
OWNER = {'institution': 'hospital', 'subject': 'reader'}
STUDIES = [
    {'uid': CURRENT, 'sourcePatientKey': 'hospital|patient', 'date': '20260912', 'modality': 'CT', 'desc': 'Head CT'},
    {'uid': RELATED, 'sourcePatientKey': 'hospital|patient', 'date': '20250912', 'modality': 'CT', 'desc': 'Old Head CT'},
]

HARNESS = r"""
<textarea id="report">KEEP REPORT</textarea>
<script>
window.BroadcastChannel=undefined;
const currentUID='9.9.2',relatedUID='1.1.1';
const image=(study,series)=>({StudyInstanceUID:study,SeriesInstanceUID:series,RetrieveAETitle:'ARCHIVE',BodyPartExamined:'HEAD',Laterality:'L'});
const stack=(id,study,series,description)=>({displaySetInstanceUID:id,StudyInstanceUID:study,SeriesInstanceUID:series,SeriesNumber:1,
 SeriesDescription:description,Modality:'CT',SOPClassHandlerId:'@ohif/extension-default.sopClassHandlerModule.stack',isCompositeStack:false,
 images:[image(study,series),image(study,series)]});
const sets=[stack('ds-current',currentUID,'9.9.2.1','Brain Axial'),stack('ds-related',relatedUID,'1.1.1.1','Brain Prior'),
 {...stack('bad-handler',currentUID,'9.9.2.2','Brain Axial'),SOPClassHandlerId:'other'},
 {...stack('bad-composite',currentUID,'9.9.2.3','Brain Axial'),isCompositeStack:true},
 stack('split-a',currentUID,'9.9.2.4','Brain Axial'),stack('split-b',currentUID,'9.9.2.4','Brain Axial'),
 {...stack('mixed-images',currentUID,'9.9.2.5','Brain Axial'),images:[image(currentUID,'9.9.2.5'),image(relatedUID,'9.9.2.5')]},
 {...stack('ds-volume',currentUID,'9.9.2.6','Brain Volume'),images:[0,1,2].map(n=>({...image(currentUID,'9.9.2.6'),
   SOPClassUID:'1.2.840.10008.5.1.4.1.1.2',SOPInstanceUID:'1.2.9.'+n}))}];
let setCalls=[];
const viewports=new Map([['old',{viewportId:'old',x:0,y:0,width:1,height:1,displaySetInstanceUIDs:['ds-current']}]]);
let layout={numRows:1,numCols:1,layoutType:'grid',version:0},activeViewportId='old';
const grid={getState:()=>({layout,activeViewportId,viewports}),
 setLayout:value=>{setCalls.push(value);const next=[];for(let i=0;i<value.numRows*value.numCols;i++)next.push(value.findOrCreateViewport(i));
   setTimeout(()=>{layout={numRows:value.numRows,numCols:value.numCols,layoutType:'grid',version:layout.version+1};activeViewportId=value.activeViewportId;
     viewports.clear();next.forEach((v,i)=>viewports.set(v.viewportOptions.viewportId,{viewportId:v.viewportOptions.viewportId,x:(i%value.numCols)/value.numCols,y:Math.floor(i/value.numCols)/value.numRows,width:1/value.numCols,height:1/value.numRows,displaySetInstanceUIDs:v.displaySetInstanceUIDs,options:v.viewportOptions}));},10);
   return Promise.resolve();}};
const viewport={type:'stack',getCurrentImageId:()=>'/synthetic/image',getCurrentImageIdIndex:()=>0,getCamera:()=>({scale:1}),getProperties:()=>({voiRange:{lower:-100,upper:200}})};
// Native orientation presets in patient space, so a requested plane can be checked as geometry.
const PLANES={axial:[0,0,-1],sagittal:[1,0,0],coronal:[0,1,0]};
const planeViewports=new Map();
const cornerstone={getCornerstoneViewport:id=>{const options=viewports.get(id)?.options;
  if(!options||options.viewportType!=='volume')return viewport;
  // One stable instance per viewport, as the native service returns.
  if(!planeViewports.has(id))planeViewports.set(id,{type:'orthographic',getCurrentImageId:()=>null,getCurrentImageIdIndex:()=>null,
    getCamera:()=>({viewPlaneNormal:PLANES[options.orientation],focalPoint:[0,0,0],parallelScale:100}),getProperties:()=>({})});
  return planeViewports.get(id);}};
const services={viewportGridService:grid,displaySetService:{getActiveDisplaySets:()=>sets,getDisplaySetByUID:id=>sets.find(s=>s.displaySetInstanceUID===id)},cornerstoneViewportService:cornerstone};
window.mountLayout=()=>{viewerLayoutExtension.preRegistration({servicesManager:{services}});viewerLayoutExtension.onModeEnter()};
</script>
"""
CAPTURE_TIMEOUT_MS = 10_000


class ViewerHangingProtocolMountDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width': 1280, 'height': 900}); self.delayed_script = None; self.delayed_studies = None
        self.me_count = 0; self.change_owner_after = None
        self.page.route('https://mount.test/**', self.route)
        self.page.goto(f'https://mount.test/ohif/viewer?StudyInstanceUIDs={CURRENT},{RELATED}')
        self.page.add_script_tag(content=INTEGRATION)
        self.page.evaluate("value=>localStorage.setItem('kin-hanging-protocols:v1:'+JSON.stringify(['hospital','reader']),JSON.stringify(value))", library())

    def tearDown(self):
        self.page.close()

    def route(self, route):
        parsed = urlparse(route.request.url); path = parsed.path
        if path == '/ohif/viewer': route.fulfill(body=HARNESS, content_type='text/html; charset=utf-8'); return
        if path.endswith('/hanging-protocol-model.js'): route.fulfill(body=MODEL, content_type='application/javascript'); return
        if path.endswith('/viewer-hanging-protocol.js'):
            if self.delayed_script is not None: self.delayed_script.append(route); return
            route.fulfill(body=EDITOR, content_type='application/javascript'); return
        if path == '/api/me':
            self.me_count += 1; owner = dict(OWNER)
            if self.change_owner_after is not None and self.me_count >= self.change_owner_after: owner['subject'] = 'changed-reader'
            route.fulfill(json={'kind': 'member', 'institution': owner['institution'], 'sub': owner['subject']}); return
        if path == '/api/studies':
            if self.delayed_studies is not None: self.delayed_studies.append(route); return
            route.fulfill(json={'studies': STUDIES}); return
        route.abort()

    def mount(self):
        self.page.evaluate('mountLayout()')
        expect(self.page.get_by_role('heading', name='Hanging Protocols')).to_be_visible()

    def wait_for_capture(self, held, what, count=1):
        # The script/fetch element exists before Chromium issues the request, so waiting on the DOM
        # tag can leave `held` empty and release a request that was never captured. Wait for the
        # route handler itself; sync-API handlers run on this thread while wait_for_timeout blocks.
        deadline = time.monotonic() + CAPTURE_TIMEOUT_MS / 1000
        while len(held) < count:
            if time.monotonic() >= deadline:
                self.fail(f'{what} route captured {len(held)}/{count} request(s) within {CAPTURE_TIMEOUT_MS}ms')
            self.page.wait_for_timeout(10)
        return held

    def release(self, held, **kwargs):
        for route in held:
            try: route.fulfill(**kwargs)
            except PlaywrightError: pass

    def test_actual_mount_preserves_url_roles_filters_sources_and_applies_vacancy(self):
        self.mount(); evidence = ROOT / 'tmp' / 'hp-mount-dom' / 'editor-1280x900.png'; evidence.parent.mkdir(parents=True, exist_ok=True)
        self.page.screenshot(path=str(evidence)); self.page.locator('#kin-hp-apply').click(); expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied')
        result = self.page.evaluate("""()=>({calls:setCalls.length,cells:[...viewports.values()].map(v=>v.displaySetInstanceUIDs),
          vacancy:setCalls[0].findOrCreateViewport(2),report:document.querySelector('#report').value})""")
        self.assertEqual(1, result['calls']); self.assertEqual([['ds-current'], ['ds-related'], [], ['ds-current']], result['cells'])
        self.assertEqual([], result['vacancy']['displaySetInstanceUIDs']); self.assertTrue(result['vacancy']['viewportOptions']['allowUnmatchedView'])
        self.assertEqual('KEEP REPORT', result['report'])

    def test_editor_remains_reachable_in_short_and_narrow_viewports(self):
        self.mount()
        for width,height in [(1280,900),(390,600)]:
            self.page.set_viewport_size({'width':width,'height':height})
            panel=self.page.locator('#kin-viewer-layout');box=panel.bounding_box()
            self.assertGreaterEqual(box['y'],0);self.assertLessEqual(box['y']+box['height'],height)
            for control in [self.page.get_by_label('Name'),self.page.locator('#kin-hp-apply')]:
                control.scroll_into_view_if_needed();expect(control).to_be_in_viewport()
                rect=control.bounding_box();self.assertGreaterEqual(rect['x'],0);self.assertLessEqual(rect['x']+rect['width'],width)
            self.page.get_by_label('Name').scroll_into_view_if_needed()
            self.page.screenshot(path=str(ROOT/'tmp'/'hp-mount-dom'/f'editor-final-{width}x{height}.png'))

    def test_mode_exit_while_editor_script_is_delayed_cannot_mount_or_mutate(self):
        self.delayed_script = []; self.page.evaluate('mountLayout()'); self.page.wait_for_function('()=>document.querySelectorAll("script[src*=viewer-hanging-protocol]").length===1')
        self.wait_for_capture(self.delayed_script, 'viewer-hanging-protocol.js'); self.page.evaluate('viewerLayoutExtension.onModeExit()')
        self.release(self.delayed_script, body=EDITOR, content_type='application/javascript'); self.page.wait_for_timeout(100)
        self.assertEqual(0, self.page.locator('#kin-viewer-layout').count()); self.assertEqual(0, self.page.get_by_role('heading', name='Hanging Protocols').count()); self.assertEqual(0, self.page.evaluate('setCalls.length'))

    def test_session_end_while_editor_script_is_delayed_cannot_mount_or_mutate(self):
        self.delayed_script = []; self.page.evaluate('mountLayout()'); self.page.wait_for_function('()=>document.querySelectorAll("script[src*=viewer-hanging-protocol]").length===1')
        self.wait_for_capture(self.delayed_script, 'viewer-hanging-protocol.js')
        self.page.evaluate("window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended'}))")
        self.release(self.delayed_script, body=EDITOR, content_type='application/javascript'); self.page.wait_for_timeout(100)
        self.assertEqual(0, self.page.get_by_role('heading', name='Hanging Protocols').count()); self.assertEqual(0, self.page.evaluate('setCalls.length'))
        expect(self.page.locator('#kin-viewer-layout-status')).to_contain_text('세션이 변경')

    def test_interrupted_permission_and_delayed_owner_change_fail_closed(self):
        self.mount(); self.delayed_studies = []; self.page.locator('#kin-hp-apply').click()
        self.wait_for_capture(self.delayed_studies, '/api/studies')
        self.page.evaluate("window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended'}))")
        self.release(self.delayed_studies, json={'studies': STUDIES}); self.page.wait_for_timeout(100); self.assertEqual(0, self.page.evaluate('setCalls.length'))

        self.page.evaluate('viewerLayoutExtension.onModeExit()'); self.change_owner_after = None; self.me_count = 0; self.delayed_studies = None
        self.page.evaluate('mountLayout()'); expect(self.page.get_by_role('heading', name='Hanging Protocols')).to_be_visible()
        self.change_owner_after = self.me_count + 1
        self.page.locator('#kin-hp-apply').click(); expect(self.page.locator('#kin-viewer-layout-status')).to_contain_text('세션이 변경')
        self.assertEqual(0, self.page.evaluate('setCalls.length'))


    def test_actual_mount_opens_plane_cells_of_one_eligible_volume(self):
        value = library('Volume Three Plane'); rule = value['rules'][0]
        rule['selectors'] = [rule['selectors'][0]]
        rule['selectors'][0]['description'] = {'operator': 'contains', 'value': 'Volume'}
        rule['layout'] = {'rows': 2, 'cols': 2, 'cells': [plane('Current', 'axial'), plane('Current', 'sagittal'),
                                                          plane('Current', 'coronal'), None]}
        self.page.evaluate("value=>localStorage.setItem('kin-hanging-protocols:v1:'+JSON.stringify(['hospital','reader']),JSON.stringify(value))", value)
        self.mount(); self.page.locator('#kin-hp-apply').click()
        expect(self.page.locator('#kin-hp-status')).to_contain_text('Applied')
        result = self.page.evaluate("""()=>({calls:setCalls.length,cells:[...viewports.values()].map(v=>v.displaySetInstanceUIDs),
          options:[...viewports.values()].map(v=>[v.options.viewportType,v.options.toolGroupId,v.options.orientation??null]),
          normals:[...viewports.values()].map(v=>cornerstone.getCornerstoneViewport(v.viewportId).getCamera().viewPlaneNormal??null),
          report:document.querySelector('#report').value})""")
        self.assertEqual(1, result['calls'])
        self.assertEqual([['ds-volume'], ['ds-volume'], ['ds-volume'], []], result['cells'],
                         'the mounted rule opens one eligible volume in three cells and leaves the vacancy empty')
        self.assertEqual([['volume', 'mpr', 'axial'], ['volume', 'mpr', 'sagittal'],
                          ['volume', 'mpr', 'coronal'], ['stack', 'default', None]], result['options'])
        self.assertEqual([[0, 0, -1], [1, 0, 0], [0, 1, 0], None], result['normals'])
        self.assertEqual('KEEP REPORT', result['report'])


if __name__ == '__main__': unittest.main(verbosity=2)
