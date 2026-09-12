# coding: utf-8
"""TEST-D09-KEY-PREVIEW: bounded output crop, independent pixels and PDF."""
import base64,io,re,sys,unittest
from pathlib import Path
import numpy as np
from PIL import Image
from pypdf import PdfReader
from test_report_window import ReportWindowE2E,expect

def flat(text):return re.sub(r'\s+','',text)

class KeyPreviewControlsE2E(ReportWindowE2E):
    def open_keys(self,p,keys):
        p.locator('#b-print').click();self.ready(p)
        for key in keys:
            p.locator('#report-preview').get_by_role('checkbox',name=key['item']['title'],exact=True).check();self.ready(p)
        return self.ready(p)

    def arrays(self,p):
        urls=p.frame_locator('#report-preview iframe').locator('.key img').evaluate_all('xs=>xs.map(x=>x.src)')
        data=p.evaluate('''async urls=>Promise.all(urls.map(async url=>{const b=new Uint8Array(await(await fetch(url)).arrayBuffer());let s='';for(const v of b)s+=String.fromCharCode(v);return btoa(s)}))''',urls)
        return [np.asarray(Image.open(io.BytesIO(base64.b64decode(x))).convert('RGB')) for x in data]

    def adjust(self,p,zoom,x=0,y=0,target='all'):
        p.get_by_role('combobox',name='키 이미지 조절 대상',exact=True).select_option(target)
        for name,value in [('키 확대 (%)',zoom),('키 가로 이동 (%)',x),('키 세로 이동 (%)',y)]:p.get_by_label(name,exact=True).fill(str(value))
        expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()
        self.assertEqual(p.locator('#report-preview iframe').get_attribute('srcdoc'),'')
        p.get_by_role('button',name='키 확대·이동 적용',exact=True).click();return self.ready(p)

    def reference(self,image,zoom,x,y):
        h,w=image.shape[:2];scale=zoom/100
        # Inverse-map output pixel centres; no browser drawImage or product helper.
        yy,xx=np.indices((h,w));sx=np.floor(((xx+.5)-w*((1-scale)/2+x/100))/scale).astype(int);sy=np.floor(((yy+.5)-h*((1-scale)/2+y/100))/scale).astype(int)
        valid=(sx>=0)&(sx<w)&(sy>=0)&(sy<h);result=np.zeros_like(image);result[valid]=image[sy[valid],sx[valid]];return result

    def test_key_01_independent_pixels_selected_all_and_reset(self):
        f=self.fixture();self.seed_report(f);self.add_keys(f);keys=self.preview(f)['keys'];p=self.login();self.select(p,f)
        before=self.saved_rows(f);original=self.hashes();self.open_keys(p,keys);initial=self.arrays(p)
        self.adjust(p,200,25,-25,keys[0]['id']);actual=self.arrays(p)
        self.assertTrue(np.array_equal(actual[0],self.reference(initial[0],200,25,-25)));self.assertTrue(np.array_equal(actual[1],initial[1]))
        self.adjust(p,50,25,0);actual=self.arrays(p)
        for i in range(2):self.assertTrue(np.array_equal(actual[i],self.reference(initial[i],50,25,0)))
        p.get_by_role('button',name='키 원래 범위로',exact=True).click();self.ready(p)
        for a,b in zip(self.arrays(p),initial):self.assertTrue(np.array_equal(a,b))
        self.assertEqual(self.saved_rows(f),before);self.assertEqual(self.hashes(),original)
        print('KEYPREVIEW independent inverse-map exact RGB: selected zoom200 pan25/-25 and all zoom50 pan25/0',flush=True)

    def test_key_02_window_editor_layout_pdf(self):
        f=self.fixture();self.seed_report(f,action='approve');_,pixels,_,key=self.window_key(f)
        p=self.login();self.select(p,f);p.locator('#findings').evaluate("e=>e.value='키 출력 편집문 <b>미확정</b>'")
        before=self.saved_rows(f);original=self.hashes();self.open_keys(p,[key])
        p.get_by_role('combobox',name='출력 판독문',exact=True).select_option('editor');self.ready(p)
        p.get_by_role('combobox',name='출력 영상 밝기',exact=True).select_option('manual')
        p.get_by_label('W (폭)',exact=False).fill('1000');p.get_by_label('L (중심)',exact=False).fill('-100');p.get_by_role('button',name='밝기 적용',exact=True).click();self.ready(p)
        baseline=self.arrays(p)[0];paper=self.adjust(p,200,25,0)
        actual=self.arrays(p)[0];self.assertTrue(np.array_equal(actual,self.reference(baseline,200,25,0)))
        expect(paper.locator('.key-adjustment')).to_contain_text('출력 확대 200%');expect(paper.locator('main')).to_contain_text('현재 편집문 · 미확정')
        p.get_by_role('combobox',name='키 이미지 배치',exact=True).select_option('double');self.ready(p);self.assertTrue(np.array_equal(self.arrays(p)[0],actual))
        p.evaluate('''()=>{const open=window.open;window.open=(...args)=>{const w=open(...args);if(w)w.print=()=>w.__printed=true;return w}}''')
        with p.expect_popup() as opened:p.get_by_role('button',name='인쇄 / PDF',exact=True).click()
        printed=opened.value;printed.wait_for_function('()=>window.__printed===true')
        output=Path(__file__).parent/'artifacts/key-preview-controls.pdf';printed.pdf(path=str(output),prefer_css_page_size=True);pdf=PdfReader(output)
        text='\n'.join(page.extract_text() for page in pdf.pages);flatall=flat(text);self.assertIn(flat('출력 확대 200%'),flatall);self.assertIn(flat('키 출력 편집문 <b>미확정</b>'),flatall)
        images=[np.asarray(i.image.convert('RGB')) for page in pdf.pages for i in page.images];self.assertEqual(len(images),1);self.assertTrue(np.array_equal(images[0],actual))
        for page in pdf.pages:self.assertIn(f.patient_id,page.extract_text())
        printed.close();self.assertEqual(p.locator('#findings').input_value(),'키 출력 편집문 <b>미확정</b>');self.assertEqual(self.saved_rows(f),before);self.assertEqual(self.hashes(),original)
        print('KEYPREVIEW PDF',len(pdf.pages),'pages, exact embedded RGB; W/L + editor + double layout',flush=True)

    def test_key_03_selection_reselect_reload_and_invalid(self):
        f=self.fixture();self.seed_report(f);self.add_keys(f);keys=self.preview(f)['keys'];p=self.login();self.select(p,f);self.open_keys(p,keys);initial=self.arrays(p)
        self.adjust(p,200,0,0,keys[0]['id']);changed=self.arrays(p)[0]
        checkbox=p.locator('#report-preview').get_by_role('checkbox',name=keys[0]['item']['title'],exact=True)
        checkbox.uncheck();self.ready(p);self.assertEqual(p.get_by_role('combobox',name='키 이미지 조절 대상',exact=True).locator('option').count(),2)
        checkbox.check();self.ready(p);self.assertTrue(np.array_equal(self.arrays(p)[0],changed))
        for label,value in [('키 확대 (%)',''),('키 확대 (%)','401'),('키 확대 (%)','24'),('키 가로 이동 (%)','101')]:
            p.get_by_label(label,exact=True).fill(value);p.get_by_role('button',name='키 확대·이동 적용',exact=True).click()
            expect(p.locator('#report-preview [role=status]')).to_contain_text('숫자로 입력');expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()
            p.get_by_role('button',name='키 원래 범위로',exact=True).click();self.ready(p)
        self.adjust(p,400,-100,100);p.get_by_role('button',name='다시 확인',exact=True).click();self.ready(p)
        expect(p.get_by_role('button',name='키 확대·이동 적용',exact=True)).to_be_disabled()
        checkbox.check();self.ready(p)
        self.assertTrue(np.array_equal(self.arrays(p)[0],initial[0]))
        p.locator('#report-preview').get_by_role('button',name='닫기',exact=True).click();self.open_keys(p,[keys[0]])
        expect(p.get_by_label('키 확대 (%)',exact=True)).to_have_value('100');self.assertTrue(np.array_equal(self.arrays(p)[0],initial[0]))

    def test_key_04_failure_stale_print_and_late_close(self):
        f=self.fixture();self.seed_report(f);_,_,_,key=self.window_key(f);p=self.login();self.select(p,f);before=self.saved_rows(f);original=self.hashes();self.open_keys(p,[key])
        p.route('**/frames/0/preview',lambda route:route.fulfill(status=503,body='synthetic unavailable'))
        p.get_by_label('키 확대 (%)',exact=True).fill('200');p.get_by_role('button',name='키 확대·이동 적용',exact=True).click()
        expect(p.locator('#report-preview [role=status]')).to_contain_text('불러오지 못했습니다');expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()
        p.unroute('**/frames/0/preview');p.get_by_role('button',name='키 확대·이동 적용',exact=True).click();self.ready(p)
        p.route('**/attachments/dicom/info',lambda route:route.fulfill(status=200,content_type='application/json',body='{"UncompressedMD5":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'))
        p.get_by_role('button',name='인쇄 / PDF',exact=True).click();expect(p.locator('#report-preview [role=status]')).to_contain_text('원본이 변경');expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled();p.unroute('**/attachments/dicom/info')
        p.evaluate('''()=>{const fetch=window.fetch;let once=true;window.fetch=async(...args)=>{const r=await fetch(...args);if(once&&String(args[0]).endsWith('/preview')){once=false;const b=await r.arrayBuffer();return new Promise(resolve=>window.__releaseKey=()=>resolve(new Response(b,{status:r.status,headers:r.headers})))}return r}}''')
        p.get_by_role('button',name='키 확대·이동 적용',exact=True).click();p.wait_for_function('()=>typeof window.__releaseKey==="function"')
        p.locator('#report-preview').get_by_role('button',name='닫기',exact=True).click();self.open_keys(p,[key]);baseline=self.arrays(p)[0]
        p.evaluate('()=>window.__releaseKey()');self.ready(p);self.assertTrue(np.array_equal(self.arrays(p)[0],baseline));expect(p.get_by_label('키 확대 (%)',exact=True)).to_have_value('100')
        self.assertEqual(self.saved_rows(f),before);self.assertEqual(self.hashes(),original)

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    names=sys.argv[1:] or [n for n in KeyPreviewControlsE2E.__dict__ if n.startswith('test_key_')]
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(KeyPreviewControlsE2E(n) for n in names));sys.exit(not result.wasSuccessful())
