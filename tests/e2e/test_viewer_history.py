"""D05D: real pinned OHIF configuration, BFF login and owned viewer fixtures."""
from pathlib import Path
import sys,json,unittest,uuid,io,hashlib,copy,math
from unittest.mock import patch
import test_worklist as base
from viewer_precision_support import ThumbnailRequestsE2E,canvas_ready,expect,hook,synthetic_ct
from viewer_api_test import ViewerStack,literal
from pydicom import dcmread
from pydicom.uid import generate_uid

class ViewerHistoryE2E(ThumbnailRequestsE2E):
    @classmethod
    def setUpClass(cls):
        with patch.object(base,'LiveStack',ViewerStack): super().setUpClass()

    def open_viewer(self,f,actor='doctor',extra=None,observer=False):
        w=self.login(actor);p=w.context.new_page()
        if observer:
            def config(r):
                a=r.fetch();r.fulfill(response=a,body=a.text()+'\n'+hook)
            p.route('**/ohif/app-config.js',config)
        p.goto(self.stack.proxy+'/ohif/viewer?StudyInstanceUIDs='+f.uid+(','+extra.uid if extra else ''));canvas_ready(p,1)
        self.open_measurement_tools(p)
        expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목')
        return w,p

    def open_measurement_tools(self,p):
        expect(p.locator('#kin-workspace-dock')).to_have_count(1,timeout=45000)
        tab=p.locator('#kin-workspace-dock nav button[aria-controls=kin-viewer-history]')
        if tab.get_attribute('aria-expanded')!='true':tab.click()
        expect(p.locator('#kin-viewer-history')).to_be_visible()

    def draw(self,p,label):
        p.locator('[data-cy="MeasurementTools-split-button-secondary"]').click();p.get_by_text('Annotation',exact=True).click()
        box=p.locator('.cornerstone-canvas').bounding_box();x,y=box['x']+box['width']*.47,box['y']+box['height']*.47
        p.mouse.move(x,y);p.mouse.down();p.mouse.move(x+45,y+28,steps=8);p.mouse.up()
        entry=p.get_by_placeholder('Enter label');expect(entry).to_be_visible();entry.fill(label)
        p.locator('#draggableItem-select-annotation').get_by_role('button',name='Save',exact=True).click()
        row=p.locator('#kin-viewer-history section[data-kind=arrow]').last
        expect(row.get_by_label('Annotation Text')).to_have_value(label)
        return row

    def saved(self,f):
        r=self.stack.request('GET','/studies/'+f.uid+'/viewer-items?includeHidden=true','doctor')
        self.assertEqual(r.status,200,r.text);return r.body['items']

    def test_01_save_new_login_edit_hide_restore(self):
        f=self.fixture();self.seed_report(f)
        w,p=self.open_viewer(f)
        before=(self.state(f),self.versions(f));original=self.hashes()
        label='<img src=x onerror="window.bad=1"> 한글'
        row=self.draw(p,label);row.get_by_role('button',name='Save',exact=True).click()
        expect(row).to_contain_text('저장 완료');head=self.saved(f)[0]
        self.assertEqual(head['item']['label'],label)
        points=p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='ArrowAnnotate')[0].data.handles.points")
        self.assertEqual(points,head['item']['points'])
        p.close();w.close()
        w,p=self.open_viewer(f)
        p.wait_for_function("()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='ArrowAnnotate')")
        self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='ArrowAnnotate')[0].data.handles.points"),points)
        row=p.locator('#kin-viewer-history section[data-kind=arrow]');expect(row).to_contain_text(label)
        self.assertEqual(row.locator('img').count(),0);self.assertIsNone(p.evaluate('()=>window.bad'))
        row.get_by_role('button',name='Edit',exact=True).click();row.get_by_label('Annotation Text').fill('수정한 주석')
        row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('Saved r2')
        p.once('dialog',lambda d:d.accept('합성 숨김 사유'));row.get_by_role('button',name='Hide',exact=True).click();expect(row).to_contain_text('Saved r3 · Hidden')
        self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='ArrowAnnotate').length"),0)
        p.once('dialog',lambda d:d.accept('합성 복원 사유'));row.get_by_role('button',name='Restore',exact=True).click();expect(row).to_contain_text('Saved r4')
        row.get_by_role('button',name='History',exact=True).click();expect(row).to_contain_text('합성 숨김 사유')
        artifacts=Path(__file__).parent/'artifacts';artifacts.mkdir(exist_ok=True)
        p.screenshot(path=str(artifacts/'D05D-save-reopen.png'))
        self.assertEqual((self.state(f),self.versions(f)),before);self.assertEqual(self.hashes(),original)

    def key(self,p,title='키 <script>텍스트</script>'):
        p.get_by_role('button',name='Add Key Image',exact=True).click()
        row=p.locator('#kin-viewer-history section[data-kind=key]').last
        row.get_by_label('Key Title').fill(title);row.get_by_label('Key Description').fill('설명')
        row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('저장 완료')
        return row

    def test_02_key_multiframe_new_login_and_readonly(self):
        f=self.fixture();ds=dcmread(io.BytesIO(self.stack.orthanc_bytes(next(iter(self.hashes())))))
        ds.SOPInstanceUID=generate_uid();ds.SeriesInstanceUID=generate_uid();ds.SOPClassUID='1.2.840.10008.5.1.4.1.1.3.1';ds.Modality='US'
        ds.file_meta.MediaStorageSOPInstanceUID=ds.SOPInstanceUID;ds.file_meta.MediaStorageSOPClassUID=ds.SOPClassUID
        ds.NumberOfFrames=3;ds.FrameTime=33.333;ds.CineRate=30;ds.PixelData=ds.PixelData*3;ds.SeriesNumber=2
        stream=io.BytesIO();ds.save_as(stream,write_like_original=False)
        self.assertEqual(self.stack._orthanc_request('POST','/instances',stream.getvalue()).status,200)
        originals=self.hashes();w,p=self.open_viewer(f)
        # Seed only the navigation target through the real API; the second key
        # is created from the actual active US frame through the product UI.
        body={'requestId':str(uuid.uuid4()),'item':dict(schemaVersion=1,kind='key',seriesUid=str(ds.SeriesInstanceUID),sopUid=str(ds.SOPInstanceUID),frame=3,title='US 세 번째 프레임',description='')}
        self.assertEqual(self.stack.request('POST','/studies/'+f.uid+'/viewer-items','doctor',body).status,200)
        p.get_by_role('button',name='Refresh',exact=True).click()
        row=p.locator('#kin-viewer-history section').filter(has_text='US 세 번째 프레임');expect(row).to_be_visible();row.get_by_role('button',name='Go to Image').click()
        p.wait_for_function("sop=>cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports()).some(v=>v.getCurrentImageId?.().includes(sop+'/frames/3'))",arg=str(ds.SOPInstanceUID))
        self.key(p,'US UI key');self.assertEqual(self.saved(f)[-1]['item']['frame'],3)
        p.close();w.close();w,p=self.open_viewer(f)
        row=p.locator('#kin-viewer-history section').filter(has_text='US UI key');row.get_by_role('button',name='Go to Image').click()
        p.wait_for_function("sop=>cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports()).some(v=>v.getCurrentImageId?.().includes(sop+'/frames/3'))",arg=str(ds.SOPInstanceUID))
        w2,p2=self.open_viewer(f,'doctor2');expect(p2.locator('#kin-viewer-history')).to_contain_text('Read-only')
        self.assertEqual(p2.locator('#kin-viewer-history section').get_by_role('button',name='Edit',exact=True).count(),0)
        self.assertEqual(p2.locator('#kin-viewer-history section').get_by_role('button',name='Hide',exact=True).count(),0)
        self.assertEqual(self.hashes(),originals)

    def test_03_network_retry_conflict_and_quota(self):
        f=self.fixture();w,p=self.open_viewer(f);seen=[]
        def lost(route):
            seen.append(route.request.post_data);route.fetch();route.abort('failed')
        p.route('**/viewer-items',lost)
        p.get_by_role('button',name='Add Key Image',exact=True).click();row=p.locator('#kin-viewer-history section[data-kind=key]')
        row.get_by_label('Key Title').fill('응답 유실');row.get_by_role('button',name='Save',exact=True).click()
        expect(row).to_contain_text('저장 결과를 확인하지 못했습니다');self.assertEqual(len(self.saved(f)),1)
        p.unroute('**/viewer-items',lost)
        p.on('request',lambda r:seen.append(r.post_data) if r.method=='POST' and r.url.endswith('/viewer-items') else None)
        row.get_by_role('button',name='Retry Request').click();expect(row).to_contain_text('저장 완료');self.assertEqual(seen[0],seen[1]);self.assertEqual(len(self.saved(f)),1)
        head=self.saved(f)[0];row.get_by_role('button',name='Edit',exact=True).click();row.get_by_label('Key Title').fill('내 수정 보존')
        command=dict(requestId=str(uuid.uuid4()),expectedRevision=1,action='edit',item={k:v for k,v in head['item'].items() if k!='hidden'});command['item']['title']='다른 창 수정'
        self.assertEqual(self.stack.request('POST','/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions','doctor',command).status,200)
        row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('서버에 다른 판')
        expect(row.get_by_label('Key Title')).to_have_value('내 수정 보존');expect(row.get_by_role('button',name='Save',exact=True)).to_be_disabled()
        row.get_by_role('button',name='Use Latest & Keep Changes').click();row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('Saved r3')
        self.assertEqual(self.saved(f)[0]['item']['title'],'내 수정 보존')
        row.get_by_role('button',name='Edit',exact=True).click();row.get_by_label('Key Title').fill('503 보존')
        def unavailable(r):r.fulfill(status=503,content_type='application/json',body='{"message":"synthetic unavailable"}')
        p.route('**/viewer-items/*/revisions',unavailable)
        row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('저장 결과를 확인하지 못했습니다')
        expect(row.get_by_label('Key Title')).to_have_value('503 보존');p.unroute('**/viewer-items/*/revisions',unavailable)
        row.get_by_role('button',name='Retry Request').click();expect(row).to_contain_text('Saved r4')
        budget=base.psql('SELECT "revisionCount" FROM "ViewerStorageBudget" WHERE "studyUid"='+literal(f.uid))[0]
        base.psql('UPDATE "ViewerStorageBudget" SET "revisionCount"=4096 WHERE "studyUid"='+literal(f.uid))
        try:
            row.get_by_role('button',name='Edit',exact=True).click();row.get_by_label('Key Title').fill('한도 실패 보존')
            row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('저장 공간 한도');expect(row.get_by_label('Key Title')).to_have_value('한도 실패 보존')
            self.assertEqual(self.saved(f)[0]['revision'],4)
        finally:base.psql('UPDATE "ViewerStorageBudget" SET "revisionCount"='+budget+' WHERE "studyUid"='+literal(f.uid))
        head=self.saved(f)[0];item={k:v for k,v in head['item'].items() if k!='hidden'}
        self.assertEqual(self.stack.request('POST','/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions','doctor',dict(requestId=str(uuid.uuid4()),expectedRevision=4,action='hide',reason='다른 창 숨김',item=item)).status,200)
        row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('서버에 다른 판')
        row.get_by_role('button',name='Use Latest & Keep Changes').click();expect(row).to_contain_text('미저장 수정은 보관')
        p.once('dialog',lambda d:d.accept('숨김 충돌 복원'));row.get_by_role('button',name='Restore',exact=True).click()
        expect(row.get_by_label('Key Title')).to_have_value('한도 실패 보존')
        row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('Saved r7')

    def test_04_readonly_arrow_revocation_and_401(self):
        f=self.fixture();w,p=self.open_viewer(f);row=self.draw(p,'권한 주석');row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('저장 완료')
        w2,p2=self.open_viewer(f,'doctor2');expect(p2.locator('#kin-viewer-history')).to_contain_text('Read-only')
        p2.wait_for_function("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='ArrowAnnotate').length===1")
        self.assertTrue(p2.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='ArrowAnnotate').every(a=>cornerstoneTools.annotation.locking.isAnnotationLocked(a.annotationUID))"))
        base.psql('UPDATE "StudyState" SET rs=\'P\', "preDoc"='+literal(self.stack.actor('doctor'))+', "preReviewer"='+literal(self.stack.actor('jmryu'))+' WHERE uid='+literal(f.uid))
        self.assertEqual(self.stack.request('GET','/studies/'+f.uid+'/viewer-items','doctor2').status,403)
        p2.get_by_role('button',name='Refresh',exact=True).click();expect(p2.locator('#kin-viewer-history')).to_contain_text('이 검사에 접근할 수 없습니다.')
        self.assertEqual(p2.locator('#kin-viewer-history section').count(),0)
        self.assertEqual(p2.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='ArrowAnnotate').length"),0)
        p.context.clear_cookies();p.get_by_role('button',name='Refresh',exact=True).click();expect(p.locator('#kin-viewer-history')).to_contain_text('다시 로그인')
        self.assertEqual(p.locator('#kin-viewer-history section').count(),0)

    def test_05_a_b_a_late_list_and_logout(self):
        f=self.fixture();b=self.fixture(f.patient_id);w,p=self.open_viewer(f,extra=b,observer=True)
        def switch(uid):
            p.evaluate('''uid=>{const s=__d05c1.services;const d=s.displaySetService.getActiveDisplaySets().find(d=>d.StudyInstanceUID===uid);if(!d)throw Error('missing display set');s.viewportGridService.setDisplaySetsForViewport({viewportId:s.viewportGridService.getActiveViewportId(),displaySetInstanceUIDs:[d.displaySetInstanceUID]});}''',uid)
            p.wait_for_function("uid=>{const s=__d05c1.services;return s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId())?.getCurrentImageId?.().includes('/studies/'+uid+'/')}",arg=uid)
            expect(p.locator('#kin-viewer-history')).to_have_attribute('data-study-uid',uid)
        switch(f.uid);expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목');self.key(p,'old A')
        delayed=[]
        def hold(r):delayed.append((r,r.fetch()))
        pattern='**/studies/'+f.uid+'/viewer-items?*';p.route(pattern,hold)
        p.get_by_role('button',name='Refresh',exact=True).click()
        for _ in range(50):
            if delayed:break
            p.wait_for_timeout(20)
        self.assertEqual(len(delayed),1)
        head=self.saved(f)[0];item={k:v for k,v in head['item'].items() if k!='hidden'};item['title']='new A'
        self.assertEqual(self.stack.request('POST','/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions','doctor',dict(requestId=str(uuid.uuid4()),expectedRevision=1,action='edit',item=item)).status,200)
        switch(b.uid);expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('0개 저장 항목')
        p.unroute(pattern,hold);switch(f.uid);expect(p.locator('#kin-viewer-history')).to_contain_text('new A')
        for r,response in delayed:
            try:r.fulfill(response=response)
            except Exception:pass  # Aborted requests may already be disposed.
        p.wait_for_timeout(500);expect(p.locator('#kin-viewer-history')).not_to_contain_text('old A')
        p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close()}")
        expect(p.locator('#kin-viewer-history')).to_contain_text('다시 로그인');self.assertEqual(p.locator('#kin-viewer-history section').count(),0)

    def test_06_large_oblique_pan_zoom_coordinates(self):
        a=math.sqrt(.5);c=math.cos(math.radians(31));s=math.sin(math.radians(31));iop=[a,a,0,-c*a,c*a,s]
        f=synthetic_ct(self.stack,'D05D-'+uuid.uuid4().hex[:12],'large','20260907',[10000,-20000,30000],iop,[.7,1.3])
        before=self.hashes();w,p=self.open_viewer(f);row=self.draw(p,'큰 좌표')
        row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('저장 완료')
        points=self.saved(f)[0]['item']['points'];row.get_by_role('button',name='Edit',exact=True).click()
        box=p.locator('.cornerstone-canvas').bounding_box()
        for tool,dx,dy in [('Pan',20,12),('Zoom',0,35)]:
            p.locator('[data-cy="'+tool+'"]').click();x,y=box['x']+box['width']*.8,box['y']+box['height']*.8
            p.mouse.move(x,y);p.mouse.down();p.mouse.move(x+dx,y+dy,steps=8);p.mouse.up()
        p.keyboard.press('h');row.get_by_label('Annotation Text').fill('큰 좌표 유지');row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('Saved r2')
        self.assertEqual(self.saved(f)[0]['item']['points'],points)
        w2,p2=self.open_viewer(f);p2.wait_for_function("()=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==='ArrowAnnotate')")
        self.assertEqual(p2.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='ArrowAnnotate').data.handles.points"),points)
        self.assertEqual(self.hashes(),before)

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    unittest.main(defaultTest=[f'ViewerHistoryE2E.{n}' for n in ViewerHistoryE2E.__dict__ if n.startswith('test_')],verbosity=2)
