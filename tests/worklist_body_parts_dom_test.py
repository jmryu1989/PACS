# coding: utf-8
"""REQ-D01-BODY-PART-SEARCH / RISK-D01-BODY-PART-UNKNOWN/WRONG/STALE/ACCESS / TEST-WORKLIST-BODY-PARTS."""
from page_source import read_page_source
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from urllib.parse import unquote

from playwright.sync_api import sync_playwright, expect
from module_session_harness import activate
import auth_logout_dom_test as auth
from worklist_folders_dom_test import FolderSite


ROOT = Path(__file__).resolve().parents[1]
LITE = ROOT / "worklist-v0" / "hpacs-lite"
MAIN = LITE / "main.html"
COMPOUND = LITE / "compound-filter.js"
RELATED = LITE / "related-parts.js"
BODY_PARTS = LITE / "worklist-body-parts.js"
MANAGER = LITE / "saved-filter-manager.js"
MANAGER_CSS = LITE / "saved-filter-manager.css"
VISUAL_DIR = ROOT / "tmp" / "workspace-ui-ci" / "body-parts-visual"


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
        self.context = None
        self.page_errors = []

    def tearDown(self):
        if self.page:
            self.assertEqual(self.page_errors, [])
            self.page.close()
        if self.context:
            self.context.close()

    def new_page(self, viewport=None):
        self.page = self.browser.new_page(viewport=viewport)
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        return self.page

    def open_main(self):
        self.site = FolderSite()
        self.site.modalities = ['CT', 'CT', 'MR']
        self.site.filters = [dict(id=7, name='Chest saved', mode='Radiology', days=-1, quick='',
            cols={'$compound': {'version': 1, 'join': 'and', 'rules': [
                {'field': 'bodyPart', 'op': 'eq', 'value': 'chest'}]}})]
        list_body = self.site.list_body
        def study_rows(account, rename=None):
            body = list_body(account, rename)
            for index, row in enumerate(body['studies']):
                row['uid'] = [auth.UID, auth.UID+'.1', auth.UID+'.2'][index]
                row['series'] = 2 if index == 0 else 1
            return body
        self.site.list_body = study_rows
        self.responses = {
            f'/dicom-web/studies/{auth.UID}/series': (200, dicom_series(auth.UID, 'CHEST', 'Abdomen')),
            f'/dicom-web/studies/{auth.UID}.1/series': (200, dicom_series(auth.UID+'.1', None)),
            f'/dicom-web/studies/{auth.UID}.2/series': (500, {'error': 'synthetic failure'}),
        }
        self.site.gets.update(self.responses)
        self.context = self.browser.new_context(viewport={'width': 1500, 'height': 1000})
        self.context.route('**/*', lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.page.on('pageerror', lambda error: self.page_errors.append(str(error)))
        self.page.on('dialog', lambda dialog: dialog.accept())
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator('#rows tr[data-uid]')).to_have_count(3)
        self.page.locator('#rows tr[data-uid]').first.click()
        expect(self.page.locator('#findings')).to_be_editable()
        self.page.locator('#findings').fill('draft before lookup')
        self.page.locator('#toolbar-filters > summary').click()
        return self.page

    def test_real_metadata_filters_tokens_empty_and_errors_then_completes_saved_chip(self):
        page = self.open_main()
        expect(page.locator('#chips')).to_contain_text('(0 · Partial)')
        self.assertIn('부위 미확인 3건', page.locator('#chips button').get_attribute('aria-label'))
        page.locator('#body-parts-load').click()
        expect(page.locator('#body-parts-status')).to_contain_text('실패 1건')
        expect(page.locator('#chips')).to_contain_text('(1 · Partial)')
        page.locator('#chips button').click()
        expect(page.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(page.locator('#rows tr[data-uid]')).to_have_attribute('data-uid', auth.UID)
        expect(page.locator('#findings')).to_have_value('draft before lookup')
        for operator, value, uid in [('Contains', 'DOM', auth.UID), ('Equals', 'CHEST ABDOMEN', None),
                                      ('Unspecified', None, auth.UID+'.1'), ('Does Not Equal', 'chest', None)]:
            page.locator('#edit-active-filter').click()
            page.locator('[data-rule-op]').select_option(label=operator)
            if value is not None:
                page.locator('[data-rule-value]').fill(value)
            page.locator('#sfm-preview').click()
            expect(page.locator('#rows tr[data-uid]')).to_have_count(1 if uid else 0)
            if uid:
                expect(page.locator('#rows tr[data-uid]')).to_have_attribute('data-uid', uid)
        self.site.gets[f'/dicom-web/studies/{auth.UID}.2/series'] = (200, dicom_series(auth.UID+'.2', 'PELVIS'))
        page.locator('#body-parts-load').click()
        expect(page.locator('#body-parts-status')).to_contain_text('실패 0건')
        expect(page.locator('#chips')).to_have_text('Chest saved (1)')
        self.assertNotIn('Partial', page.locator('#chips button').get_attribute('aria-label'))

    def test_scope_change_discards_cached_parts_without_changing_selection_or_draft(self):
        page = self.open_main()
        page.locator('#body-parts-load').click()
        expect(page.locator('#body-parts-status')).to_contain_text('실패 1건')
        page.locator('#chips button').click()
        expect(page.locator('#rows tr[data-uid]')).to_have_count(1)
        # A new source series count invalidates the old metadata; neither the
        # applied search nor the selected report draft is replaced by that refresh.
        before = self.site.list_body
        def changed_source(account, rename=None):
            body = before(account, rename)
            body['studies'][0]['series'] = 3
            return body
        self.site.list_body = changed_source
        page.locator('#refresh').click()
        expect(page.locator('#chips')).to_contain_text('(0 · Partial)')
        expect(page.locator('#rows tr[data-uid]')).to_have_count(0)
        expect(page.locator('#active-filter-name')).to_have_text('Chest saved')
        expect(page.locator('#findings')).to_have_value('draft before lookup')
        self.assertIn('부위 미확인 3건', page.locator('#chips button').get_attribute('aria-label'))
        page.locator('#worklist-folders-toggle').click()
        folder = page.get_by_role('navigation', name='Folders').get_by_role('button', name=re.compile('^Chest saved'))
        expect(folder).to_have_text('Chest saved (—)')
        expect(folder).to_have_attribute('aria-current', 'true')
        self.site.gets[f'/dicom-web/studies/{auth.UID}/series'] = (200, dicom_series(auth.UID, 'CHEST', 'Abdomen', 'CHEST'))
        self.site.gets[f'/dicom-web/studies/{auth.UID}.2/series'] = (200, dicom_series(auth.UID+'.2', 'PELVIS'))
        page.locator('#body-parts-load').click()
        expect(page.locator('#body-parts-status')).to_contain_text('실패 0건')
        expect(page.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(folder).to_have_text('Chest saved (1)')
        expect(folder).to_have_attribute('aria-current', 'true')
        expect(page.locator('#findings')).to_have_value('draft before lookup')

    def test_saved_manager_date_operator_labels_preserve_the_served_editor_contract(self):
        # REQ-WS3 -> RISK-WS3 (unsupported date entry) -> W2R1-F01:
        # drive the unchanged served editor through its controls, with the real gate.
        page = self.new_page(viewport={"width": 1280, "height": 900})
        page.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=MANAGER_HARNESS)
                   if route.request.url == "https://example.test/manager" else route.abort())
        page.goto("https://example.test/manager")
        activate(page)
        page.add_style_tag(content=self.manager_css)
        page.add_script_tag(content=self.compound_source)
        page.add_script_tag(content=self.manager_source)
        page.evaluate("window.manager=KinSavedFilterManager.mount(options);manager.open()")
        page.get_by_role("combobox", name=re.compile(r"^Field\b")).select_option("date")
        operator = page.get_by_role("combobox", name=re.compile(r"^Operator\b"))
        self.assertEqual(operator.locator("option").all_inner_texts(),
                         ["Equals", "Does Not Equal", "On or After", "On or Before",
                          "Between (Inclusive)", "Is Empty", "Is Not Empty", "Within Last N Days"])
        operator.select_option(label="On or After")
        value = page.get_by_label("Value", exact=True)
        self.assertEqual(value.get_attribute("type"), "date")
        value.fill("2026-10-01")
        self.assertEqual(value.input_value(), "2026-10-01")

    def test_relative_editor_stored_rule_presets_custom_validation_and_save(self):
        # WS3-RELATIVE-DATE / W2M-F08/F09 / I01: the served editor's first writer.
        page = self.new_page(viewport={"width": 1280, "height": 900})
        page.set_content(MANAGER_HARNESS)
        activate(page)
        page.add_style_tag(content=self.manager_css)
        page.add_script_tag(content=self.compound_source)
        page.add_script_tag(content=self.manager_source)
        page.evaluate("""() => {
          current.cols.$compound={version:1,join:'and',rules:[{field:'date',op:'withinLastDays',value:'7'}]};
          options.list=()=>[{...current,id:7}];options.save=async value=>{window.saved=value;return value};
          window.manager=KinSavedFilterManager.mount(options);manager.open({name:'Draft'});
        }""")
        value = page.get_by_label('Value', exact=True)
        expect(value).to_have_attribute('type', 'number')
        expect(value).to_have_value('7')
        expect(page.locator('#sfm-count')).not_to_contain_text('오류')
        for preset in ['0', '1', '7', '30']:
            page.get_by_role('combobox', name=re.compile(r'^Date Range')).select_option(preset)
            expect(value).to_have_value(preset)
        page.get_by_role('combobox', name=re.compile(r'^Date Range')).select_option('')
        value.fill('366')
        expect(page.locator('#sfm-count')).to_contain_text('0~365')
        value.fill('0')
        page.locator('#sfm-save').click()
        page.wait_for_function('window.saved !== undefined')
        self.assertEqual(page.evaluate('saved.cols.$compound.rules'), [{'field':'date','op':'withinLastDays','value':'0'}])
        self.assertEqual(page.evaluate('KinCompoundFilter.describe(saved.cols.$compound, columns.Radiology)'), '(Study Date Today)')

    def test_saved_manager_refreshes_live_counts_and_preserves_dirty_body_part_rule(self):
        page = self.new_page(viewport={"width": 1280, "height": 900})
        page.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=MANAGER_HARNESS)
                   if route.request.url == "https://example.test/manager" else route.abort())
        page.goto("https://example.test/manager")
        activate(page)
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
