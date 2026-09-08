# coding: utf-8
"""TEST-D09-REPORT-PREVIEW: actual BFF, report snapshot, frame output and cancellation."""
import base64, hashlib, io, sys, unittest, uuid
from pathlib import Path
import numpy as np
from pydicom import dcmread
from pydicom.uid import generate_uid
from pypdf import PdfReader
from test_viewer_history import ViewerHistoryE2E, expect, base, literal


class ReportPreviewE2E(ViewerHistoryE2E):
    def preview(self, f, actor='doctor', status=200):
        r=self.stack.request('GET','/studies/'+f.uid+'/report-preview',actor)
        self.assertEqual(r.status,status,r.text)
        return r.body

    def saved_rows(self,f):
        result={}
        for table in ['Report','ReportDraft','ReportVersion','ViewerItem','ViewerRevision']:
            where=('uid='+literal(f.uid) if table.startswith('Report') else
                   '"studyUid"='+literal(f.uid) if table=='ViewerItem' else
                   '"itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"='+literal(f.uid)+')')
            result[table]=base.psql('SELECT to_jsonb(t)::text FROM "'+table+'" t WHERE '+where+' ORDER BY to_jsonb(t)::text')
        return result

    def add_keys(self,f):
        ds=dcmread(io.BytesIO(self.stack.orthanc_bytes(next(iter(self.hashes())))))
        ds.SOPInstanceUID=generate_uid();ds.SeriesInstanceUID=generate_uid();ds.StudyInstanceUID=f.uid
        ds.SOPClassUID='1.2.840.10008.5.1.4.1.1.3.1';ds.Modality='US'
        ds.file_meta.MediaStorageSOPInstanceUID=ds.SOPInstanceUID;ds.file_meta.MediaStorageSOPClassUID=ds.SOPClassUID
        ds.NumberOfFrames=3;ds.FrameTime=40;ds.SeriesNumber=3
        pixels=(np.arange(ds.Rows*ds.Columns).reshape(ds.Rows,ds.Columns)%4096).astype('<i2')
        ds.PixelData=np.stack([pixels,np.fliplr(pixels),np.flipud(pixels)]).tobytes()
        stream=io.BytesIO();ds.save_as(stream,write_like_original=False)
        self.assertEqual(self.stack._orthanc_request('POST','/instances',stream.getvalue()).status,200)
        keys=[]
        for frame in [1,3]:
            item=dict(schemaVersion=1,kind='key',seriesUid=str(ds.SeriesInstanceUID),sopUid=str(ds.SOPInstanceUID),frame=frame,
                title='프레임 '+str(frame)+' <img src=x onerror=alert(1)>',description='한국어 설명\n둘째 줄')
            r=self.stack.request('POST','/studies/'+f.uid+'/viewer-items','doctor',dict(requestId=str(uuid.uuid4()),item=item))
            self.assertEqual(r.status,200,r.text);keys.append(r.body)
        return ds,keys

    def ready(self,p):
        expect(p.locator('#report-preview')).to_be_visible()
        expect(p.locator('#report-preview [role=status]')).to_contain_text('미리보기 내용을 확인')
        return p.frame_locator('#report-preview iframe')

    def test_01_api_snapshot_access_and_draft_exclusion(self):
        f=self.fixture();self.seed_report(f,action='approve');_,keys=self.add_keys(f)
        before=self.saved_rows(f); original=self.hashes()
        for actor in ['doctor','doctor2','tech']:
            data=self.preview(f,actor)
            self.assertEqual(data['study']['uid'],f.uid);self.assertEqual(data['study']['id'],f.patient_id)
            self.assertEqual(data['report']['findings'],f.secret);self.assertEqual(data['report']['rs'],'A')
            self.assertNotIn('draft',data);self.assertEqual(len(data['keys']),2)
        self.preview(f,'kdoctor',403)
        self.stack.create_test_identity('preview-admin',['admin'],'hallym')
        self.assertTrue(self.preview(f,'preview-admin')['canPreviewEditor'])
        anonymous=self.pw.request.new_context(ignore_https_errors=True)
        try:
            denied=anonymous.get(self.stack.proxy+'/api/studies/'+f.uid+'/report-preview')
            self.assertEqual(denied.status,401);self.assertEqual(denied.headers.get('cache-control'),'no-store')
        finally:anonymous.dispose()
        base.psql('UPDATE "StudyState" SET rs=\'P\',"preDoc"='+literal(self.stack.actor('doctor'))+',"preReviewer"='+literal(self.stack.actor('jmryu'))+' WHERE uid='+literal(f.uid))
        self.preview(f,'doctor2',403);self.preview(f,'tech',403);self.preview(f,'preview-admin',403);self.preview(f,'doctor')
        self.assertEqual(self.saved_rows(f),before);self.assertEqual(self.hashes(),original)

    def test_02_saved_editor_key_frames_and_print(self):
        f=self.fixture();self.seed_report(f,action='approve',findings='한글 저장본 <script>window.bad=1</script>\n'+('긴 판독문 내용\n'*55))
        ds,keys=self.add_keys(f)
        other=self.stack.request('PUT','/studies/'+f.uid+'/report','doctor2',dict(baseVersion=1,findings='OTHER PRIVATE',conclusion='',recommendation=''))
        self.assertEqual(other.status,200,other.text)
        p=self.login();self.select(p,f);before=self.saved_rows(f);original=self.hashes(); writes=[]
        response=p.request.get(self.stack.proxy+'/api/studies/'+f.uid+'/report-preview')
        self.assertEqual(response.status,200);self.assertEqual(response.headers.get('cache-control'),'no-store')
        p.on('request',lambda r:writes.append(r.url) if r.method in ['POST','PUT','PATCH','DELETE'] and '/report' in r.url else None)
        p.locator('#b-print').click();paper=self.ready(p)
        expect(paper.locator('header')).to_contain_text('승인된 저장본');expect(paper.locator('main')).not_to_contain_text('OTHER PRIVATE')
        self.assertEqual(paper.locator('script').count(),0)
        for key in keys:p.locator('#report-preview').get_by_role('checkbox',name=key['item']['title'],exact=True).check()
        paper=self.ready(p);expect(paper.locator('.key')).to_have_count(2)
        for key in keys:expect(paper.locator('.key strong').filter(has_text=key['item']['title'])).to_have_count(1)
        self.assertEqual(paper.locator('img').count(),2)
        expect(paper.locator('.identity-example')).to_contain_text(f.patient_id)
        self.assertTrue(paper.locator('.key img').evaluate_all('(imgs)=>imgs.every(i=>i.complete&&i.naturalWidth>0)'))
        sources=paper.locator('.key img').evaluate_all('imgs=>imgs.map(i=>i.src)')
        encoded=p.evaluate('''async urls=>Promise.all(urls.map(async url=>{
            const bytes=new Uint8Array(await(await fetch(url)).arrayBuffer());let raw='';
            for(const byte of bytes)raw+=String.fromCharCode(byte);return btoa(raw);
        }))''',sources)
        location=self.stack._orthanc_request('POST','/tools/lookup',str(ds.SOPInstanceUID).encode()).body[0]['ID']
        expected={hashlib.sha256(self.stack.orthanc_bytes('/instances/'+location+'/frames/'+str(frame)+'/preview')).hexdigest() for frame in [0,2]}
        actual={hashlib.sha256(base64.b64decode(value)).hexdigest() for value in encoded}
        self.assertEqual(len(expected),2);self.assertEqual(actual,expected)
        for frame in [1,3]:expect(paper.locator('main')).to_contain_text('프레임 '+str(frame))
        p.screenshot(path=str(Path(__file__).parent/'artifacts/report-preview.png'))
        p.evaluate('''()=>{const original=window.open; window.open=(...args)=>{const w=original(...args);if(w)w.print=()=>{w.__printCalled=true};return w;};}''')
        with p.expect_popup() as opened:p.locator('#report-preview').get_by_role('button',name='인쇄 / PDF').click()
        printed=opened.value;printed.wait_for_function('()=>window.__printCalled===true')
        expect(printed.locator('main')).to_contain_text(f.patient_id);expect(printed.locator('.key')).to_have_count(2)
        expect(printed.locator('header')).to_contain_text('승인일(UTC):')
        printed.evaluate("()=>window.dispatchEvent(new Event('afterprint'))")
        self.assertFalse(printed.is_closed())
        output=Path(__file__).parent/'artifacts/report-preview.pdf'
        printed.pdf(path=str(output),prefer_css_page_size=True)
        pdf=PdfReader(output);self.assertGreaterEqual(len(pdf.pages),3)
        for sheet in pdf.pages:
            self.assertIn(f.patient_id,sheet.extract_text());self.assertIn('승인된 저장본',sheet.extract_text())
        printed.close();self.assertEqual(writes,[]);self.assertEqual(self.saved_rows(f),before);self.assertEqual(self.hashes(),original)
        p.locator('#report-preview').get_by_role('button',name='닫기',exact=True).click()
        p.locator('#findings').evaluate("e=>e.value='현재 편집문 <b>그대로</b>'")
        p.locator('#b-print').click();self.ready(p)
        p.locator('#report-preview select').select_option('editor');paper=self.ready(p)
        expect(paper.locator('header')).to_contain_text('현재 편집문 · 미확정')
        expect(paper.locator('pre').first).to_have_text('현재 편집문 <b>그대로</b>')
        p.locator('#report-preview').get_by_role('button',name='닫기',exact=True).click()
        self.assertEqual(writes,[]);self.assertEqual(self.saved_rows(f),before)

    def test_03_failure_change_and_popup_block(self):
        f=self.fixture();self.seed_report(f);_,keys=self.add_keys(f)
        p=self.login();self.select(p,f);p.locator('#b-print').click();self.ready(p)
        def failed(route):route.fulfill(status=503,body='unavailable')
        p.route('**/frames/*/preview',failed)
        p.locator('#report-preview').get_by_role('checkbox').first.check()
        expect(p.locator('#report-preview [role=status]')).to_contain_text('불러오지 못했습니다')
        expect(p.locator('#report-preview').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
        p.unroute('**/frames/*/preview',failed)
        p.locator('#report-preview').get_by_role('button',name='다시 확인').click();self.ready(p)
        p.evaluate('()=>window.open=()=>null')
        p.locator('#report-preview').get_by_role('button',name='인쇄 / PDF').click()
        expect(p.locator('#toast')).to_contain_text('인쇄 창을 열 수 없습니다')
        p.reload();self.select(p,f);p.locator('#b-print').click();self.ready(p)
        r=self.stack.request('POST','/studies/'+f.uid+'/report/commit','doctor',dict(action='save',baseVersion=1,findings='new server',conclusion='',recommendation=''))
        self.assertEqual(r.status,201,r.text)
        p.locator('#report-preview').get_by_role('button',name='인쇄 / PDF').click()
        expect(p.locator('#report-preview [role=status]')).to_contain_text('출력 내용이 변경')
        expect(p.locator('#report-preview').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
        p.locator('#report-preview').get_by_role('button',name='다시 확인').click();paper=self.ready(p)
        expect(paper.locator('main')).to_contain_text('new server')

    def test_04_late_close_navigation_and_session(self):
        f=self.fixture();g=self.fixture();self.seed_report(f);self.seed_report(g)
        p=self.login();self.select(p,f);pending=[]
        p.route('**/report-preview',lambda route:pending.append(route))
        p.locator('#b-print').click()
        expect(p.locator('#report-preview [role=status]')).to_contain_text('불러오는 중')
        p.locator('#report-preview').get_by_role('button',name='닫기',exact=True).click()
        self.select(p,g);self.select(p,f)
        for route in pending:
            try:route.continue_()
            except Exception:pass
        p.unroute('**/report-preview');expect(p.locator('#report-preview')).not_to_be_visible()
        p.locator('#b-print').click();self.ready(p)
        p.evaluate("()=>window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended',newValue:'test'}))")
        expect(p.locator('#report-preview')).not_to_be_visible()
        self.assertEqual(p.locator('#report-preview iframe').get_attribute('srcdoc'),'')

    def test_05_source_change_hidden_key_and_oversized_image(self):
        f=self.fixture();self.seed_report(f);_,keys=self.add_keys(f)
        p=self.login();self.select(p,f);before=self.saved_rows(f);original=self.hashes()
        p.locator('#b-print').click();self.ready(p)
        p.locator('#report-preview').get_by_role('checkbox').first.check();self.ready(p)
        def changed(route):
            response=route.fetch();body=response.json();body['UncompressedMD5']='0'*32
            route.fulfill(response=response,json=body)
        p.route('**/attachments/dicom/info',changed)
        p.locator('#report-preview').get_by_role('button',name='인쇄 / PDF').click()
        expect(p.locator('#report-preview [role=status]')).to_contain_text('원본이 변경')
        expect(p.locator('#report-preview').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
        p.unroute('**/attachments/dicom/info',changed)
        p.locator('#report-preview').get_by_role('button',name='다시 확인').click();self.ready(p)
        def oversized(route):
            header=b'\x89PNG\r\n\x1a\n'+(13).to_bytes(4,'big')+b'IHDR'+(8192).to_bytes(4,'big')*2
            route.fulfill(status=200,content_type='image/png',body=header)
        p.route('**/frames/*/preview',oversized)
        p.locator('#report-preview').get_by_role('checkbox').first.check()
        expect(p.locator('#report-preview [role=status]')).to_contain_text('해상도 한도')
        expect(p.locator('#report-preview').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
        p.unroute('**/frames/*/preview',oversized)
        self.assertEqual(self.saved_rows(f),before);self.assertEqual(self.hashes(),original)
        p.locator('#report-preview').get_by_role('button',name='다시 확인').click();self.ready(p)
        p.locator('#report-preview').get_by_role('checkbox').first.check();self.ready(p)
        key=self.preview(f)['keys'][0]
        body=dict(requestId=str(uuid.uuid4()),expectedRevision=key['revision'],action='hide',reason='owned synthetic hide',
            item={k:v for k,v in key['item'].items() if k!='hidden'})
        response=self.stack.request('POST','/studies/'+f.uid+'/viewer-items/'+key['id']+'/revisions','doctor',body)
        self.assertEqual(response.status,200,response.text)
        p.locator('#report-preview').get_by_role('button',name='인쇄 / PDF').click()
        expect(p.locator('#report-preview [role=status]')).to_contain_text('출력 내용이 변경')
        expect(p.locator('#report-preview').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()

    def test_06_tele_cancel_prelim_and_hold_match_report_reader(self):
        f=self.fixture();path='/studies/'+f.uid
        opened=self.stack.request('PATCH',path,'doctor',dict(ts='wait',teleTo='kin-center'))
        self.assertEqual(opened.status,200,opened.text)
        self.seed_report(f);self.add_keys(f)
        self.assertEqual(self.stack.request('POST',path+'/hold','doctor').status,201)
        before=self.saved_rows(f);original=self.hashes()
        for actor in ['kdoctor','ktech']:
            self.assertEqual(self.preview(f,actor)['report']['findings'],f.secret)
            self.assertEqual(self.stack.request('GET',path+'/report/versions',actor).status,200)
        base.psql('UPDATE "StudyState" SET rs=\'P\',"preDoc"='+literal(self.stack.actor('doctor'))+',"preReviewer"='+literal(self.stack.actor('kdoctor'))+' WHERE uid='+literal(f.uid))
        self.preview(f,'kdoctor');self.preview(f,'ktech',403)
        self.assertEqual(self.stack.request('GET',path+'/report/versions','kdoctor').status,200)
        self.assertEqual(self.stack.request('GET',path+'/report/versions','ktech').status,403)
        base.psql('UPDATE "StudyState" SET rs=\'T\',"preDoc"=NULL,"preReviewer"=NULL WHERE uid='+literal(f.uid))
        cancelled=self.stack.request('PATCH',path,'doctor',dict(ts='cancelled'))
        self.assertEqual(cancelled.status,200,cancelled.text);self.assertIsNone(cancelled.body['teleInstitutionId'])
        for actor in ['kdoctor','ktech']:
            self.preview(f,actor,403)
            self.assertEqual(self.stack.request('GET',path+'/report/versions',actor).status,404)
        self.preview(f,'doctor')
        self.assertEqual(self.saved_rows(f),before);self.assertEqual(self.hashes(),original)

    def test_07_no_keys_and_unsupported_print_engine(self):
        f=self.fixture();p=self.login();self.select(p,f);before=self.saved_rows(f)
        p.locator('#b-print').click();paper=self.ready(p)
        expect(paper.locator('header')).to_contain_text('저장된 판독문 없음')
        expect(p.locator('#report-preview')).to_contain_text('저장한 키 이미지가 없습니다.')
        p.evaluate('''()=>{const original=window.open;window.open=(...a)=>{const w=original(...a);w.print=()=>w.__printCalled=true;return w;};}''')
        with p.expect_popup() as opened:p.locator('#report-preview').get_by_role('button',name='인쇄 / PDF').click()
        printed=opened.value;printed.wait_for_function('()=>window.__printCalled===true')
        expect(printed.locator('header')).to_contain_text(f.patient_id);self.assertEqual(printed.locator('img').count(),0)
        printed.close()
        p.once('dialog',lambda d:d.dismiss())
        p.locator('#logout').evaluate('e=>e.click()')
        expect(p.locator('#report-preview')).to_be_visible()
        # Simulate a parser without page-margin support, without claiming a
        # Firefox/Safari run. The supported path above uses the real engine.
        p.evaluate('''()=>{const original=CSSStyleSheet.prototype.replaceSync;CSSStyleSheet.prototype.replaceSync=function(text){return original.call(this,text.startsWith('@page')?'':text);};}''')
        p.locator('#report-preview').get_by_role('button',name='다시 확인').click()
        expect(p.locator('#report-preview [role=status]')).to_contain_text('페이지별 식별정보 출력을 지원하지 않습니다')
        expect(p.locator('#report-preview').get_by_role('button',name='인쇄 / PDF')).to_be_disabled()
        self.assertEqual(self.saved_rows(f),before)


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    names=sys.argv[1:] or [name for name in ReportPreviewE2E.__dict__ if name.startswith('test_')]
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(ReportPreviewE2E(name) for name in names))
    sys.exit(not result.wasSuccessful())
