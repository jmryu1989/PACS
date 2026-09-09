"""REQ-D01-NESTED-PAGES -> RISK-FILTER-BROADEN/TARGET/UNBOUNDED-DOM -> TEST-D01-NESTED-PAGES."""
import copy,json,unittest,uuid
from playwright.sync_api import expect
from test_compound_search import CompoundSearchE2E

class NestedPagesE2E(CompoundSearchE2E):
    def fill_rule(self,row,field,op,value):
        row.locator('[data-rule-field]').select_option(field)
        row.locator('[data-rule-op]').select_option(op)
        row.locator('[data-rule-value]').fill(value)

    def test_nested_01_save_restore_and_empty_group_rejection(self):
        prefix='NEST-'+uuid.uuid4().hex[:8]
        a=self.fixture(patient_id=prefix+'A');b=self.fixture(patient_id=prefix+'B');c=self.fixture(patient_id=prefix+'C')
        self.seed_report(a);page=self.login();self.select(page,a)
        page.locator('#findings').fill('Nested search unsaved report');page.locator('#quick').fill(prefix)
        self.open_manager(page);page.locator('#sfm-add-group').click()
        group=page.locator('#sfm-rules > .sfm-group')
        page.locator('#sfm-preview').click();expect(page.locator('#sfm-status')).to_contain_text('비어 있을 수 없')
        expect(page.locator('#saved-filter-manager')).to_be_visible()
        group.locator(':scope > [data-group-action=rule]').click()
        self.fill_rule(group.locator('.sfm-rule').nth(0),'id','eq',a.patient_id)
        group.locator(':scope > [data-group-action=group]').click()
        inner=group.locator('.sfm-group');inner.locator(':scope > .sfm-group-join').select_option('and')
        inner.locator(':scope > [data-group-action=rule]').click()
        self.fill_rule(inner.locator('.sfm-rule'),'id','eq',b.patient_id)
        self.rule(page,'id','neq',c.patient_id)
        self.count_is(page,2);page.locator('#sfm-name').fill(prefix);page.locator('#sfm-default').check()
        saved=self.save(page);self.assertEqual(saved['cols']['$compound']['rules'][0]['rules'][1]['join'],'and')
        self.preview(page);self.rows_are(page,[a,b])
        expect(page.locator('#filterlist')).to_contain_text('OR (ID 같음 '+b.patient_id+')')
        expect(page.locator('#findings')).to_have_value('Nested search unsaved report')
        self.assertEqual(page.evaluate('selectedUid'),a.uid)
        fresh=self.login();self.rows_are(fresh,[a,b]);self.open_manager(fresh)
        expect(fresh.locator('#sfm-rules .sfm-group')).to_have_count(2)
        fresh.set_viewport_size({'width':600,'height':800})
        fresh.locator('#sfm-rules').scroll_into_view_if_needed()
        self.assertTrue(fresh.locator('#saved-filter-manager').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
        self.screenshot(fresh,'nested-editor.png')
        fresh.locator('#sfm-rules > .sfm-group > [data-group-action=remove]').click()
        fresh.once('dialog',lambda d:d.accept());fresh.locator('#sfm-close').click()
        self.rows_are(fresh,[a,b]);self.open_manager(fresh)
        expect(fresh.locator('#sfm-rules .sfm-group')).to_have_count(2)

    def test_nested_02_pages_preserve_target_and_global_order(self):
        prefix='PAGES-'+uuid.uuid4().hex[:8]+'-'
        a=self.fixture(patient_id=prefix+'0024');b=self.fixture(patient_id=prefix+'0025')
        self.seed_report(a);self.seed_report(b);page=self.login();self.select(page,a)
        page.locator('#findings').fill('Page browsing preserves this report')
        source=page.request.get(self.stack.api+'/studies').json()['studies'];by_uid={s['uid']:s for s in source}
        items=[]
        for i in range(1001):
            item=copy.deepcopy(by_uid[a.uid]);item.update(uid='synthetic-page-'+str(i),id=prefix+str(i).zfill(4))
            if i in (24,25):item=by_uid[a.uid if i==24 else b.uid]
            items.append(item)
        # Browser-only synthetic scale response: no dummy study or report is stored.
        page.route('**/api/studies',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps({'studies':items})))
        page.locator('#refresh').click();page.locator('#quick').fill(prefix)
        page.locator('#heads [data-key=id]').click();page.locator('#page-size').select_option('25')
        expect(page.locator('#page-status')).to_contain_text('1–25 / 1001건')
        expect(page.locator('#rows tr[data-uid]')).to_have_count(25)
        expect(page.locator(f'#rows tr[data-uid="{a.uid}"]')).to_be_visible()
        page.locator('#page-next').click();expect(page.locator('#page-status')).to_contain_text('26–50 / 1001건')
        self.assertEqual(page.evaluate('selectedUid'),a.uid);expect(page.locator('#findings')).to_have_value('Page browsing preserves this report')
        page.locator('#page-current').click();expect(page.locator('#page-status')).to_contain_text('1–25 / 1001건')
        # Existing report move crosses the display page boundary using the full queue.
        page.locator('#b-next').click();expect(page.locator('#findings')).to_have_value(b.secret)
        self.assertEqual(page.evaluate('selectedUid'),b.uid);expect(page.locator('#page-status')).to_contain_text('26–50 / 1001건')
        page.locator('#b-prev').click();expect(page.locator('#page-status')).to_contain_text('1–25 / 1001건')
        expect(page.locator('#findings')).to_have_value('Page browsing preserves this report')
        page.locator('#page-size').select_option('100');expect(page.locator('#rows tr[data-uid]')).to_have_count(100)
        page.locator('#page-size').evaluate("e=>e.value='25'")
        page.locator('#quick').fill(prefix)
        expect(page.locator('#page-size')).to_have_value('100');expect(page.locator('#rows tr[data-uid]')).to_have_count(100)
        page.locator('#heads [data-key=id]').click()
        expect(page.locator('#rows tr').first).to_have_attribute('data-uid','synthetic-page-1000')
        page.locator('#page-next').click();expect(page.locator('#rows tr[data-uid]')).to_have_count(100)
        page.locator('#quick').fill(prefix+'1000');expect(page.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(page.locator('#page-status')).to_contain_text('1–1 / 1건')
        expect(page.locator('#page-next')).to_be_disabled();expect(page.locator('#page-current')).to_be_disabled()
        page.locator('#quick').fill('NO-MATCH-'+prefix);expect(page.locator('#page-status')).to_contain_text('0–0 / 0건')
        expect(page.locator('#page-prev')).to_be_disabled();expect(page.locator('#page-next')).to_be_disabled()
        page.locator('#quick').fill(prefix);self.screenshot(page,'paged-worklist.png')

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(NestedPagesE2E(name) for name in loader.getTestCaseNames(NestedPagesE2E) if name.startswith('test_nested_'))
if __name__=='__main__':unittest.main(verbosity=2)
