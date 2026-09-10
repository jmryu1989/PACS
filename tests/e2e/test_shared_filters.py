"""TEST-SHARED-FILTERS: institution publication and independent personal copies."""
import json
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import unittest
import uuid
from playwright.sync_api import expect
import test_saved_filter_manager as manager
from test_worklist import psql


def literal(value):
    return "'"+str(value).replace("'","''")+"'"


class SharedFiltersE2E(manager.SavedFilterManagerE2E):
    def setUp(self):
        super().setUp();self.libraryInstitutions=set();self.libraryActors=set();self.lastLibrary={}
        self.prefix='LIB-'+uuid.uuid4().hex[:10]
        self.addCleanup(self.cleanup_libraries)

    def cleanup_libraries(self):
        self.close_contexts();self.contexts=[]
        for institution in self.libraryInstitutions:
            rows=psql('SELECT to_jsonb(t)::text FROM "SharedFilterLibrary" t WHERE institution='+literal(institution))
            for raw in rows:
                row=json.loads(raw);self.assertIn(row['updatedBy'],self.libraryActors)
                expected=self.lastLibrary[institution]
                for field in ('revision','folders','filters','updatedBy'):self.assertEqual(row[field],expected[field])
                self.assertEqual(psql('DELETE FROM "SharedFilterLibrary" t WHERE to_jsonb(t)='+literal(raw)+'::jsonb RETURNING 1'),['1'])

    def library(self,user='jmryu'):
        result=self.stack.request('GET','/shared-filters',user);self.assertEqual(result.status,200,result.text)
        institution=result.body['owner'][0];self.libraryActors.add(self.stack.actor(user))
        if institution not in self.libraryInstitutions:
            self.assertEqual(psql('SELECT count(*) FROM "SharedFilterLibrary" WHERE institution='+literal(institution)),['0'],
                             'Institution library must be absent before this synthetic test')
            self.libraryInstitutions.add(institution)
        return result.body

    def personal(self,user='jmryu'):
        result=self.stack.request('GET','/filter-folders',user);self.assertEqual(result.status,200,result.text);return result.body

    def seed_folder(self,user='jmryu'):
        folder=self.prefix+'/Personal'
        result=self.stack.request('POST','/filters',user,dict(name=self.prefix+' Search',folder=folder+'/CT',
            mode='Radiology',quick='',days=-1,cols={'mod':'CT'},sortKey='date',sortDir=-1,description='original criteria',ordinal=7,isDefault=True))
        self.assertEqual(result.status,201,result.text)
        state=self.personal(user)
        result=self.stack.request('POST','/filter-folders',user,dict(expectedOwner=state['owner'],revision=state['revision'],
            command=dict(action='save-folder',path=folder+'/Empty',description='empty metadata',ordinal=2)))
        self.assertEqual(result.status,201,result.text)
        return folder,self.personal(user)

    def change(self,snapshot,command,user='jmryu',status=201):
        result=self.stack.request('POST','/shared-filters',user,dict(expectedOwner=snapshot['owner'],revision=snapshot['revision'],command=command))
        self.assertEqual(result.status,status,result.text)
        if result.status==201:self.lastLibrary[result.body['owner'][0]]=result.body
        return result.body

    def publish(self,library,personal,source,destination,replace=False,status=201):
        return self.change(library,
            {'action':'publish-folder','from':source,'to':destination,'sourceRevision':personal['revision'],'namePrefix':'','replace':replace},status=status)

    def copy_library(self,library,personal,source,destination,user='doctor',prefix='',status=201):
        result=self.stack.request('POST','/shared-filters/copy',user,dict(expectedOwner=library['owner'],revision=library['revision'],
            personalRevision=personal['revision'],namePrefix=prefix,**{'from':source,'to':destination}))
        self.assertEqual(result.status,status,result.text);return result.body

    def test_shared_01_publish_copy_independent_defaults_and_empty_folders(self):
        initial=self.library();source,personal=self.seed_folder();destination=self.prefix+'/Shared'
        published=self.publish(initial,personal,source,destination)
        self.assertEqual(self.personal(),personal)
        self.assertIn(dict(path=destination+'/Empty',description='empty metadata',ordinal=2),published['folders'])
        receiver=self.library('doctor');before=self.personal('doctor')
        copied=self.copy_library(receiver,before,destination,self.prefix+'/MyCopy')
        row=next(filter for filter in copied['filters'] if filter['name']==self.prefix+' Search')
        self.assertFalse(row['isDefault']);self.assertEqual(row['cols'],{'mod':'CT'});self.assertEqual(row['ordinal'],7)
        self.assertEqual(row['folder'],self.prefix+'/MyCopy/CT')
        self.assertEqual(self.library(),published,'Read-side copy must not alter shared revision, timestamp or content')
        removed=self.change(published,dict(action='delete-searches',ids=[published['filters'][0]['id']]))
        self.assertEqual(removed['filters'],[]);self.assertEqual(self.personal('doctor'),copied)

    def test_shared_02_roles_foreign_owner_and_empty_library(self):
        source,personal=self.seed_folder();admin=self.library();doctor=self.library('doctor')
        self.change(doctor,dict(action='save-folder',path=self.prefix,description='',ordinal=0),'doctor',403)
        foreign=self.library('kdoctor');self.assertEqual(foreign['filters'],[])
        self.copy_library(foreign,self.personal('kdoctor'),'',self.prefix,'kdoctor',status=404)
        published=self.publish(admin,personal,source,self.prefix+'/Shared')
        self.assertNotEqual(foreign['owner'][0],admin['owner'][0])
        self.assertEqual(self.library('kdoctor')['filters'],[])
        self.copy_library(foreign,self.personal('kdoctor'),self.prefix+'/Shared',self.prefix,'kdoctor',status=404)
        self.change({**published,'owner':foreign['owner']},dict(action='remove-folder',path=self.prefix),'jmryu',409)
        self.copy_library(published,self.personal('kdoctor'),self.prefix+'/Shared',self.prefix,'kdoctor',status=409)
        self.assertEqual(self.library(),published)

    def test_shared_03_name_collision_and_revision_rollback(self):
        source,personal=self.seed_folder();published=self.publish(self.library(),personal,source,self.prefix+'/Shared')
        receiver=self.library('doctor');before=self.personal('doctor')
        copied=self.copy_library(receiver,before,self.prefix+'/Shared',self.prefix+'/First')
        self.copy_library(receiver,copied,self.prefix+'/Shared',self.prefix+'/Second',status=409)
        self.assertEqual(self.personal('doctor'),copied)
        self.assertFalse(any(folder['path']==self.prefix+'/Second' for folder in copied['folders']))
        copied_again=self.copy_library(receiver,copied,self.prefix+'/Shared',self.prefix+'/Second',prefix='Copy ')
        self.assertEqual(len(copied_again['filters']),len(copied['filters'])+1)
        self.copy_library(receiver,copied,self.prefix+'/Shared',self.prefix+'/Third',prefix='Third ',status=409)
        self.assertEqual(self.personal('doctor'),copied_again)
        self.publish(published,personal,source,self.prefix+'/Shared',status=409)
        self.assertEqual(self.library(),published)
        changed=self.publish(published,personal,source,self.prefix+'/Shared',replace=True)
        self.assertEqual(changed['revision'],published['revision']+1)
        self.assertEqual(changed['filters'][0]['id'],published['filters'][0]['id'])

    def test_shared_04_parallel_publication_and_stale_personal_source(self):
        source,personal=self.seed_folder();before=self.library()
        command={'action':'publish-folder','from':source,'to':self.prefix+'/Shared','sourceRevision':personal['revision'],'namePrefix':'','replace':False}
        body=dict(expectedOwner=before['owner'],revision=before['revision'],command=command)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.stack.request('POST','/shared-filters','jmryu',body),range(2)))
        for result in results:
            if result.status==201:self.lastLibrary[result.body['owner'][0]]=result.body
        self.assertEqual(sorted(result.status for result in results),[201,409])
        published=next(result.body for result in results if result.status==201)
        own=next(filter for filter in personal['filters'] if filter['name']==self.prefix+' Search')
        saved=self.stack.request('POST','/filters','jmryu',dict(name=own['name'],quick='new source'));self.assertEqual(saved.status,201)
        self.publish(published,personal,source,self.prefix+'/Another',status=409)
        self.assertEqual(self.library(),published)

    def login(self,user='doctor'):
        self.library(user)
        page=super().login(user)
        def capture(response):
            if response.request.method=='POST' and response.url.endswith('/api/shared-filters') and response.status==201:
                snapshot=response.json();self.lastLibrary[snapshot['owner'][0]]=snapshot
        page.on('response',capture);return page

    def load_shared(self,page):
        if not page.locator('#sfm-shared').evaluate('el=>el.open'):page.locator('#sfm-shared > summary').click()
        page.locator('#sfs-load').click();expect(page.locator('#sfm-status')).to_contain_text('기관 검색 모음을 불러왔습니다')

    def test_shared_05_browser_publish_copy_relogin_and_report_draft(self):
        source,_=self.seed_folder();admin=self.login('jmryu');self.open_manager(admin);self.load_shared(admin)
        admin.locator('#sfs-personal').fill(source.replace('/', ' / '));admin.locator('#sfs-destination').fill(self.prefix+'/Shared')
        def confirm_publish(dialog):
            self.assertIn('검색 1개',dialog.message);dialog.accept()
        admin.once('dialog',confirm_publish);admin.locator('#sfs-publish').click()
        expect(admin.locator('#sfm-status')).to_contain_text('기관 검색 모음을 갱신했습니다')
        fixture=self.fixture(patient_id=self.prefix);self.seed_report(fixture)
        page=self.login();self.select(page,fixture);page.locator('#findings').fill('preserved unsaved report')
        self.open_manager(page);self.load_shared(page);expect(page.locator('#sfs-admin')).to_be_hidden()
        page.locator('#sfs-source').fill(self.prefix+' / Shared');page.locator('#sfs-destination').fill(self.prefix+'/My')
        def confirm_copy(dialog):
            self.assertIn('검색 1개',dialog.message);dialog.accept()
        page.once('dialog',confirm_copy);page.locator('#sfs-copy').click()
        expect(page.locator('#sfm-status')).to_contain_text('개인 검색으로 복사했습니다')
        expect(page.locator('#sfm-list button[data-name]').filter(has_text=self.prefix+' Search')).to_have_count(1)
        page.locator('#sfm-close').click();expect(page.locator('#findings')).to_have_value('preserved unsaved report')
        fresh=self.login();self.open_manager(fresh)
        fresh.locator('#sfm-list button[data-name]').filter(has_text=self.prefix+' Search').click()
        expect(fresh.locator('#sfm-folder')).to_have_value(self.prefix+'/My/CT')
        expect(fresh.locator('#sfm-default')).not_to_be_checked()

    def test_shared_06_ui_conflict_failure_and_portrait(self):
        source,personal=self.seed_folder();published=self.publish(self.library(),personal,source,self.prefix+'/Shared')
        page=self.login();page.set_viewport_size(dict(width=390,height=844));self.open_manager(page);self.load_shared(page)
        page.locator('#sfs-source').fill(self.prefix+'/Shared');page.locator('#sfs-destination').fill(self.prefix+'/My')
        page.locator('#sfs-prefix').fill('Keep ');page.locator('#sfm-quick').fill('keep search draft')
        self.change(published,dict(action='save-folder',path=self.prefix+'/Added',description='',ordinal=0))
        page.once('dialog',lambda dialog:dialog.accept());page.locator('#sfs-copy').click()
        expect(page.locator('#sfm-status')).to_contain_text('기관 검색이 변경되었습니다')
        expect(page.locator('#sfs-prefix')).to_have_value('Keep ');expect(page.locator('#sfm-quick')).to_have_value('keep search draft')
        self.load_shared(page)
        page.once('dialog',lambda dialog:dialog.accept());page.locator('#sfs-copy').click()
        expect(page.locator('#sfm-status')).to_contain_text('개인 검색으로 복사했습니다')
        button=page.locator('#sfs-copy');button.scroll_into_view_if_needed()
        self.assertTrue(button.evaluate('el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el}'))
        self.assertTrue(page.locator('#saved-filter-manager').evaluate('el=>el.scrollWidth<=el.clientWidth'))
        evidence=Path(os.environ['KIN_EVIDENCE_DIR']);evidence.mkdir(parents=True,exist_ok=True);page.screenshot(path=str(evidence/'shared-portrait.png'))

    def test_shared_07_unrelated_shared_delete_preserves_unsaved_folder_warning(self):
        source,personal=self.seed_folder();self.publish(self.library(),personal,source,self.prefix+'/Shared')
        page=self.login('jmryu');self.open_manager(page);self.load_shared(page)
        page.locator('#sfs-description').fill('unsaved shared folder description')
        page.get_by_role('checkbox',name='Select Shared Search: '+self.prefix+' Search',exact=True).check()
        page.locator('#sfs-destination').fill(self.prefix+'/Moved')
        page.once('dialog',lambda dialog:dialog.accept());page.locator('#sfs-move-selected').click()
        expect(page.locator('#sfm-status')).to_contain_text('기관 검색 모음을 갱신했습니다')
        page.once('dialog',lambda dialog:dialog.dismiss());page.locator('#sfm-close').click()
        expect(page.locator('#saved-filter-manager')).to_be_visible()
        page.once('dialog',lambda dialog:dialog.accept());page.locator('#sfs-delete-selected').click()
        expect(page.locator('#sfm-status')).to_contain_text('기관 검색 모음을 갱신했습니다')
        dialogs=[]
        def cancel(dialog):dialogs.append(dialog.message);dialog.dismiss()
        page.once('dialog',cancel);page.locator('#sfm-close').click()
        expect(page.locator('#saved-filter-manager')).to_be_visible()
        self.assertTrue(dialogs);expect(page.locator('#sfs-description')).to_have_value('unsaved shared folder description')

    def test_shared_08_unrelated_personal_delete_preserves_unsaved_folder_warning(self):
        self.seed_folder();page=self.login('jmryu');self.open_manager(page)
        page.locator('#sfm-organize > summary').click();page.locator('#sfm-load-folders').click()
        expect(page.locator('#sfm-status')).to_contain_text('검색 모음을 불러왔습니다')
        page.locator('#sfm-folder-description').fill('unsaved personal folder description')
        page.get_by_role('checkbox',name='Select Search: '+self.prefix+' Search',exact=True).check()
        page.locator('#sfm-folder-destination').fill(self.prefix+'/Moved')
        page.once('dialog',lambda dialog:dialog.accept());page.locator('#sfm-bulk-move').click()
        expect(page.locator('#sfm-status')).to_contain_text('검색 모음 변경을 저장했습니다')
        page.once('dialog',lambda dialog:dialog.dismiss());page.locator('#sfm-close').click()
        expect(page.locator('#saved-filter-manager')).to_be_visible()
        page.once('dialog',lambda dialog:dialog.accept());page.locator('#sfm-bulk-delete').click()
        expect(page.locator('#sfm-status')).to_contain_text('검색 모음 변경을 저장했습니다')
        dialogs=[]
        def cancel(dialog):dialogs.append(dialog.message);dialog.dismiss()
        page.once('dialog',cancel);page.locator('#sfm-close').click()
        expect(page.locator('#saved-filter-manager')).to_be_visible()
        self.assertTrue(dialogs);expect(page.locator('#sfm-folder-description')).to_have_value('unsaved personal folder description')


    def test_shared_09_quick_match_copy_keeps_exact_results(self):
        first=self.fixture(patient_id=self.prefix)
        second=self.fixture(patient_id=self.prefix+'-tail')
        expression=dict(version=2,quickMatch='exact',join='and',rules=[])
        source=self.prefix+'/Personal'
        result=self.stack.request('POST','/filters','jmryu',dict(name=self.prefix+' Exact',folder=source,
            mode='Radiology',quick=self.prefix,days=-1,cols={'$compound':expression},sortKey=None,sortDir=0,isDefault=False))
        self.assertEqual(result.status,201,result.text)
        published=self.publish(self.library(),self.personal(),source,self.prefix+'/Shared')
        copied=self.copy_library(self.library('doctor'),self.personal('doctor'),self.prefix+'/Shared',self.prefix+'/Copy')
        saved=next(f for f in copied['filters'] if f['name']==self.prefix+' Exact')
        self.assertEqual(saved['cols']['$compound'],expression)
        page=self.login()
        page.locator('#quick').fill(self.prefix)
        expect(page.locator(f'#rows tr[data-uid="{first.uid}"]')).to_be_visible()
        self.open_manager(page)
        page.locator('#sfm-search').fill(saved['name'])
        page.locator('#sfm-list button',has_text=saved['name']).click()
        expect(page.locator('#sfm-quick-match')).to_have_value('exact')
        expect(page.locator('#sfm-count')).to_contain_text('목록 기준 1건')
        page.locator('#sfm-apply').click()
        expect(page.locator('#rows tr[data-uid]')).to_have_count(1)
        expect(page.locator(f'#rows tr[data-uid="{first.uid}"]')).to_be_visible()
        expect(page.locator(f'#rows tr[data-uid="{second.uid}"]')).to_have_count(0)
        expect(page.locator('#quick-match')).to_have_value('exact')


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(SharedFiltersE2E(name) for name in loader.getTestCaseNames(SharedFiltersE2E) if name.startswith('test_shared_'))


if __name__=='__main__':unittest.main(verbosity=2)
