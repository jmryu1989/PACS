# coding: utf-8
"""TEST-D01-COMPOUND-SEARCH: real list preview and personal saved conditions.

REQ-D01-COMPOUND-SEARCH -> RISK-D01-FILTER-BROADEN/TARGET/PERSISTENCE
Only owned local C-STORE fixtures and temporary accounts are changed.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import unittest
import uuid

from playwright.sync_api import expect

import test_saved_filter_manager as manager
from test_prior_selection import synthetic_ct


class CompoundSearchE2E(manager.SavedFilterManagerE2E):
    def rule(self, page, field, op, value=None, value2=None, index=None):
        if index is None:
            index = page.locator('#sfm-rules .sfm-rule').count()
            page.locator('#sfm-add-rule').click()
        row = page.locator('#sfm-rules .sfm-rule').nth(index)
        row.locator('[data-rule-field]').select_option(field)
        row.locator('[data-rule-op]').select_option(op)
        if value is not None:
            control = row.locator('[data-rule-value]')
            if control.evaluate('el => el.tagName') == 'SELECT':
                control.select_option(value)
            else:
                control.fill(value)
        if value2 is not None:
            row.locator('[data-rule-value2]').fill(value2)
        return row

    def count_is(self, page, count):
        expect(page.locator('#sfm-count')).to_contain_text(
            re.compile(rf'목록 기준 {count}건(?:\s|[·.]|$)'))

    def rows_are(self, page, fixtures):
        expected = sorted(f.uid for f in fixtures)
        expect(page.locator('#rows tr[data-uid]')).to_have_count(len(expected))
        self.assertEqual(sorted(page.locator('#rows tr[data-uid]').evaluate_all(
            'rows => rows.map(row => row.dataset.uid)')), expected)

    def preview(self, page):
        page.locator('#sfm-preview').click()
        expect(page.locator('#saved-filter-manager')).not_to_be_visible()

    def screenshot(self, page, name):
        evidence = Path(os.environ.get('KIN_EVIDENCE_DIR', str(
            manager.base.ROOT.parent / 'tmp' / ('compound-search-' + uuid.uuid4().hex[:12]))))
        evidence.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(evidence / name))

    def test_compound_01_preview_default_relogin_account_and_clear(self):
        """Basic AND compound OR is explicit, persisted and never retargets a report."""
        token = uuid.uuid4().hex[:8]
        prefix = 'CMP-' + token
        first = self.fixture(patient_id=prefix + '-A')
        second = self.fixture(patient_id=prefix + '-B')
        third = self.fixture(patient_id=prefix + '-C')
        # This also satisfies the first OR branch, but must fail the basic prefix.
        outside = self.fixture(patient_id='OTHER-' + token + '-A')
        self.seed_report(first)
        original_versions = self.versions(first)
        page = self.login(); self.select(page, first)
        unsaved = first.secret + ' / not committed while filtering'
        page.locator('#findings').fill(unsaved)
        page.locator('#quick').fill(prefix)
        self.rows_are(page, [first, second, third])
        posts = []
        page.on('request', lambda request: posts.append(request.post_data_json)
                if request.method == 'POST' and request.url.endswith('/api/filters') else None)
        self.open_manager(page)
        expect(page.locator('#sfm-name')).to_have_value('')
        expect(page.locator('.sfm-compound')).to_contain_text('목록에만 적용')
        expect(page.locator('.sfm-compound')).to_contain_text('계정에 보관하려면')
        page.locator('#sfm-join').select_option('or')
        self.rule(page, 'id', 'contains', token + '-A')
        self.rule(page, 'id', 'eq', second.patient_id)
        self.count_is(page, 2)
        page.locator('.sfm-compound').scroll_into_view_if_needed()
        expect(page.locator('#sfm-join')).to_be_in_viewport()
        for index in (0, 1):
            expect(page.locator('#sfm-rules .sfm-rule').nth(index).locator(
                '[data-rule-value]')).to_be_in_viewport()
        self.screenshot(page, 'compound-or-editor.png')
        self.preview(page)
        self.assertEqual(posts, [], 'Preview must not create a personal filter')
        self.rows_are(page, [first, second])
        expect(page.locator('#filterlist')).to_contain_text('복합')
        expect(page.locator('#filterlist')).to_contain_text('OR')
        expect(page.locator('#findings')).to_have_value(unsaved)
        self.assertEqual(page.evaluate('selectedUid'), first.uid)
        self.assertEqual(self.versions(first), original_versions)
        self.screenshot(page, 'compound-preview.png')

        self.open_manager(page)
        name = prefix + '-personal'
        page.locator('#sfm-name').fill(name)
        page.locator('#sfm-folder').fill('개인/복합 검색')
        page.locator('#sfm-description').fill('Two alternatives inside the basic patient search')
        page.locator('#sfm-default').check()
        saved = self.save(page)
        expression = {'version': 1, 'join': 'or', 'rules': [
            {'field': 'id', 'op': 'contains', 'value': token + '-A'},
            {'field': 'id', 'op': 'eq', 'value': second.patient_id},
        ]}
        self.assertEqual(saved['cols']['$compound'], expression)
        self.assertEqual(saved['quick'], prefix)
        self.assertTrue(saved['isDefault'])
        page.locator('#sfm-close').click()
        expect(page.locator('#chips button', has_text=name)).to_contain_text('(2)')
        fresh = self.login()
        self.rows_are(fresh, [first, second])
        expect(fresh.locator('#filterlist')).to_contain_text('OR')
        self.open_manager(fresh)
        fresh.locator('#sfm-search').fill(name)
        fresh.locator('#sfm-list button', has_text=name).click()
        expect(fresh.locator('#sfm-join')).to_have_value('or')
        expect(fresh.locator('#sfm-rules .sfm-rule')).to_have_count(2)
        expect(fresh.locator('#sfm-folder')).to_have_value('개인/복합 검색')
        self.count_is(fresh, 2)
        fresh.locator('#sfm-close').click()
        other = self.login('doctor2')
        expect(other.locator('#chips button', has_text=name)).to_have_count(0)
        self.open_manager(other); other.locator('#sfm-search').fill(name)
        expect(other.locator('#sfm-list button')).to_have_count(0)
        prefs = self.stack.request('GET', '/prefs', 'doctor2')
        self.assertEqual(prefs.status, 200)
        self.assertFalse(any(f['name'] == name for f in prefs.body['filters']))

        fresh.locator('#clearfilter').click()
        expect(fresh.locator('#quick')).to_have_value('')
        expect(fresh.locator('#filterlist')).not_to_contain_text('복합')
        fresh.locator('#quick').fill(prefix)
        self.rows_are(fresh, [first, second, third])
        self.open_manager(fresh)
        expect(fresh.locator('#sfm-rules .sfm-rule')).to_have_count(0)
        self.assertEqual(self.versions(first), original_versions)
        self.assertEqual(self.versions(outside), [])

    def test_compound_02_exact_negative_missing_and_date_bounds(self):
        """Real source dates have inclusive bounds; missing data never passes a negative."""
        prefix = 'CMP-date-' + uuid.uuid4().hex[:8]
        fixtures = [synthetic_ct(self.stack, prefix + suffix, suffix, date, slices=1)
                    for suffix, date in (('A', '20260201'), ('B', '20260228'),
                                         ('C', '20260301'), ('M', ''))]
        for fixture, description in zip(fixtures, ('Chest', 'Chest followup', 'Abdomen', None)):
            self.patch(fixture, ov={'desc': description})
        page = self.login(); page.locator('#quick').fill(prefix)
        self.rows_are(page, fixtures)
        self.open_manager(page)
        for op, value, count in (('contains', 'chest', 2), ('eq', 'CHEST', 1),
                                 ('notContains', 'CHEST', 1), ('neq', 'Chest', 2),
                                 ('empty', None, 1), ('notEmpty', None, 3)):
            with self.subTest(text_operator=op):
                self.rule(page, 'desc', op, value, index=0 if page.locator('#sfm-rules .sfm-rule').count() else None)
                self.count_is(page, count)
                self.preview(page)
                wanted = {'contains': fixtures[:2], 'eq': fixtures[:1],
                          'notContains': fixtures[2:3], 'neq': fixtures[1:3],
                          'empty': fixtures[3:], 'notEmpty': fixtures[:3]}[op]
                self.rows_are(page, wanted)
                self.open_manager(page)

        self.rule(page, 'date', 'between', '2026-02-01', '2026-02-28', index=0)
        self.count_is(page, 2)
        self.preview(page); self.rows_are(page, fixtures[:2]); self.open_manager(page)
        for op, value, count, wanted in (
            ('eq', '2026-02-01', 1, fixtures[:1]),
            ('neq', '2026-02-01', 2, fixtures[1:3]),
            ('empty', None, 1, fixtures[3:]),
        ):
            with self.subTest(date_operator=op):
                self.rule(page, 'date', op, value, index=0)
                self.count_is(page, count)
                self.preview(page); self.rows_are(page, wanted); self.open_manager(page)

        self.rule(page, 'date', 'between', '2026-03-01', '2026-02-01', index=0)
        page.locator('#sfm-name').fill(prefix + '-invalid')
        expect(page.locator('#sfm-count')).to_contain_text('복합 조건 오류:')
        invalid_posts = []
        page.on('request', lambda request: invalid_posts.append(request.url)
                if request.method == 'POST' and request.url.endswith('/api/filters') else None)
        page.locator('#sfm-preview').click()
        expect(page.locator('#sfm-status')).to_contain_text('복합 조건을 적용하지 못했습니다:')
        expect(page.locator('#saved-filter-manager')).to_be_visible()
        self.rows_are(page, fixtures[3:])
        page.locator('#sfm-save').click()
        expect(page.locator('#sfm-status')).to_contain_text('복합 조건을 저장하지 못했습니다:')
        self.assertEqual(invalid_posts, [])
        expect(page.locator('#sfm-rules [data-rule-value]')).to_have_value('2026-03-01')
        expect(page.locator('#sfm-rules [data-rule-value2]')).to_have_value('2026-02-01')
        # Repair only the invalid endpoint; the intended rule remains editable.
        page.locator('#sfm-rules [data-rule-value2]').fill('2026-03-01')
        self.count_is(page, 1)
        self.preview(page); self.rows_are(page, fixtures[2:3])

    def test_compound_03_failed_save_and_unsupported_stored_condition(self):
        """A failed write retains rules; an unknown stored expression cannot broaden results."""
        prefix = 'CMP-fail-' + uuid.uuid4().hex[:8]
        first, second = self.fixture(patient_id=prefix + '-A'), self.fixture(patient_id=prefix + '-B')
        page = self.login(); page.locator('#quick').fill(prefix)
        self.open_manager(page)
        name = prefix + '-good'
        page.locator('#sfm-name').fill(name)
        self.rule(page, 'id', 'eq', first.patient_id)
        self.rule(page, 'modality', 'eq', 'CT')
        self.count_is(page, 1)
        requests = []
        def fail(route):
            requests.append(route.request.post_data_json)
            route.fulfill(status=503, content_type='application/json',
                          body=json.dumps({'message': '복합 검색 저장 일시 실패'}))
        page.route('**/api/filters', fail)
        page.locator('#sfm-save').click()
        expect(page.locator('#sfm-status')).to_contain_text('저장 일시 실패')
        expect(page.locator('#sfm-name')).to_have_value(name)
        expect(page.locator('#sfm-rules .sfm-rule')).to_have_count(2)
        expect(page.locator('#sfm-rules .sfm-rule').first.locator('[data-rule-value]')).to_have_value(first.patient_id)
        expect(page.locator('#sfm-join')).to_have_value('and')
        self.count_is(page, 1)
        page.unroute('**/api/filters', fail)
        saved = self.save(page)
        self.assertEqual(len(requests), 1)
        self.assertEqual(saved['cols']['$compound'], requests[0]['cols']['$compound'])
        page.locator('#sfm-apply').click()
        self.rows_are(page, [first])
        expect(page.locator('#filterlist')).to_contain_text('AND')

        bad_name = prefix + '-unsupported'
        unsupported = {'version': 99, 'join': 'or', 'rules': [{'field': 'id', 'op': 'eq', 'value': second.patient_id}]}
        result = self.stack.request('POST', '/filters', 'doctor',
                                    {'name': bad_name, 'mode': 'Radiology', 'days': -1,
                                     'quick': '', 'cols': {'$compound': unsupported}})
        self.assertEqual(result.status, 201)
        self.addCleanup(self.remove_filter, result.body['id'])
        page.evaluate('reloadPrefs()')
        page.locator('#chips button', has_text=bad_name).click()
        expect(page.locator('#toast')).to_contain_text('복합')
        self.rows_are(page, [first])
        expect(page.locator('#quick')).to_have_value(prefix)
        self.open_manager(page)
        page.locator('#sfm-search').fill(bad_name)
        page.locator('#sfm-list button', has_text=bad_name).click()
        expect(page.locator('#sfm-status')).to_contain_text('저장된 복합 조건을 확인할 수 없습니다:')
        expect(page.locator('#sfm-fields')).to_be_hidden()
        for selector in ('#sfm-apply', '#sfm-preview', '#sfm-save'):
            expect(page.locator(selector)).to_be_disabled()
        prefs = self.stack.request('GET', '/prefs', 'doctor')
        persisted = next(f for f in prefs.body['filters'] if f['name'] == bad_name)
        self.assertEqual(persisted['cols']['$compound'], unsupported)
        page.locator('#sfm-close').click()

        # Context-menu default writes must validate before a PATCH can be sent.
        default_writes = []
        page.on('request', lambda request: default_writes.append(request.post_data_json)
                if request.method == 'PATCH' and '/api/filters/' in request.url else None)
        page.locator('#chips button', has_text=bad_name).click(button='right')
        page.locator('#ctx').get_by_text('Set as Default', exact=True).click()
        expect(page.locator('#toast')).to_contain_text('복합')
        self.assertEqual(default_writes, [])
        prefs = self.stack.request('GET', '/prefs', 'doctor')
        persisted = next(f for f in prefs.body['filters'] if f['name'] == bad_name)
        self.assertFalse(persisted['isDefault'])
        self.rows_are(page, [first])

        # Text inputs strip CR/LF; reject stored multiline values before mounting
        # an editor so the displayed search cannot differ from the saved one.
        newline_name = prefix + '-newline'
        multiline = {'version': 1, 'join': 'and', 'rules': [
            {'field': 'id', 'op': 'eq', 'value': first.patient_id + '\r\n'}]}
        inserted = self.stack.request('POST', '/filters', 'doctor',
                                     {'name': newline_name, 'mode': 'Radiology', 'days': -1,
                                      'quick': prefix, 'cols': {'$compound': multiline}})
        self.assertEqual(inserted.status, 201)
        self.addCleanup(self.remove_filter, inserted.body['id'])
        page.evaluate('reloadPrefs()')
        self.open_manager(page)
        page.locator('#sfm-search').fill(newline_name)
        page.locator('#sfm-list button', has_text=newline_name).click()
        expect(page.locator('#sfm-status')).to_contain_text('저장된 복합 조건을 확인할 수 없습니다:')
        expect(page.locator('#sfm-fields')).to_be_hidden()
        for selector in ('#sfm-apply', '#sfm-preview', '#sfm-save'):
            expect(page.locator(selector)).to_be_disabled()
        prefs = self.stack.request('GET', '/prefs', 'doctor')
        persisted = next(f for f in prefs.body['filters'] if f['name'] == newline_name)
        self.assertEqual(persisted['cols']['$compound'], multiline)
        page.locator('#sfm-close').click()

        # A legacy or external API writer can mark an unsupported expression as
        # default. Fresh login must not silently substitute an unfiltered list.
        defaulted = self.stack.request('POST', '/filters', 'doctor',
                                       {'name': bad_name, 'mode': 'Radiology', 'days': -1,
                                        'quick': prefix, 'cols': {'$compound': unsupported},
                                        'isDefault': True})
        self.assertEqual(defaulted.status, 201)
        self.assertEqual(defaulted.body['id'], result.body['id'])
        self.assertTrue(defaulted.body['isDefault'])
        fresh = self.login()
        self.rows_are(fresh, [])
        expect(fresh.locator('#filterlist')).to_contain_text('복합 조건 오류')
        expect(fresh.locator('#toast')).to_contain_text('복합')
        expect(fresh.locator('#toast')).not_to_contain_text('적용됨')
        # Refresh is available before colleague names finish loading. The saved
        # scope must already be established, not deferred until that lookup ends.
        held = []
        def hold_colleagues(route):
            held.append(route)
        fresh.route('**/api/colleagues', hold_colleagues)
        try:
            with fresh.expect_request('**/api/colleagues'):
                fresh.reload()
            expect(fresh.locator('#dbstat')).to_contain_text('DB Connected')
            with fresh.expect_response(lambda response: response.request.method == 'GET'
                                       and response.url.split('?')[0].endswith('/api/studies')):
                fresh.locator('#refresh').click()
            fresh.wait_for_function(
                'uids => uids.every(uid => studies.some(study => study.uid === uid))',
                arg=[first.uid, second.uid])
            self.assertTrue(held, 'The colleague lookup must still be held during Refresh')
            self.rows_are(fresh, [])
            expect(fresh.locator('#filterlist')).to_contain_text('복합 조건 오류')
            expect(fresh.locator('#toast')).to_contain_text('복합')
            expect(fresh.locator('#toast')).not_to_contain_text('적용됨')
        finally:
            try:
                for route in held:
                    route.abort()
            finally:
                fresh.unroute('**/api/colleagues', hold_colleagues)
        fresh.locator('#clearfilter').click()
        expect(fresh.locator('#filterlist')).not_to_contain_text('복합 조건 오류')
        fresh.locator('#quick').fill(prefix)
        self.rows_are(fresh, [first, second])
        self.assertEqual(self.versions(first), [])

    def test_compound_04_mode_switch_preserves_unavailable_field(self):
        """An unavailable field stays visible and invalid until the intended mode returns."""
        prefix = 'CMP-mode-' + uuid.uuid4().hex[:8]
        first, second = self.fixture(patient_id=prefix + '-A'), self.fixture(patient_id=prefix + '-B')
        self.patch(first, ward='ER'); self.patch(second, ward='OPD')
        page = self.login(); page.locator('#quick').fill(prefix)
        self.open_manager(page)
        page.locator('#sfm-name').fill(prefix)
        page.locator('#sfm-mode').select_option('Technician')
        self.rule(page, 'ward', 'eq', 'ER')
        self.count_is(page, 1)
        page.locator('#sfm-mode').select_option('Radiology')
        expect(page.locator('#sfm-rules [data-rule-field]')).to_have_value('ward')
        expect(page.locator('#sfm-rules [data-rule-value]')).to_have_value('ER')
        expect(page.locator('#sfm-count')).to_contain_text('복합 조건 오류:')
        invalid_posts = []
        page.on('request', lambda request: invalid_posts.append(request.url)
                if request.method == 'POST' and request.url.endswith('/api/filters') else None)
        page.locator('#sfm-preview').click()
        expect(page.locator('#sfm-status')).to_contain_text('복합 조건을 적용하지 못했습니다:')
        self.rows_are(page, [first, second])
        page.locator('#sfm-save').click()
        expect(page.locator('#sfm-status')).to_contain_text('복합 조건을 저장하지 못했습니다:')
        self.assertEqual(invalid_posts, [])
        page.locator('#sfm-mode').select_option('Technician')
        self.count_is(page, 1)
        page.locator('#sfm-name').fill(prefix)
        saved = self.save(page)
        self.assertEqual(saved['cols']['$compound'], {'version': 1, 'join': 'and',
                         'rules': [{'field': 'ward', 'op': 'eq', 'value': 'ER'}]})
        page.locator('#sfm-apply').click()
        self.rows_are(page, [first])
        self.assertEqual(page.evaluate('mode'), 'Technician')
        # The toolbar's older save path must enforce the same contract as the
        # manager after a main worklist tab makes a condition unavailable.
        page.locator('.tabs > [data-tab="Radiology"]').click()
        self.rows_are(page, [])
        expect(page.locator('#filterlist')).to_contain_text('복합 조건 오류')
        toolbar_writes, prompts = [], []
        page.on('request', lambda request: toolbar_writes.append(request.url)
                if request.method == 'POST' and request.url.endswith('/api/filters') else None)
        def unexpected_prompt(dialog):
            prompts.append(dialog.message)
            dialog.dismiss()
        page.on('dialog', unexpected_prompt)
        page.locator('#savefilter').click()
        expect(page.locator('#toast')).to_contain_text('복합')
        self.assertEqual(prompts, [])
        self.assertEqual(toolbar_writes, [])
        page.remove_listener('dialog', unexpected_prompt)
        self.rows_are(page, [])
        page.locator('.tabs > [data-tab="Technician"]').click()
        self.rows_are(page, [first])
        self.open_manager(page)
        page.set_viewport_size({'width': 900, 'height': 600})
        for selector in ('#sfm-join', '#sfm-add-rule', '#sfm-preview', '#sfm-close'):
            page.locator(selector).scroll_into_view_if_needed()
            expect(page.locator(selector)).to_be_in_viewport()
        self.assertTrue(page.locator('#saved-filter-manager').evaluate(
            'el => el.scrollWidth <= el.clientWidth + 1'))
        self.screenshot(page, 'compound-small-layout.png')
        page.locator('#sfm-clear-rules').click()
        expect(page.locator('#sfm-rules .sfm-rule')).to_have_count(0)
        self.count_is(page, 2)
        self.preview(page); self.rows_are(page, [first, second])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(CompoundSearchE2E(name)
                              for name in loader.getTestCaseNames(CompoundSearchE2E)
                              if name.startswith('test_compound_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
