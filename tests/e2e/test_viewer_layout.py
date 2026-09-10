# coding: utf-8
"""Fixed-viewer grid placement and explicit account/browser recent-layout restoration."""
from __future__ import annotations
import json
from pathlib import Path
import unittest
import uuid
from playwright.sync_api import expect
from test_thumbnail_series import ThumbnailSeriesE2E
from test_prior_selection import canvas_ready


class ViewerLayoutE2E(ThumbnailSeriesE2E):
    def launch(self,page,fixtures):
        page.goto(self.stack.proxy+'/ohif/viewer?StudyInstanceUIDs='+','.join(f.uid for f in fixtures))
        canvas_ready(page,1)
        return page

    def grid(self,page,count):
        page.locator('[data-cy=Layout]').click()
        page.get_by_text('Common',exact=True).locator('..').locator(':scope > div').nth(1).locator(':scope > div').nth({1:0,2:1,4:2}[count]).click()
        page.wait_for_function('n=>services.viewportGridService.getState().viewports.size===n',arg=count)

    def cells(self,page):
        return page.evaluate('''() => [...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(v=>({
          id:v.viewportId,x:v.x,y:v.y,sets:v.displaySetInstanceUIDs,options:v.viewportOptions,type:services.cornerstoneViewportService.getCornerstoneViewport(v.viewportId)?.type,
          image:services.cornerstoneViewportService.getCornerstoneViewport(v.viewportId)?.getCurrentImageId?.()||null
        }))''')

    def drag(self,page,description,index):
        page.locator('[draggable=true]').filter(has_text=description).drag_to(page.locator('[data-cy=viewport-grid] > div').nth(index))

    def identity(self,page,expected):
        page.wait_for_function('''expected=>{
          const cells=[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x);
          return cells.length===expected.length && cells.every((cell,i)=>{
            const v=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId),id=v?.getCurrentImageId?.();
            if(!expected[i])return !(cell.displaySetInstanceUIDs||[]).length && !id;
            if(!id?.includes('/series/'+expected[i].series+'/')||!id.includes('/studies/'+expected[i].study+'/'))return false;
            if(!expected[i].sops.some(sop=>id.includes('/instances/'+sop+'/')))return false;
            const c=document.querySelector('[data-viewport-uid="'+cell.viewportId+'"] .cornerstone-canvas');
            if(!c?.width||!c.height)return false;
            const ctx=c.getContext('2d');if(!ctx)return false;
            const pixels=ctx.getImageData(0,0,c.width,c.height).data;let lo=255,hi=0;
            for(let n=0;n<pixels.length;n+=16){lo=Math.min(lo,pixels[n]);hi=Math.max(hi,pixels[n]);}
            return hi-lo>100;
          });
        }''',arg=expected,timeout=60000)
        print('LAYOUT actual cells '+json.dumps(dict(expected=expected,cells=self.cells(page))),flush=True)

    def fixture_refs(self,page,f):
        return [dict(r,study=f.uid) for r in self.representatives(self.metadata(page,f))]

    def shot(self,page,name):
        folder=Path(__file__).parent/'artifacts';folder.mkdir(exist_ok=True)
        page.screenshot(path=str(folder/('LAYOUT-'+name+'.png')))

    def open_layout_tools(self,page):
        tab=page.locator('#kin-workspace-dock nav button[aria-controls=kin-viewer-layout]')
        expect(tab).to_be_visible(timeout=45000)
        if tab.get_attribute('aria-expanded')!='true':tab.click()

    def action(self,page,name,message):
        self.open_layout_tools(page)
        button=page.get_by_role('button',name={'저장':'Save','복원':'Restore','삭제':'Delete'}[name]+' Recent Layout',exact=True)
        expect(button).to_be_enabled();button.click()
        expect(button).to_be_enabled()
        expect(page.locator('#kin-viewer-layout-status')).to_contain_text(message)

    def records(self,page):
        return page.evaluate("() => Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('kin-viewer-layout-v1:')))")

    def relog(self,page,actor):
        page.context.clear_cookies();page.goto(self.stack.proxy+'/')
        try:
            page.locator('#username').fill(self.stack.username(actor));page.locator('#password').fill(self.stack.passwords[actor]);page.locator('#kc-login').click()
        except Exception:raise RuntimeError('Temporary BFF login failed') from None
        page.wait_for_url('**/worklist/hpacs-lite/main.html')

    def test_layout_01_native_placement_and_recent_save(self):
        f=self.multiple('LAYOUT-'+uuid.uuid4().hex[:16],'current','20260801')
        originals=self.originals();rows=self.report_rows(f);page=self.launch(self.login(),[f]);refs=self.fixture_refs(page,f)
        by_desc={i['0008103E']['Value'][0]:i['0020000E']['Value'][0] for i in self.metadata(page,f)}
        first=next(r for r in refs if r['series']==by_desc['D03A current']);second=next(r for r in refs if r['series']==by_desc['D02E second series'])
        self.grid(page,2);self.drag(page,'D02E second series',0);self.drag(page,'D03A current',1)
        self.identity(page,[second,first]);self.shot(page,'two-swapped')
        self.grid(page,4);self.drag(page,'D02E second series',0);self.drag(page,'D03A current',1);self.drag(page,'D02E second series',3)
        self.identity(page,[second,first,None,second]);self.shot(page,'four-duplicate')
        tab=page.locator('#kin-workspace-dock nav button[aria-controls=kin-viewer-layout]')
        expect(tab).to_be_visible(timeout=45000)
        if tab.get_attribute('aria-expanded')!='true':tab.click()
        expect(page.get_by_role('button',name='Save Recent Layout',exact=True)).to_be_visible()
        page.get_by_role('button',name='Save Recent Layout',exact=True).click()
        expect(page.locator('#kin-viewer-layout-status')).to_contain_text('저장했습니다')
        state=next(iter(self.records(page).values()));active=json.loads(state)['active']
        page.reload();canvas_ready(page,1);self.action(page,'복원','적용했습니다')
        self.identity(page,[second,first,None,second])
        self.assertEqual(page.evaluate('services.viewportGridService.getActiveViewportId()'),self.cells(page)[active]['id'])
        self.shot(page,'four-restored')
        page.set_viewport_size(dict(width=900,height=1400))
        page.get_by_role('button',name='Restore Recent Layout',exact=True).scroll_into_view_if_needed()
        expect(page.get_by_role('button',name='Restore Recent Layout',exact=True)).to_be_in_viewport()
        box=page.locator('#kin-workspace-dock').bounding_box();root=page.locator('#root').bounding_box()
        self.assertLessEqual(root['y']+root['height'],box['y']+1)
        expect(page.locator('#kin-viewer-history')).not_to_be_visible()
        self.identity(page,[second,first,None,second]);self.shot(page,'portrait-restored')
        self.assertEqual(self.report_rows(f),rows);self.assertEqual(self.originals(),originals)

    def test_layout_02_current_related_reopening_keeps_reporting(self):
        patient='LAYOUT-'+uuid.uuid4().hex[:16]
        current=self.multiple(patient,'current','20260801');related=self.ct(patient,'future','20260907')
        self.seed_report(current);self.seed_report(related,action='approve')
        values=dict(findings='Layout private findings',conclusion='Layout conclusion',recommendation='Layout recommendation')
        self.assertEqual(self.stack.request('PUT',f'/studies/{current.uid}/report','doctor',dict(values,baseVersion=1)).status,200)
        self.assertEqual(self.stack.request('POST',f'/studies/{current.uid}/hold','doctor').status,201)
        originals=self.originals();rows={f.uid:self.report_rows(f) for f in (current,related)}
        work=self.login();self.select(work,current);writes=self.source_writes(work)
        page=self.launch(work.context.new_page(),[current,related]);first=self.fixture_refs(page,current)[0];prior=self.fixture_refs(page,related)[0]
        self.grid(page,2);self.drag(page,'D03A future',0)
        desc=next(x['0008103E']['Value'][0] for x in self.metadata(page,current) if x['0020000E']['Value'][0]==first['series'])
        self.drag(page,desc,1);self.identity(page,[prior,first]);self.action(page,'저장','저장했습니다')
        stored=self.records(page);page.close()
        self.relog(work,'doctor');self.select(work,current)
        page=self.launch(work.context.new_page(),[current,related]);self.assertEqual(self.records(page),stored)
        self.action(page,'복원','적용했습니다');self.identity(page,[prior,first]);self.shot(page,'related-restored')
        # Saving a one-cell grid is a deliberate replacement, not an accumulating history.
        self.grid(page,1);self.drag(page,'D03A future',0);self.identity(page,[prior]);self.action(page,'저장','저장했습니다')
        page.reload();canvas_ready(page,1);self.action(page,'복원','적용했습니다');self.identity(page,[prior])
        self.assertEqual(len(self.records(page)),1)
        for name,value in values.items():expect(work.locator('#'+name)).to_have_value(value)
        self.assertEqual(self.state(current)['holder'],self.stack.actor('doctor'));self.assertEqual(writes,[])
        for f in (current,related):self.assertEqual(self.report_rows(f),rows[f.uid])
        self.assertEqual(self.originals(),originals)

    def test_layout_03_owner_device_and_delayed_permission(self):
        f=self.multiple('LAYOUT-'+uuid.uuid4().hex[:16],'current','20260801');originals=self.originals()
        page=self.launch(self.login(),[f]);self.action(page,'저장','저장했습니다');a=self.records(page)
        y=self.launch(self.login(),[f]);self.action(y,'복원','없습니다');self.assertEqual(self.records(y),{})
        stale=self.launch(page.context.new_page(),[f]);self.open_layout_tools(stale)
        self.relog(page,'doctor2');self.launch(page,[f]);self.action(page,'복원','없습니다')
        stale.get_by_role('button',name='Save Recent Layout',exact=True).click()
        expect(stale.locator('#kin-viewer-layout-status')).to_contain_text('세션이 변경')
        self.assertEqual(self.records(page),a);stale.close()
        self.grid(page,2);self.action(page,'저장','저장했습니다');both=self.records(page)
        self.assertEqual(len(both),2);self.assertTrue(all(both[k]==v for k,v in a.items()))
        self.action(page,'삭제','삭제했습니다');self.assertEqual(self.records(page),a)
        self.relog(page,'doctor');self.launch(page,[f]);self.action(page,'복원','적용했습니다')
        pending=[];pattern='**/api/studies'
        page.route(pattern,lambda route:pending.append(route))
        page.get_by_role('button',name='Restore Recent Layout',exact=True).click()
        expect(page.get_by_role('button',name='Restore Recent Layout',exact=True)).to_be_disabled()
        self.grid(page,2);page.wait_for_timeout(100)
        self.assertEqual(len(pending),1);pending[0].fulfill(response=pending[0].fetch())
        expect(page.locator('#kin-viewer-layout-status')).to_contain_text('화면 배치가 변경')
        self.assertEqual(len(self.cells(page)),2);self.assertEqual(self.records(page),a);page.unroute(pattern)
        page.route(pattern,lambda route:route.fulfill(status=403,json={'message':'Synthetic denied'}))
        before=self.cells(page);page.get_by_role('button',name='Restore Recent Layout',exact=True).click()
        expect(page.locator('#kin-viewer-layout-status')).to_contain_text('세션이 변경')
        expect(page.get_by_role('button',name='Save Recent Layout',exact=True)).to_be_disabled()
        self.assertEqual(self.cells(page),before);self.assertEqual(self.records(page),a);page.unroute(pattern)
        self.launch(page,[f]);self.open_layout_tools(page)
        response=page.request.post(self.stack.proxy+'/api/auth/logout',headers={'X-KIN-CSRF':'1'})
        self.assertEqual(response.status,204)
        page.get_by_role('button',name='Restore Recent Layout',exact=True).click()
        expect(page.locator('#kin-viewer-layout-status')).to_contain_text('세션이 변경')
        self.assertEqual(self.records(page),a)
        self.assertEqual(self.originals(),originals)

    def test_layout_04_corruption_storage_and_missing_reference(self):
        f=self.multiple('LAYOUT-'+uuid.uuid4().hex[:16],'current','20260801');other=self.ct('LAYOUT-other-'+uuid.uuid4().hex[:12],'other','20260801')
        originals=self.originals();page=self.launch(self.login(),[f]);self.action(page,'저장','저장했습니다')
        records=self.records(page);key=next(iter(records));raw=records[key];before=self.cells(page)
        for value,message in [('{','손상'),(' '*8193,'손상'),(json.dumps(dict(json.loads(raw),version=99)),'손상')]:
            page.evaluate('([k,v])=>localStorage.setItem(k,v)',[key,value]);self.action(page,'복원',message);self.assertEqual(self.cells(page),before)
        missing=json.loads(raw);missing['cells'][0]['series']='1.2.826.0.1.3680043.10.543.99999'
        page.evaluate('([k,v])=>localStorage.setItem(k,v)',[key,json.dumps(missing)]);self.action(page,'복원','시리즈를 찾을 수 없거나');self.assertEqual(self.cells(page),before)
        page.evaluate('([k,v])=>localStorage.setItem(k,v)',[key,raw])
        page.evaluate("() => {window.originalLayoutSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('blocked','QuotaExceededError');};}")
        self.action(page,'저장','저장소를 사용할 수 없습니다');self.assertEqual(self.cells(page),before);self.assertEqual(self.records(page),records)
        page.evaluate('() => {Storage.prototype.setItem=function(){throw undefined;};}')
        self.action(page,'저장','배치 작업에 실패했습니다');self.assertEqual(self.cells(page),before);self.assertEqual(self.records(page),records)
        page.evaluate('() => {Storage.prototype.setItem=originalLayoutSet;}')
        # Current display-set ambiguity is refused before any grid mutation.
        page.evaluate('''() => {window.originalSets=services.displaySetService.getActiveDisplaySets;services.displaySetService.getActiveDisplaySets=function(){const a=originalSets.call(this);return [...a,a[0]];};}''')
        self.action(page,'복원','시리즈를 찾을 수 없거나');self.assertEqual(self.cells(page),before)
        page.evaluate('() => {services.displaySetService.getActiveDisplaySets=originalSets;}')
        page.evaluate('''() => {window.originalViewportGetter=services.cornerstoneViewportService.getCornerstoneViewport;
          services.cornerstoneViewportService.getCornerstoneViewport=function(...args){const v=originalViewportGetter.apply(this,args);return v&&new Proxy(v,{get(t,k){return k==='type'?'volume':Reflect.get(t,k);}});};}''')
        self.action(page,'복원','일반 CT 화면에서');self.assertEqual(self.records(page),records)
        page.evaluate('() => {services.cornerstoneViewportService.getCornerstoneViewport=originalViewportGetter;}')
        self.assertEqual(self.cells(page),before)
        self.launch(page,[other]);before=self.cells(page);self.action(page,'복원','다른 검사의 배치');self.assertEqual(self.cells(page),before);self.assertEqual(self.records(page),records)
        self.assertEqual(self.originals(),originals)


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(ViewerLayoutE2E(n) for n in loader.getTestCaseNames(ViewerLayoutE2E) if n.startswith('test_layout_'))

if __name__=='__main__':unittest.main(verbosity=2)
