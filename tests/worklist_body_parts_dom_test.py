# coding: utf-8
"""REQ-D01-BODY-PART-SEARCH / RISK-D01-BODY-PART-UNKNOWN/WRONG/STALE/ACCESS / TEST-WORKLIST-BODY-PARTS."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.parse import unquote

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
LITE = ROOT / "worklist-v0" / "hpacs-lite"
MAIN = LITE / "main.html"
COMPOUND = LITE / "compound-filter.js"
RELATED = LITE / "related-parts.js"
BODY_PARTS = LITE / "worklist-body-parts.js"
MANAGER = LITE / "saved-filter-manager.js"
MANAGER_CSS = LITE / "saved-filter-manager.css"
VISUAL_DIR = ROOT / "tmp" / "workspace-ui-ci" / "body-parts-visual"


def extract_function(source, name):
    start = source.index(f"    function {name}(")
    brace = source.index("{", start)
    depth = 0
    quote = None
    escaped = False
    for index in range(brace, len(source)):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(f"unterminated function {name}")


MAIN_HARNESS = r"""
<button id="body-parts-load"></button><button id="body-parts-refresh"></button>
<button id="body-parts-cancel"></button><small id="body-parts-status"></small>
<div id="active-filter-info"></div><span id="active-filter-name"></span><span id="active-filter-state"></span>
<button id="edit-active-filter"></button><button id="managefilters"></button><div id="chips"></div>
<textarea id="findings">draft before lookup</textarea>
<script>
const $ = value => document.querySelector(value);
const COLS = {
  Radiology: [{k:'id',t:'ID',f:'text'},{k:'name',t:'Name',f:'text'},{k:'modality',t:'Modality',f:['CT','MR']},{k:'date',t:'Study Date'}],
  Technician: [{k:'id',t:'ID',f:'text'},{k:'modality',t:'Modality',f:['CT','MR']},{k:'date',t:'Study Date'}]
};
let mode='Radiology',serverMode=true,offline=false,demoMode=false,selectedUid='1.2.1';
let studies=[
  {uid:'1.2.1',id:'P1',name:'Alpha',modality:'CT',date:'2026-09-11',series:2},
  {uid:'1.2.2',id:'P2',name:'Beta',modality:'CT',date:'2026-09-11',series:1},
  {uid:'1.2.3',id:'P3',name:'Gamma',modality:'MR',date:'2026-09-11',series:1}
];
let fval={name:'manual criterion'},activeFilterName=null,renderCalls=0,managerRefreshes=0;
const bodyRule=(op,value)=>({version:1,join:'and',rules:[{field:'bodyPart',op,...(value===undefined?{}:{value})}]});
let userFilters=[{id:7,name:'Chest saved',mode:'Radiology',days:-1,quick:'',cols:{$compound:bodyRule('eq','chest')},sortKey:null,sortDir:0,isDefault:false}];
const KinViewerOpening={key:()=> '["hospital","reader"]'};
const KinAuth={session:()=>({sub:'reader'})};
const savedFilterManager={refreshCounts:()=>managerRefreshes++};
const withinDays=()=>true;
function testCol(study,column,values){const value=values?.[column.k]??'';if(value==='')return true;
  return column.f==='text'?String(study[column.k]??'').toUpperCase().includes(String(value).toUpperCase()):String(study[column.k])===String(value)}
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const renderActiveFilter=()=>{};
const focusFilterChip=()=>{};
function render(){renderCalls++;renderBodyParts();renderChips()}
</script>
"""


MANAGER_HARNESS = r"""
<button id="opener">open</button>
<script>
window.confirm=()=>true;
window.KinSharedFilterManager={mount:()=>({dirty:()=>false,lock:()=>{},reset:()=>{}})};
const columns={Radiology:[{k:'id',t:'ID',f:'text'},{k:'date',t:'Study Date'}],Technician:[{k:'id',t:'ID',f:'text'}]};
const criterion={version:1,join:'and',rules:[{field:'bodyPart',op:'eq',value:'chest'}]};
const current={name:'Draft',mode:'Radiology',days:-1,quick:'',cols:{$compound:criterion},sortKey:null,sortDir:0,isDefault:false};
let state={allowed:true,busy:false,total:3,verified:1,failed:1,remaining:1,note:''},calls=[];
const options={columns,days:value=>Number(value),list:()=>[],snapshot:()=>current,count:()=>state.verified,
  countNote:()=>state.verified===state.total?'':`Partial · 부위 미확인 ${state.total-state.verified}건`,
  bodyParts:{snapshot:()=>({...state}),load:refresh=>calls.push(['load',refresh]),cancel:()=>calls.push(['cancel'])},
  apply:()=>true,readFolders:async()=>({folders:[],filters:[]}),writeFolders:async()=>({folders:[],filters:[]}),
  readShared:async()=>({}),writeShared:async()=>({}),copyShared:async()=>({}),save:async value=>value,
  remove:async()=>{},reload:async()=>{}};
</script>
"""


def dicom_series(study_uid, *body_parts):
    rows = []
    for index, body_part in enumerate(body_parts, 1):
        rows.append({
            "0020000D": {"Value": [study_uid]},
            "0020000E": {"Value": [f"{study_uid}.{index}"]},
            "00180015": {"Value": [body_part]},
        })
    return rows


class WorklistBodyPartsDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)
        source = MAIN.read_text(encoding="utf-8")
        cls.main_functions = "\n".join(extract_function(source, name) for name in (
            "mountWorklistBodyParts", "bodyPartCountNote", "renderBodyParts", "savedFilterDays",
            "filteredFor", "renderChips",
        ))
        cls.compound_source = COMPOUND.read_text(encoding="utf-8")
        cls.related_source = RELATED.read_text(encoding="utf-8")
        cls.body_parts_source = BODY_PARTS.read_text(encoding="utf-8")
        cls.manager_source = MANAGER.read_text(encoding="utf-8")
        cls.manager_css = MANAGER_CSS.read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.page = None
        self.page_errors = []

    def tearDown(self):
        if self.page:
            self.assertEqual(self.page_errors, [])
            self.page.close()

    def new_page(self, viewport=None):
        self.page = self.browser.new_page(viewport=viewport)
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        return self.page

    def open_main(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        responses = {
            "1.2.1": (200, dicom_series("1.2.1", "CHEST", "Abdomen")),
            "1.2.2": (200, dicom_series("1.2.2", None)),
            "1.2.3": (500, {"error": "synthetic failure"}),
            "2.4.1": (200, dicom_series("2.4.1", "BRAIN")),
        }
        self.responses = responses

        def route_request(route):
            if route.request.url == "https://example.test/harness":
                route.fulfill(status=200, content_type="text/html; charset=utf-8", body=MAIN_HARNESS)
                return
            marker = "/dicom-web/studies/"
            if marker in route.request.url:
                uid = unquote(route.request.url.split(marker, 1)[1].split("/series", 1)[0])
                status, payload = responses[uid]
                route.fulfill(status=status, content_type="application/dicom+json", body=json.dumps(payload))
                return
            route.abort()

        page.route("**/*", route_request)
        page.goto("https://example.test/harness")
        page.add_script_tag(content=self.related_source)
        page.add_script_tag(content=self.body_parts_source)
        page.add_script_tag(content=self.compound_source)
        page.add_script_tag(content=self.main_functions + r"""
const worklistBodyParts=mountWorklistBodyParts();
window.__body={
  model:worklistBodyParts,filteredFor,bodyPartCountNote,renderChips,renderBodyParts,
  setStudies:value=>{studies=value},getStudies:()=>studies,getState:()=>({selectedUid,findings:$('#findings').value,fval:{...fval},renderCalls,managerRefreshes})
};
render();
""")
        return page

    def test_real_metadata_filters_tokens_empty_and_errors_then_completes_saved_chip(self):
        page = self.open_main()
        self.assertIn("(0 · Partial)", page.locator("#chips").inner_text())
        self.assertIn("부위 미확인 3건", page.locator("#chips button").get_attribute("aria-label"))

        page.locator("#body-parts-load").click()
        page.wait_for_function("!__body.model.snapshot().busy")
        page.wait_for_function("document.querySelector('#body-parts-status').textContent.includes('실패 1건')")
        result = page.evaluate(r"""() => ({
          exact:__body.filteredFor(userFilters[0]).map(x=>x.uid),
          contains:__body.filteredFor({...userFilters[0],cols:{$compound:bodyRule('contains','DOM')}}).map(x=>x.uid),
          joined:__body.filteredFor({...userFilters[0],cols:{$compound:bodyRule('eq','CHEST ABDOMEN')}}).map(x=>x.uid),
          empty:__body.filteredFor({...userFilters[0],cols:{$compound:bodyRule('empty')}}).map(x=>x.uid),
          negative:__body.filteredFor({...userFilters[0],cols:{$compound:bodyRule('neq','chest')}}).map(x=>x.uid),
          mutated:__body.getStudies().some(study=>Object.hasOwn(study,'bodyPart')),
          state:__body.getState()
        })""")
        self.assertEqual(result["exact"], ["1.2.1"])
        self.assertEqual(result["contains"], ["1.2.1"])
        self.assertEqual(result["joined"], [])
        self.assertEqual(result["empty"], ["1.2.2"])
        self.assertEqual(result["negative"], [])
        self.assertFalse(result["mutated"])
        self.assertEqual(result["state"]["selectedUid"], "1.2.1")
        self.assertEqual(result["state"]["findings"], "draft before lookup")
        self.assertEqual(result["state"]["fval"], {"name": "manual criterion"})
        self.assertIn("(1 · Partial)", page.locator("#chips").inner_text())
        self.assertIn("실패 1건", page.locator("#body-parts-status").inner_text())

        self.responses["1.2.3"] = (200, dicom_series("1.2.3", "PELVIS"))
        page.locator("#body-parts-load").click()
        page.wait_for_function("!__body.model.snapshot().busy && __body.model.snapshot().verified === 3")
        self.assertEqual(page.locator("#chips").inner_text(), "Chest saved (1)")
        self.assertNotIn("Partial", page.locator("#chips button").get_attribute("aria-label"))

    def test_scope_change_discards_cached_parts_without_changing_selection_or_draft(self):
        page = self.open_main()
        page.locator("#body-parts-load").click()
        page.wait_for_function("!__body.model.snapshot().busy")
        before = page.evaluate("__body.getState()")
        result = page.evaluate(r"""() => {
          __body.setStudies([{uid:'2.4.1',id:'P4',name:'Delta',modality:'CT',date:'2026-09-11',series:1}]);
          const filtered=__body.filteredFor(userFilters[0]).map(x=>x.uid);
          __body.renderChips();
          return {filtered,note:__body.bodyPartCountNote(userFilters[0]),snapshot:__body.model.snapshot(),state:__body.getState()};
        }""")
        self.assertEqual(result["filtered"], [])
        self.assertEqual(result["snapshot"]["verified"], 0)
        self.assertEqual(result["snapshot"]["total"], 1)
        self.assertIn("부위 미확인 1건", result["note"])
        self.assertEqual(result["state"]["selectedUid"], before["selectedUid"])
        self.assertEqual(result["state"]["findings"], before["findings"])
        self.assertEqual(result["state"]["fval"], before["fval"])
        self.assertIn("(0 · Partial)", page.locator("#chips").inner_text())

    def test_saved_manager_refreshes_live_counts_and_preserves_dirty_body_part_rule(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        page.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=MANAGER_HARNESS)
                   if route.request.url == "https://example.test/manager" else route.abort())
        page.goto("https://example.test/manager")
        page.add_style_tag(content=self.manager_css)
        page.add_script_tag(content=self.compound_source)
        page.add_script_tag(content=self.manager_source)
        page.evaluate("window.manager=KinSavedFilterManager.mount(options);document.querySelector('#opener').focus();manager.open()")
        self.assertFalse(page.locator("#sfm-body-parts").is_hidden())
        self.assertIn("1건", page.locator("#sfm-count").inner_text())
        self.assertIn("Partial", page.locator("#sfm-count").inner_text())
        self.assertEqual(page.locator("[data-rule-op] option").all_inner_texts(),
                         ["Contains", "Equals", "Does Not Contain", "Does Not Equal", "Unspecified", "Specified"])
        VISUAL_DIR.mkdir(parents=True, exist_ok=True)
        screenshot = Path(tempfile.mkdtemp(prefix="conditions-", dir=VISUAL_DIR)) / "saved-manager-partial.png"
        page.locator("#sfm-body-parts").scroll_into_view_if_needed()
        page.locator("#saved-filter-manager").screenshot(path=str(screenshot))
        print(f"Saved Search Manager screenshot: {screenshot}")
        page.locator("#sfm-body-parts-load").click()
        self.assertEqual(page.evaluate("calls"), [["load", False]])

        value = page.locator("[data-rule-value]")
        value.fill("brain")
        page.evaluate("state={...state,verified:3,failed:0,remaining:0};manager.refreshCounts()")
        self.assertEqual(value.input_value(), "brain")
        self.assertIn("3건", page.locator("#sfm-count").inner_text())
        self.assertNotIn("Partial", page.locator("#sfm-count").inner_text())


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
