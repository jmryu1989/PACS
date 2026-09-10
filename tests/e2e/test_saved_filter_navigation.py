# coding: utf-8
"""TEST-D01-FILTER-NAVIGATION: saved-search navigation preserves current work."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import time
import unittest
import uuid

from playwright.sync_api import expect
import test_worklist as base


class SavedFilterNavigationE2E(base.WorklistE2E):
    def remove_filter(self, filter_id):
        result = self.stack.request('DELETE', f'/filters/{filter_id}', 'doctor')
        self.assertIn(result.status, (200, 404))

    def create_filter(self, name, **changes):
        payload = dict(name=name, mode='Radiology', days=-1, cols={},
                       quick='', sortKey=None, sortDir=0, createOnly=True)
        payload.update(changes)
        result = self.stack.request('POST', '/filters', 'doctor', payload)
        self.assertEqual(result.status, 201)
        self.addCleanup(self.remove_filter, result.body['id'])
        return result.body

    def chip(self, page, name):
        # A similar name must not turn an exact-entry edit into an ambiguous click.
        return page.locator('#chips').get_by_role('button', name=re.compile(
            '^' + re.escape(name) + r', 로드된 목록 기준 \d+건(?:, 기본 필터)?$'))

    def edit_from_chip(self, page, name, key='Shift+F10'):
        self.chip(page, name).focus()
        page.keyboard.press(key)
        expect(page.locator('#ctx')).to_be_visible()
        expect(page.locator('#ctx').get_by_role('menuitem', name='Apply', exact=True)).to_be_focused()
        page.keyboard.press('ArrowDown')
        expect(page.locator('#ctx').get_by_role('menuitem', name='Edit', exact=True)).to_be_focused()
        page.keyboard.press('Enter')
        expect(page.locator('#saved-filter-manager')).to_be_visible()
        expect(page.locator('#sfm-name')).to_have_value(name)

    def save_existing(self, page, filter_id):
        with page.expect_response(lambda r: r.request.method == 'POST'
                                  and r.url.endswith('/api/filters')) as response:
            page.locator('#sfm-save').click()
        self.assertEqual(response.value.status, 201)
        saved = response.value.json()
        self.assertEqual(saved['id'], filter_id)
        expect(page.locator('#sfm-status')).to_contain_text('저장 완료')
        expect(page.locator('#sfm-save')).to_be_focused()
        return saved

    def expect_rows(self, page, *fixtures):
        expect(page.locator('#rows tr[data-uid]')).to_have_count(len(fixtures))
        self.assertEqual(set(page.locator('#rows tr[data-uid]').evaluate_all(
            'rows => rows.map(row => row.dataset.uid)')), {f.uid for f in fixtures})

    def expect_report_preserved(self, page, fixture, draft, versions):
        expect(page.locator('#findings')).to_have_value(draft)
        self.assertEqual(page.evaluate('selectedUid'), fixture.uid)
        self.wait_state(page, fixture, lambda s: (s.get('draft') or {}).get('findings') == draft,
                        timeout=25000)
        self.assertEqual(self.state(fixture)['findings'], fixture.secret)
        self.assertEqual(self.versions(fixture), versions)

    def test_navigation_01_exact_edit_active_state_delete_and_report_preservation(self):
        prefix = 'NAV-' + uuid.uuid4().hex[:8]
        first, second = self.fixture(patient_id=prefix + '-A'), self.fixture(patient_id=prefix + '-B')
        self.seed_report(first)
        versions = self.versions(first)
        name = prefix + ' 검사함 "<img src=x onerror=window.badNavigation=1> &'
        saved = self.create_filter(name, quick=prefix)
        self.create_filter(name + '-Other', quick=second.patient_id)
        page = self.login(); self.select(page, first)
        expect(page.locator('#findings')).to_have_value(first.secret)
        draft = first.secret + ' navigation draft'
        page.locator('#findings').fill(draft)
        self.chip(page, name).click()
        self.expect_rows(page, first, second)
        expect(page.locator('#active-filter-name')).to_have_text(name)
        expect(page.locator('#active-filter-state')).to_have_text('Saved')
        expect(page.locator('#active-filter-info img, #chips img')).to_have_count(0)
        self.assertIsNone(page.evaluate('window.badNavigation'))

        self.edit_from_chip(page, name)
        page.locator('#sfm-description').fill('원문 설명을 보존합니다 <&>')
        self.save_existing(page, saved['id'])
        expect(page.locator('#active-filter-state')).to_have_text('Saved')
        page.locator('#sfm-col-id').fill(second.patient_id)
        self.save_existing(page, saved['id'])
        self.expect_rows(page, first, second)
        expect(page.locator('#filterrow input[data-f="id"]')).to_have_value('')
        expect(page.locator('#findings')).to_have_value(draft)
        expect(page.locator('#active-filter-state')).to_have_text('Modified')
        expect(self.chip(page, name)).to_contain_text('(1)')
        page.locator('#sfm-close').click()
        # Saving changed the count and replaced the originating chip's DOM node.
        expect(self.chip(page, name)).to_be_focused()

        self.edit_from_chip(page, name, key='ContextMenu')
        expect(page.locator('#sfm-col-id')).to_have_value(second.patient_id)
        page.locator('#sfm-col-id').fill(first.patient_id)
        confirms = []
        def reject_unsaved(dialog):
            confirms.append(dialog.message); dialog.dismiss()
        page.on('dialog', reject_unsaved)
        try:
            for _ in range(2):
                page.keyboard.press('Escape')
                expect(page.locator('#saved-filter-manager')).to_be_visible()
                expect(page.locator('#sfm-col-id')).to_have_value(first.patient_id)
        finally:
            page.remove_listener('dialog', reject_unsaved)
        self.assertEqual(len(confirms), 2)
        page.once('dialog', lambda dialog: dialog.accept()); page.keyboard.press('Escape')
        expect(page.locator('#saved-filter-manager')).not_to_be_visible()
        expect(self.chip(page, name)).to_be_focused()
        self.chip(page, name).click()
        self.expect_rows(page, second)
        expect(page.locator('#active-filter-state')).to_have_text('Saved')

        page.locator('#quick').fill(prefix + '-absent')
        self.expect_rows(page)
        expect(page.locator('#active-filter-state')).to_have_text('Modified')
        page.locator('#edit-active-filter').click()
        expect(page.locator('#sfm-name')).to_have_value(name)
        expect(page.locator('#sfm-quick')).to_have_value(prefix)
        expect(page.locator('#sfm-col-id')).to_have_value(second.patient_id)
        page.locator('#sfm-close').click()
        page.locator('#quick').fill(prefix)
        expect(page.locator('#active-filter-state')).to_have_text('Saved')
        page.locator('#heads th[data-key="id"]').click()
        expect(page.locator('#active-filter-state')).to_have_text('Modified')
        self.chip(page, name).click()
        expect(page.locator('#active-filter-state')).to_have_text('Saved')
        page.locator('.tabs [data-tab="Technician"]').click()
        expect(page.locator('#active-filter-state')).to_have_text('Modified')
        self.chip(page, name).click()
        expect(page.locator('#active-filter-state')).to_have_text('Saved')

        page.locator('#edit-active-filter').click()
        page.once('dialog', lambda dialog: dialog.accept())
        with page.expect_response(lambda r: r.request.method == 'DELETE'
                                  and r.url.endswith('/api/filters/' + str(saved['id']))) as deleted:
            page.locator('#sfm-delete').click()
        self.assertEqual(deleted.value.status, 200)
        expect(page.locator('#sfm-status')).to_contain_text('삭제했습니다')
        expect(page.locator('#sfm-new')).to_be_focused()
        page.locator('#sfm-close').click()
        expect(page.locator('#clearfilter')).to_be_focused()
        expect(page.locator('#active-filter-name')).to_have_text(name)
        expect(page.locator('#active-filter-state')).to_have_text('Deleted')
        expect(page.locator('#quick')).to_have_value(prefix)
        expect(page.locator('#filterrow input[data-f="id"]')).to_have_value(second.patient_id)
        self.expect_rows(page, second)
        page.locator('#clearfilter').click()
        expect(page.locator('#active-filter-info')).not_to_be_visible()
        expect(page.locator('#quick')).to_have_value('')
        expect(page.locator('#filterrow input[data-f="id"]')).to_have_value('')
        expect(page.locator('#qf button[data-days="-1"]')).to_have_class(re.compile(r'\bon\b'))
        self.assertTrue(page.locator('#filterrow input[data-f]').evaluate_all(
            'inputs => inputs.every(input => input.value === "")'))
        self.expect_report_preserved(page, first, draft, versions)

    def test_navigation_02_save_apply_validation_failure_busy_success_and_relogin(self):
        prefix = 'NAV-save-' + uuid.uuid4().hex[:8]
        first, second = self.fixture(patient_id=prefix + '-A'), self.fixture(patient_id=prefix + '-B')
        self.seed_report(first)
        versions = self.versions(first)
        page = self.login(); self.select(page, first)
        expect(page.locator('#findings')).to_have_value(first.secret)
        draft = first.secret + ' keep through Save & Apply'
        page.locator('#findings').fill(draft)
        page.locator('#quick').fill(prefix)
        self.expect_rows(page, first, second)
        page.locator('#savefilter').click()
        expect(page.locator('#saved-filter-manager')).to_be_visible()
        posts = []
        page.on('request', lambda request: posts.append(request.url)
                if request.method == 'POST' and request.url.endswith('/api/filters') else None)
        page.locator('#sfm-save-apply').click()
        self.assertFalse(page.locator('#sfm-name').evaluate('input => input.checkValidity()'))
        self.assertEqual(posts, [])
        page.locator('#sfm-name').fill(prefix)
        page.locator('#sfm-col-id').fill(second.patient_id)
        page.locator('#sfm-default').check()

        def fail(route):
            route.fulfill(status=503, content_type='application/json',
                          body=json.dumps({'message': '저장 일시 실패'}))

        page.route('**/api/filters', fail)
        page.locator('#sfm-save-apply').focus(); page.keyboard.press('Enter')
        expect(page.locator('#sfm-status')).to_contain_text('저장 일시 실패')
        expect(page.locator('#sfm-save-apply')).to_be_focused()
        expect(page.locator('#sfm-name')).to_have_value(prefix)
        expect(page.locator('#sfm-col-id')).to_have_value(second.patient_id)
        expect(page.locator('#sfm-default')).to_be_checked()
        expect(page.locator('#active-filter-info')).not_to_be_visible()
        self.expect_rows(page, first, second)
        expect(page.locator('#findings')).to_have_value(draft)
        page.unroute('**/api/filters', fail)

        held = []
        page.route('**/api/filters', lambda route: held.append(route))
        page.locator('#sfm-save-apply').click()
        for selector in ('#sfm-close', '#sfm-new', '#sfm-prev', '#sfm-next', '#sfm-save', '#sfm-save-apply'):
            expect(page.locator(selector)).to_be_disabled()
        for _ in range(2):
            page.keyboard.press('Escape')
            expect(page.locator('#saved-filter-manager')).to_be_visible()
        expect(page.locator('#sfm-status')).to_contain_text('처리 중')
        self.expect_rows(page, first, second)
        expect(page.locator('#findings')).to_have_value(draft)
        deadline = time.monotonic() + 10
        while not held and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        self.assertEqual(len(held), 1)
        reply = held[0].fetch()
        self.assertEqual(reply.status, 201)
        saved = reply.json()
        self.addCleanup(self.remove_filter, saved['id'])
        self.assertTrue(saved['isDefault'])
        self.assertEqual(saved['cols']['id'], second.patient_id)
        held[0].fulfill(response=reply)
        expect(page.locator('#saved-filter-manager')).not_to_be_visible()
        expect(page.locator('#savefilter')).to_be_focused()
        page.unroute('**/api/filters')
        self.expect_rows(page, second)
        expect(page.locator('#active-filter-name')).to_have_text(prefix)
        expect(page.locator('#active-filter-state')).to_have_text('Saved')
        self.expect_report_preserved(page, first, draft, versions)

        fresh = self.login()
        expect(fresh.locator('#filterrow input[data-f="id"]')).to_have_value(second.patient_id)
        expect(fresh.locator('#active-filter-name')).to_have_text(prefix)
        expect(fresh.locator('#active-filter-state')).to_have_text('Saved')
        self.expect_rows(fresh, second)
        fresh.locator('#edit-active-filter').click()
        expect(fresh.locator('#sfm-name')).to_have_value(prefix)
        expect(fresh.locator('#sfm-default')).to_be_checked()
        expect(fresh.locator('#sfm-col-id')).to_have_value(second.patient_id)

    def test_navigation_03_filtered_folder_order_and_dirty_previous_next(self):
        prefix = 'NAV-order-' + uuid.uuid4().hex[:8]
        first, second = self.fixture(patient_id=prefix + '-A'), self.fixture(patient_id=prefix + '-B')
        self.seed_report(first)
        versions = self.versions(first)
        needle = prefix + '-needle'
        low = self.create_filter(prefix + '-Z', folder=prefix + '/Alpha', ordinal=10,
                                 description=needle, quick=first.patient_id)
        high = self.create_filter(prefix + '-A', folder=prefix + '/Alpha', ordinal=20,
                                  description=needle, quick=second.patient_id)
        excluded = self.create_filter(prefix + '-B', folder=prefix + '/Beta', ordinal=0,
                                      quick=second.patient_id)
        root = self.create_filter(prefix + '-Root', ordinal=0, description=needle, quick=prefix)
        page = self.login(); self.select(page, first)
        expect(page.locator('#findings')).to_have_value(first.secret)
        draft = first.secret + ' navigation must keep this draft'
        page.locator('#findings').fill(draft)
        page.locator('#quick').fill(prefix)
        page.locator('#managefilters').click()
        page.locator('#sfm-search').fill(prefix)
        self.assertEqual(page.locator('#sfm-list button').evaluate_all(
            'buttons => buttons.map(button => button.dataset.name)'),
            [low['name'], high['name'], excluded['name'], root['name']])
        page.locator('#sfm-list').get_by_role('button', name=low['name'], exact=True).click()
        expect(page.locator('#sfm-position')).to_have_text('1 / 4')
        expect(page.locator('#sfm-prev')).to_be_disabled()
        expect(page.locator('#sfm-next')).to_be_enabled()

        page.locator('#sfm-quick').fill('do not discard this edit')
        page.once('dialog', lambda dialog: dialog.dismiss()); page.locator('#sfm-next').click()
        expect(page.locator('#sfm-name')).to_have_value(low['name'])
        expect(page.locator('#sfm-quick')).to_have_value('do not discard this edit')
        expect(page.locator('#sfm-position')).to_have_text('1 / 4')
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('#sfm-next').focus(); page.keyboard.press('Enter')
        expect(page.locator('#sfm-name')).to_have_value(high['name'])
        expect(page.locator('#sfm-position')).to_have_text('2 / 4')
        expect(page.locator('#sfm-next')).to_be_focused()
        page.keyboard.press('Enter')
        expect(page.locator('#sfm-name')).to_have_value(excluded['name'])
        page.locator('#sfm-prev').focus(); page.keyboard.press('Enter')
        expect(page.locator('#sfm-name')).to_have_value(high['name'])
        expect(page.locator('#sfm-prev')).to_be_focused()
        page.locator('#sfm-search').fill(needle)
        expect(page.locator('#sfm-list button')).to_have_count(3)
        expect(page.locator('#sfm-position')).to_have_text('2 / 3')
        page.locator('#sfm-next').focus(); page.keyboard.press('Enter')
        expect(page.locator('#sfm-name')).to_have_value(root['name'])
        expect(page.locator('#sfm-position')).to_have_text('3 / 3')
        expect(page.locator('#sfm-next')).to_be_disabled()
        expect(page.locator('#sfm-prev')).to_be_focused()
        page.keyboard.press('Enter')
        expect(page.locator('#sfm-name')).to_have_value(high['name'])
        page.locator('#sfm-search').fill(prefix + '-missing')
        expect(page.locator('#sfm-list button')).to_have_count(0)
        expect(page.locator('#sfm-prev')).to_be_disabled()
        expect(page.locator('#sfm-next')).to_be_disabled()
        page.locator('#sfm-search').fill(needle)
        expect(page.locator('#sfm-name')).to_have_value(high['name'])
        expect(page.locator('#sfm-position')).to_have_text('2 / 3')

        if os.environ.get('KIN_EVIDENCE_DIR'):
            evidence = Path(os.environ['KIN_EVIDENCE_DIR'])
            evidence.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(evidence / 'saved-search-navigation.png'))
        page.locator('#sfm-close').click()
        expect(page.locator('#quick')).to_have_value(prefix)
        self.expect_rows(page, first, second)
        self.expect_report_preserved(page, first, draft, versions)
        filters = self.stack.request('GET', '/prefs', 'doctor').body['filters']
        self.assertEqual(next(f for f in filters if f['id'] == low['id']), low)

    def isolated_manager(self, filters, fail_apply=False):
        context = self.browser.new_context(viewport={'width': 1000, 'height': 850})
        self.contexts.append(context);page = context.new_page()
        page.set_content('<button id="opener">Open Manager</button>')
        assets = base.ROOT / 'worklist-v0' / 'hpacs-lite'
        page.add_style_tag(path=str(assets / 'saved-filter-manager.css'))
        for name in ('compound-filter.js', 'saved-filter-manager.js'):
            page.add_script_tag(path=str(assets / name))
        page.evaluate('''({filters, failApply}) => {
          const clone = value => JSON.parse(JSON.stringify(value));
          const snapshot = {name:'',mode:'Radiology',days:-1,quick:'',cols:{},sortKey:null,sortDir:0,isDefault:false};
          window.sfmTest = {filters:clone(filters),saved:[],applied:[],failApply};
          const state = window.sfmTest;
          window.testManager = KinSavedFilterManager.mount({
            columns:{Radiology:[{k:'id',t:'Patient ID',f:'text'}],Technician:[{k:'id',t:'Patient ID',f:'text'}]},
            days:value => value, list:() => state.filters, snapshot:() => clone(snapshot), count:() => 0,
            async save(value) {
              const saved = clone(value);delete saved.createOnly;state.saved.push(clone(saved));
              state.filters = [...state.filters.filter(item => item.name !== saved.name), saved];return saved;
            },
            apply(value) {
              state.applied.push(clone(value));
              if (state.failApply) throw new Error('합성 적용 실패');
              return true;
            },
            async reload() {}, async remove(value) {state.filters=state.filters.filter(item=>item.name!==value.name);}
          });
          document.getElementById('opener').addEventListener('click',()=>window.testManager.open());
        }''', {'filters': filters, 'failApply': fail_apply})
        return page

    def test_navigation_04_invalid_search_cursor_and_keyboard_request_focus(self):
        def saved(name, **changes):
            return dict(dict(name=name,mode='Radiology',days=-1,cols={},quick='',
                sortKey=None,sortDir=0,folder='',description='',ordinal=0,isDefault=False), **changes)
        filters = [saved('A valid'), saved('B invalid mode',mode='Unsupported'),
            saved('C invalid criteria',cols={'$compound':{'version':1,'join':'and',
                'rules':[{'field':'id','op':'unsupported','value':'x'}]}}), saved('D valid')]
        page = self.isolated_manager(filters);page.locator('#opener').focus()
        page.evaluate("testManager.open({name:'A valid'})")
        expect(page.locator('#sfm-position')).to_have_text('1 / 4')
        page.locator('#sfm-next').focus();page.keyboard.press('Enter')
        for index, name in [(2, 'B invalid mode'), (3, 'C invalid criteria')]:
            expect(page.locator('#sfm-position')).to_have_text(f'{index} / 4')
            expect(page.locator('#sfm-fields')).not_to_be_visible()
            expect(page.locator('#sfm-list button[aria-pressed="true"]')).to_have_text(name)
            for action in ('save', 'save-apply', 'apply', 'preview'):
                expect(page.locator('#sfm-' + action)).to_be_disabled()
            expect(page.locator('#sfm-next')).to_be_focused()
            page.keyboard.press('Enter')
        expect(page.locator('#sfm-name')).to_have_value('D valid')
        expect(page.locator('#sfm-position')).to_have_text('4 / 4')
        expect(page.locator('#sfm-next')).to_be_disabled()
        expect(page.locator('#sfm-prev')).to_be_focused()
        for index in (3, 2, 1):
            page.keyboard.press('Enter')
            expect(page.locator('#sfm-position')).to_have_text(f'{index} / 4')
            expect(page.locator('#sfm-prev' if index > 1 else '#sfm-next')).to_be_focused()
        page.locator('#sfm-reload').focus();page.keyboard.press('Enter')
        expect(page.locator('#sfm-status')).to_have_text('저장 검색 목록을 불러왔습니다.')
        expect(page.locator('#sfm-reload')).to_be_focused()
        expect(page.locator('#sfm-position')).to_have_text('1 / 4')
        self.assertEqual(page.evaluate('sfmTest.saved'), [])
        self.assertEqual(page.evaluate('sfmTest.applied'), [])
        page.locator('#sfm-close').click();expect(page.locator('#opener')).to_be_focused()

    def test_navigation_05_saved_apply_failure_keeps_acknowledged_metadata_for_retry(self):
        original = dict(name='Existing Metadata',mode='Radiology',days=-1,cols={},quick='old',
            sortKey=None,sortDir=0,folder='Existing/Folder',description='기존 원문 설명',ordinal=27,isDefault=False)
        page = self.isolated_manager([original], fail_apply=True);page.locator('#opener').click()
        page.locator('#sfm-name').fill(original['name']);page.locator('#sfm-quick').fill('changed criteria')
        page.once('dialog',lambda dialog:dialog.accept())
        page.locator('#sfm-save-apply').focus();page.keyboard.press('Enter')
        expect(page.locator('#sfm-status')).to_contain_text('저장됐지만 목록에 적용하지 못했습니다')
        expect(page.locator('#sfm-status')).to_contain_text('합성 적용 실패')
        expect(page.locator('#sfm-save-apply')).to_be_focused()
        expect(page.locator('#sfm-name')).to_have_value(original['name'])
        expect(page.locator('#sfm-name')).to_have_attribute('readonly','')
        expect(page.locator('#sfm-folder')).to_have_value(original['folder'])
        expect(page.locator('#sfm-description')).to_have_value(original['description'])
        expect(page.locator('#sfm-ordinal')).to_have_value(str(original['ordinal']))
        expect(page.locator('#sfm-quick')).to_have_value('changed criteria')
        self.assertFalse(page.evaluate('''() => {
          const event = new Event('beforeunload', {cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;
        }'''), 'A successful save followed by apply failure must not leave a false dirty baseline')
        first_saved = page.evaluate('sfmTest.saved[0]')
        self.assertEqual(page.evaluate('sfmTest.applied'), [first_saved])
        for key in ('folder','description','ordinal'):
            self.assertEqual(first_saved[key],original[key])
        page.locator('#sfm-save').focus();page.keyboard.press('Enter')
        expect(page.locator('#sfm-status')).to_contain_text('저장 완료')
        expect(page.locator('#sfm-save')).to_be_focused()
        self.assertEqual(page.evaluate('sfmTest.saved'), [first_saved,first_saved])
        self.assertEqual(page.evaluate('sfmTest.filters'), [first_saved])
        confirms=[]
        page.on('dialog',lambda dialog:(confirms.append(dialog.message),dialog.dismiss()))
        page.locator('#sfm-close').click();expect(page.locator('#saved-filter-manager')).not_to_be_visible()
        self.assertEqual(confirms,[]);expect(page.locator('#opener')).to_be_focused()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(SavedFilterNavigationE2E(name)
                              for name in loader.getTestCaseNames(SavedFilterNavigationE2E)
                              if name.startswith('test_navigation_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
