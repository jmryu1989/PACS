# coding: utf-8
"""REQ-D01-COLUMNS -> RISK-D01-HIDDEN-FILTER/OWNER/PREFERENCE-LOSS -> TEST-D01-COLUMNS."""
import os
from pathlib import Path
import re
import unittest
import uuid
from playwright.sync_api import expect
import test_worklist as base


class WorklistColumnsE2E(base.WorklistE2E):
    def open_columns(self, page):
        page.locator('#columnsettings').click()
        expect(page.locator('#column-manager')).to_be_visible()

    def column(self, page, key):
        return page.locator(f'#wc-list [data-column="{key}"]')

    def relogin(self, page, actor):
        old_sid=next(c['value'] for c in page.context.cookies() if c['name']=='kin_sid')
        page.once('dialog',lambda d:d.accept());page.locator('#logout').click()
        page.wait_for_url('**/worklist/hpacs-lite/index.html')
        page.goto(self.stack.proxy+'/')
        # The root page redirects asynchronously; wait for the actual login
        # controls instead of checking visibility before that navigation.
        try:
            page.locator('#username').fill(self.stack.username(actor))
            page.locator('#password').fill(self.stack.passwords[actor])
            page.locator('#kc-login').click()
        except Exception: raise RuntimeError('Same-browser login form failed') from None
        page.wait_for_url('**/worklist/hpacs-lite/main.html',timeout=30000)
        expect(page.locator('#dbstat')).to_contain_text('DB Connected')
        self.assertNotEqual(next(c['value'] for c in page.context.cookies() if c['name']=='kin_sid'),old_sid)
        self.assertEqual(page.context.request.get(self.stack.api+'/me').json()['actor'],self.stack.actor(actor))

    def test_columns_01_hide_order_restore_filter_and_report(self):
        prefix='COL-'+uuid.uuid4().hex[:8]
        first=self.fixture(patient_id=prefix+'A');second=self.fixture(patient_id=prefix+'B')
        self.seed_report(first)
        page=self.login();self.select(page,first)
        page.locator('#findings').fill(first.secret+' unsaved')
        page.locator('#quick').fill(prefix)
        page.locator('#filterrow [data-f="desc"]').fill('Invariant')
        page.locator('#heads [data-key="desc"]').click()
        original=page.locator('#heads th').evaluate_all('els=>els.map(e=>e.dataset.key)')
        self.open_columns(page)
        for key in ('id','name'):expect(self.column(page,key).locator('input[type=checkbox]')).to_be_disabled()
        self.column(page,'desc').locator('input[type=checkbox]').uncheck()
        # Move the second column to the first position, regardless of new columns.
        edge=original[1]
        self.column(page,edge).locator('[data-move="up"]').click()
        expect(self.column(page,edge).locator('[data-move="down"]')).to_be_focused()
        page.locator('#wc-save').click()
        expect(page.locator('#column-manager')).not_to_be_visible()
        expected=[key for key in original if key!='desc'];expected[0],expected[1]=expected[1],expected[0]
        self.assertEqual(page.locator('#heads th').evaluate_all('els=>els.map(e=>e.dataset.key)'),expected)
        expect(page.locator('#filterrow [data-f="desc"]')).to_have_count(0)
        expect(page.locator('#filterlist')).to_contain_text('StudyDesc(Invariant) [숨긴 열]')
        expect(page.locator('#filterlist')).to_contain_text('숨긴 열 정렬: StudyDesc')
        expect(page.locator('#rows tr[data-uid]')).to_have_count(2)
        expect(page.locator('#findings')).to_have_value(first.secret+' unsaved')
        self.assertEqual(page.evaluate('selectedUid'),first.uid)
        self.assertEqual(len(self.versions(first)),1)
        # Reload same browser storage, and a new login for a different account.
        page.once('dialog',lambda d:d.accept());page.reload()
        expect(page.locator('#heads [data-key="desc"]')).to_have_count(0)
        self.assertEqual(page.locator('#heads th').evaluate_all('els=>els.map(e=>e.dataset.key)'),expected)
        other=self.login('doctor2')
        expect(other.locator('#heads [data-key="desc"]')).to_have_count(1)
        page.locator('[data-tab="Technician"]').click()
        expect(page.locator('#heads [data-key="desc"]')).to_have_count(1)
        page.locator('[data-tab="Radiology"]').click()
        expect(page.locator('#heads [data-key="desc"]')).to_have_count(0)
        self.relogin(page,'doctor')
        expect(page.locator('#heads [data-key="desc"]')).to_have_count(0)
        self.relogin(page,'doctor2')
        expect(page.locator('#heads [data-key="desc"]')).to_have_count(1)
        self.relogin(page,'doctor')
        expect(page.locator('#heads [data-key="desc"]')).to_have_count(0)
        self.open_columns(page)
        evidence=Path(os.environ['KIN_EVIDENCE_DIR']);evidence.mkdir(parents=True,exist_ok=True)
        page.screenshot(path=str(evidence/'column-settings.png'))
        page.locator('#wc-reset').click();page.locator('#wc-save').click()
        expect(page.locator('#heads [data-key="desc"]')).to_have_count(1)
        self.assertEqual(page.locator('#heads th').evaluate_all('els=>els.map(e=>e.dataset.key)'),original)

    def test_columns_03_hidden_compound_condition_is_not_removed(self):
        prefix='COL-COMPOUND-'+uuid.uuid4().hex[:8]
        first=self.fixture(patient_id=prefix+'A');second=self.fixture(patient_id=prefix+'B')
        self.patch(first,ov={'desc':'match'});self.patch(second,ov={'desc':'other'})
        page=self.login();page.locator('#quick').fill(prefix)
        page.locator('#managefilters').click();page.locator('#sfm-add-rule').click()
        row=page.locator('#sfm-rules .sfm-rule')
        row.locator('[data-rule-field]').select_option('desc')
        row.locator('[data-rule-op]').select_option('eq');row.locator('[data-rule-value]').fill('match')
        page.locator('#sfm-preview').click()
        expect(page.locator('#rows tr[data-uid]')).to_have_count(1)
        self.open_columns(page);self.column(page,'desc').locator('input[type=checkbox]').uncheck();page.locator('#wc-save').click()
        expect(page.locator('#heads [data-key="desc"]')).to_have_count(0)
        expect(page.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(page.locator(f'#rows tr[data-uid="{first.uid}"]')).to_be_visible()
        expect(page.locator('#filterlist')).to_contain_text('복합 (StudyDesc 같음 match)')
        page.locator('#clearfilter').click();page.locator('#quick').fill(prefix)
        expect(page.locator('#rows tr[data-uid]')).to_have_count(2)

    def test_columns_02_conflict_failure_corrupt_and_cancel(self):
        page=self.login();self.open_columns(page)
        self.column(page,'desc').locator('input[type=checkbox]').uncheck()
        page.once('dialog',lambda d:d.dismiss());page.keyboard.press('Escape')
        expect(page.locator('#column-manager')).to_be_visible()
        page.once('dialog',lambda d:d.accept());page.keyboard.press('Escape')
        expect(page.locator('#columnsettings')).to_be_focused()
        self.open_columns(page);self.column(page,'desc').locator('input[type=checkbox]').uncheck()
        key=page.evaluate('KinWorklistColumns.key(KinAuth.session())')
        # A separate same-origin tab writes its own settings, producing a conflict.
        peer=page.context.new_page();peer.goto(page.url)
        expect(peer.locator('#dbstat')).to_contain_text('DB Connected')
        self.open_columns(peer);self.column(peer,'age').locator('input[type=checkbox]').uncheck();peer.locator('#wc-save').click()
        page.locator('#wc-save').click()
        expect(page.locator('#wc-status')).to_contain_text('다른 창')
        expect(self.column(page,'desc').locator('input[type=checkbox]')).not_to_be_checked()
        expect(page.locator('#heads [data-key="desc"]')).to_have_count(1)
        page.once('dialog',lambda d:d.accept());page.locator('#wc-reload').click()
        expect(self.column(page,'age').locator('input[type=checkbox]')).not_to_be_checked()
        page.locator('#wc-close').click();self.open_columns(page)
        expect(self.column(page,'age').locator('input[type=checkbox]')).not_to_be_checked()
        page.evaluate("() => { window.originalColumnSet=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v){if(k.startsWith('kin-worklist-columns:'))throw new DOMException('full','QuotaExceededError');return window.originalColumnSet.call(this,k,v)}; }")
        self.column(page,'desc').locator('input[type=checkbox]').uncheck();page.locator('#wc-save').click()
        expect(page.locator('#wc-status')).to_contain_text('저장하지 못했습니다')
        expect(page.locator('#heads [data-key="desc"]')).to_have_count(1)
        page.locator('#wc-memory').click()
        expect(page.locator('#heads [data-key="desc"]')).to_have_count(0)
        self.assertNotIn('desc',page.evaluate('key=>JSON.parse(localStorage.getItem(key)).modes.Radiology.hidden',key))
        page.evaluate('key=>{Storage.prototype.setItem=window.originalColumnSet;localStorage.setItem(key,"{broken");}',key)
        page.reload();expect(page.locator('#dbstat')).to_contain_text('DB Connected')
        expect(page.locator('#heads [data-key="desc"]')).to_have_count(1)
        self.open_columns(page);expect(page.locator('#wc-status')).to_contain_text('형식이 잘못')
        page.locator('#wc-reset').click();page.locator('#wc-save').click()
        self.assertEqual(page.evaluate('key=>JSON.parse(localStorage.getItem(key)).version',key),1)
        self.open_columns(page);page.set_viewport_size({'width':600,'height':700})
        for selector in ('#wc-close','#wc-list','#wc-save'):
            page.locator(selector).scroll_into_view_if_needed();expect(page.locator(selector)).to_be_in_viewport()
        self.assertTrue(page.locator('#column-manager').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
        page.evaluate("() => {const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close();}")
        expect(page.locator('#column-manager')).not_to_be_visible()
        expect(page.locator('#columnsettings')).to_be_disabled()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(WorklistColumnsE2E(name) for name in loader.getTestCaseNames(WorklistColumnsE2E) if name.startswith('test_columns_'))

if __name__=='__main__': unittest.main(verbosity=2)
