# coding: utf-8
"""TEST-D01-FILTER-MANAGER: saved-search editing through the actual worklist."""
from __future__ import annotations

import json
import time
import unittest
import uuid

from playwright.sync_api import expect
import test_worklist as base


class SavedFilterManagerE2E(base.WorklistE2E):
    def remove_filter(self, key):
        result = self.stack.request('DELETE', f'/filters/{key}', 'doctor')
        self.assertIn(result.status, (200, 404))

    def save(self, page):
        with page.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/api/filters')) as response:
            page.locator('#sfm-save').click()
        self.assertEqual(response.value.status, 201)
        saved = response.value.json()
        self.addCleanup(self.remove_filter, saved['id'])
        expect(page.locator('#sfm-status')).to_contain_text('저장 완료')
        return saved

    def open_manager(self, page):
        page.locator('#managefilters').click()
        expect(page.locator('#saved-filter-manager')).to_be_visible()

    def test_manager_01_create_edit_default_relogin_apply_delete(self):
        prefix = 'SFM-' + uuid.uuid4().hex[:10]
        first = self.fixture(patient_id=prefix + '-A')
        second = self.fixture(patient_id=prefix + '-B')
        self.seed_report(first)
        page = self.login(); self.select(page, first)
        expect(page.locator('#findings')).to_have_value(first.secret)
        page.locator('#quick').fill(prefix)
        expect(page.locator('#rows tr[data-uid]')).to_have_count(2)
        self.open_manager(page)
        name = prefix + '"><img src=x onerror="window.badFilter=1">'
        page.locator('#sfm-name').fill(name)
        page.locator('#sfm-default').check()
        saved = self.save(page)
        self.assertTrue(saved['isDefault'])
        expect(page.locator('#sfm-list img')).to_have_count(0)
        self.assertIsNone(page.evaluate('window.badFilter'))
        page.locator('#sfm-col-id').fill(second.patient_id)
        page.locator('#sfm-sort').select_option('date')
        page.locator('#sfm-direction').select_option('-1')
        expect(page.locator('#sfm-count')).to_contain_text('1건')
        edited = self.save(page)
        self.assertEqual(edited['id'], saved['id'])
        self.assertEqual(edited['cols']['id'], second.patient_id)
        evidence = base.ROOT.parent / 'tmp' / 'saved-filter-manager'
        evidence.mkdir(exist_ok=True)
        page.screenshot(path=str(evidence / 'manager.png'))
        page.locator('#sfm-close').click()
        expect(page.locator('#rows tr[data-uid]')).to_have_count(2)
        expect(page.locator('#findings')).to_have_value(first.secret)
        self.open_manager(page)
        page.locator('#sfm-search').fill(prefix)
        page.locator('#sfm-list button').click()
        page.locator('#sfm-apply').click()
        expect(page.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(page.locator(f'#rows tr[data-uid="{second.uid}"]')).to_be_visible()
        expect(page.locator('#findings')).to_have_value(first.secret)
        fresh = self.login()
        expect(fresh.locator('#filterrow input[data-f="id"]')).to_have_value(second.patient_id)
        expect(fresh.locator('#rows tr[data-uid]')).to_have_count(1)
        other = self.login('doctor2'); self.open_manager(other)
        other.locator('#sfm-search').fill(prefix)
        expect(other.locator('#sfm-list')).to_contain_text('일치하는 저장 검색이 없습니다')
        for method in ('DELETE', 'PATCH'):
            suffix = '/default' if method == 'PATCH' else ''
            result = self.stack.request(method, f'/filters/{saved["id"]}{suffix}', 'doctor2',
                                        {'on': True} if method == 'PATCH' else None)
            self.assertEqual(result.status, 404)
        self.open_manager(fresh)
        fresh.locator('#sfm-search').fill(prefix); fresh.locator('#sfm-list button').click()
        fresh.locator('#sfm-default').uncheck()
        self.assertFalse(self.save(fresh)['isDefault'])
        fresh.once('dialog', lambda d: d.dismiss()); fresh.locator('#sfm-delete').click()
        expect(fresh.locator('#sfm-list button')).to_have_count(1)
        fresh.once('dialog', lambda d: d.accept())
        with fresh.expect_response(lambda r: r.request.method == 'DELETE' and '/api/filters/' in r.url):
            fresh.locator('#sfm-delete').click()
        expect(fresh.locator('#sfm-status')).to_contain_text('삭제했습니다')
        expect(fresh.locator('#sfm-list button')).to_have_count(0)
        self.assertEqual(len(self.versions(first)), 1)

    def test_manager_02_failure_busy_and_changed_account_preserve_input(self):
        page = self.login(); self.open_manager(page)
        name = 'SFM-failure-' + uuid.uuid4().hex[:10]
        page.locator('#sfm-name').fill(name)
        page.locator('#sfm-quick').fill('keep this search')
        def fail(route):
            route.fulfill(status=503, content_type='application/json', body=json.dumps({'message': '저장 일시 실패'}))
        page.route('**/api/filters', fail)
        page.locator('#sfm-save').click()
        expect(page.locator('#sfm-status')).to_contain_text('저장 일시 실패')
        expect(page.locator('#sfm-name')).to_have_value(name)
        expect(page.locator('#sfm-quick')).to_have_value('keep this search')
        page.unroute('**/api/filters', fail)
        held = []
        page.route('**/api/filters', lambda route: held.append(route))
        page.locator('#sfm-save').click()
        expect(page.locator('#sfm-close')).to_be_disabled()
        expect(page.locator('#sfm-new')).to_be_disabled()
        page.keyboard.press('Escape')
        expect(page.locator('#saved-filter-manager')).to_be_visible()
        # Busy begins with the account check, before the POST route callback.
        expect(page.locator('#sfm-status')).to_contain_text('처리 중')
        deadline = time.monotonic() + 10
        while not held and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        self.assertEqual(len(held), 1)
        reply = held[0].fetch(); saved = reply.json()
        self.addCleanup(self.remove_filter, saved['id'])
        page.evaluate("() => { goOffline(new Error('synthetic disconnect')); stopReconnect(); }")
        held[0].fulfill(response=reply)
        expect(page.locator('#sfm-status')).to_contain_text('저장 완료')
        self.assertIsNone(page.evaluate("localStorage.getItem('kin-filters')"))
        page.unroute('**/api/filters')
        page.locator('#sfm-quick').fill('keep while offline')
        page.locator('#sfm-save').click()
        expect(page.locator('#sfm-status')).to_contain_text('서버 연결을 확인')
        expect(page.locator('#sfm-quick')).to_have_value('keep while offline')
        page.evaluate('async () => { goOnline(await fetchBootstrap()); }')
        page.locator('#sfm-quick').fill('edited but wrong account')
        posts = []
        page.on('request', lambda r: posts.append(r.url) if r.method == 'POST' and r.url.endswith('/api/filters') else None)
        def changed(route):
            reply = route.fetch(); data = reply.json(); data['sub'] = str(uuid.uuid4())
            route.fulfill(response=reply, json=data)
        page.route('**/api/me', changed)
        page.locator('#sfm-save').click()
        expect(page.locator('#sfm-status')).to_contain_text('계정이 변경')
        expect(page.locator('#sfm-quick')).to_have_value('edited but wrong account')
        self.assertEqual(posts, [])

    def test_manager_03_keyboard_cancel_and_small_layout(self):
        page = self.login()
        page.locator('#managefilters').focus(); page.keyboard.press('Enter')
        expect(page.locator('#sfm-search')).to_be_focused()
        for width, height in ((900, 600), (600, 900)):
            page.set_viewport_size(dict(width=width, height=height))
            for selector in ('#sfm-name', '#sfm-col-id', '#sfm-save', '#sfm-close'):
                page.locator(selector).scroll_into_view_if_needed()
                expect(page.locator(selector)).to_be_in_viewport()
            self.assertTrue(page.locator('#saved-filter-manager').evaluate('e => e.scrollWidth <= e.clientWidth + 1'))
        page.locator('#sfm-name').fill('unsaved')
        page.once('dialog', lambda d: d.dismiss()); page.keyboard.press('Escape')
        expect(page.locator('#saved-filter-manager')).to_be_visible()
        expect(page.locator('#sfm-name')).to_have_value('unsaved')
        page.once('dialog', lambda d: d.accept()); page.keyboard.press('Escape')
        expect(page.locator('#saved-filter-manager')).not_to_be_visible()
        expect(page.locator('#managefilters')).to_be_focused()

    def test_manager_04_invalid_missing_and_unresponsive_search_recovery(self):
        prefix = 'SFM-recovery-' + uuid.uuid4().hex[:10]
        saved = []
        for suffix, mode in (('good', 'Radiology'), ('broken', 'unsupported')):
            result = self.stack.request('POST', '/filters', 'doctor',
                                        dict(name=prefix + suffix, mode=mode, days=-1, cols={}))
            self.assertEqual(result.status, 201)
            saved.append(result.body); self.addCleanup(self.remove_filter, result.body['id'])
        page = self.login(); self.open_manager(page)
        page.locator('#sfm-search').fill(prefix)
        page.locator('#sfm-list button', has_text=prefix + 'good').click()
        page.locator('#sfm-list button', has_text=prefix + 'broken').click()
        expect(page.locator('#sfm-status')).to_contain_text('업무 화면을 확인할 수 없습니다')
        expect(page.locator('#sfm-delete')).to_be_disabled()
        expect(page.locator('#sfm-apply')).to_be_disabled()
        expect(page.locator('#sfm-fields')).to_be_hidden()
        page.locator('#sfm-list button', has_text=prefix + 'good').click()
        expect(page.locator('#sfm-fields')).to_be_visible()
        self.remove_filter(saved[0]['id'])
        page.evaluate('async () => { goOnline(await fetchBootstrap()); }')
        page.locator('#sfm-delete').click()
        expect(page.locator('#sfm-status')).to_contain_text('저장 검색이 변경')
        page.locator('#sfm-new').click()
        page.locator('#sfm-name').fill(prefix + 'timeout')
        held = []
        page.route('**/api/me', lambda route: held.append(route))
        page.locator('#sfm-save').click()
        expect(page.locator('#sfm-status')).to_contain_text('응답 시간이 초과', timeout=22000)
        expect(page.locator('#sfm-save')).to_be_enabled()
        expect(page.locator('#sfm-close')).to_be_enabled()
        expect(page.locator('#sfm-name')).to_have_value(prefix + 'timeout')
        for route in held: route.abort()
        page.unroute('**/api/me')
        self.save(page)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(SavedFilterManagerE2E(name) for name in loader.getTestCaseNames(SavedFilterManagerE2E)
                              if name.startswith('test_manager_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
