# coding: utf-8
"""TEST-D09-PRINT-WINDOW: real Orthanc pixels and read-only print controls."""
import base64,io,sys,unittest,uuid,time
from pathlib import Path
import numpy as np
from PIL import Image
from pypdf import PdfReader
from pydicom.dataset import FileDataset,FileMetaDataset
from pydicom.uid import generate_uid,CTImageStorage,ExplicitVRLittleEndian
from test_report_preview import ReportPreviewE2E,expect

class ReportWindowE2E(ReportPreviewE2E):
    def window_key(self,f,slope=2,intercept=-1024,signed=True,size=64):
        meta=FileMetaDataset();meta.TransferSyntaxUID=ExplicitVRLittleEndian
        meta.ImplementationClassUID=generate_uid()
        ds=FileDataset(None,{},file_meta=meta,preamble=b'\0'*128)
        ds.is_little_endian=True;ds.is_implicit_VR=False
        ds.SpecificCharacterSet='ISO_IR 192';ds.PatientName='PRINTWINDOW^SYNTHETIC';ds.PatientID=f.patient_id
        ds.PatientBirthDate='';ds.PatientSex='O';ds.InstitutionName='한림병원'
        ds.StudyDate=ds.SeriesDate='20260909';ds.StudyTime=ds.SeriesTime='120000'
        ds.StudyDescription=ds.SeriesDescription='Synthetic print window ramp'
        ds.FrameOfReferenceUID=generate_uid();ds.InstanceNumber=1
        ds.ImageOrientationPatient=[1,0,0,0,1,0];ds.ImagePositionPatient=[0,0,0]
        ds.PixelSpacing=[1,1];ds.SliceThickness=1;ds.ImageType=['ORIGINAL','PRIMARY','AXIAL']
        ds.StudyInstanceUID=f.uid;ds.SeriesInstanceUID=generate_uid();ds.SOPInstanceUID=generate_uid()
        ds.SOPClassUID='1.2.840.10008.5.1.4.1.1.2';ds.file_meta.MediaStorageSOPClassUID=ds.SOPClassUID
        ds.file_meta.MediaStorageSOPInstanceUID=ds.SOPInstanceUID;ds.Modality='CT';ds.SeriesNumber=8
        ds.Rows=size;ds.Columns=size;ds.PhotometricInterpretation='MONOCHROME2';ds.SamplesPerPixel=1
        ds.BitsAllocated=16;ds.BitsStored=16;ds.HighBit=15;ds.PixelRepresentation=int(signed)
        ds.RescaleSlope=slope;ds.RescaleIntercept=intercept;ds.RescaleType='HU'
        ds.WindowCenter=40;ds.WindowWidth=400
        if 'NumberOfFrames' in ds:del ds.NumberOfFrames
        values=np.arange(size*size).reshape(size,size)%1024
        pixels=(values-256 if signed else values*64).astype('<i2' if signed else '<u2');ds.PixelData=pixels.tobytes()
        buf=io.BytesIO();ds.save_as(buf,write_like_original=False)
        r=self.stack._orthanc_request('POST','/instances',buf.getvalue());self.assertEqual(r.status,200)
        item=dict(schemaVersion=1,kind='key',seriesUid=str(ds.SeriesInstanceUID),sopUid=str(ds.SOPInstanceUID),frame=1,title='출력 W/L CT',description='합성 경사 화소')
        saved=self.stack.request('POST','/studies/'+f.uid+'/viewer-items','doctor',dict(requestId=str(uuid.uuid4()),item=item))
        self.assertEqual(saved.status,200,saved.text)
        return ds,pixels,r.body['ID'],saved.body

    def test_01_server_rescale_and_window_pixels(self):
        f=self.fixture();ds,pixels,orth,key=self.window_key(f);p=self.login()
        before=self.saved_rows(f);original=self.hashes()
        images=[]
        raw=p.request.get(self.stack.proxy+'/instances/'+orth+'/frames/0/image-int16',headers={'Accept':'image/x-portable-arbitrarymap'})
        self.assertEqual(raw.status,200)
        header,body=raw.body().split(b'ENDHDR\n',1)
        self.assertIn(b'MAXVAL 65535',header)
        self.assertTrue(np.array_equal(np.frombuffer(body,dtype='>i2').reshape(64,64),pixels))
        for center,width in [(40,400),(-100,1000),(40,2),(40.5,2),(40,20000)]:
            r=p.request.get(self.stack.proxy+'/instances/'+orth+'/frames/0/rendered?window-center='+str(center-.5)+'&window-width='+str(width-1),headers={'Accept':'image/png'})
            self.assertEqual(r.status,200);self.assertTrue(r.headers['content-type'].startswith('image/png'))
            actual=np.asarray(Image.open(io.BytesIO(r.body()))).astype(float)
            self.assertEqual(actual.shape,pixels.shape)
            hu=pixels.astype(float)*2-1024
            expected=np.clip(((hu-(center-.5))/(width-1)+.5)*255,0,255)
            self.assertLessEqual(float(np.max(np.abs(actual-expected))),2)
            images.append(actual)
        self.assertFalse(np.array_equal(images[0],images[1]))
        self.assertEqual(self.saved_rows(f),before);self.assertEqual(self.hashes(),original)

    def select_ct(self,p,key):
        p.locator('#b-print').click();self.ready(p)
        p.locator('#report-preview').get_by_role('checkbox',name=key['item']['title'],exact=True).check()
        self.ready(p)
        p.get_by_role('combobox',name='출력 영상 밝기',exact=True).select_option('manual')
        expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()

    def image_pixels(self,p,paper):
        url=paper.locator('.key img').get_attribute('src')
        encoded=p.evaluate('''async url=>{const bytes=new Uint8Array(await(await fetch(url)).arrayBuffer());let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);}''',url)
        return np.asarray(Image.open(io.BytesIO(base64.b64decode(encoded))).convert('L'))

    def test_02_window_ui_pixels_pdf_and_defaults(self):
        f=self.fixture();self.seed_report(f,action='approve');ds,pixels,orth,key=self.window_key(f)
        p=self.login();self.select(p,f);before=self.saved_rows(f);original=self.hashes();self.select_ct(p,key)
        p.get_by_label('W (폭)',exact=False).fill('300');p.get_by_label('L (중심)',exact=False).fill('20')
        p.get_by_role('button',name='밝기 적용',exact=True).click();paper=self.ready(p)
        expect(paper.locator('.keys')).to_contain_text('출력 W 300 / L 20')
        first=self.image_pixels(p,paper)
        hu=pixels.astype(float)*2-1024
        self.assertLessEqual(float(np.max(np.abs(first.astype(float)-np.clip(((hu-19.5)/299+.5)*255,0,255)))),2)
        p.get_by_label('W (폭)',exact=False).fill('1000');p.get_by_label('L (중심)',exact=False).fill('-100')
        expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()
        self.assertEqual(p.locator('#report-preview iframe').get_attribute('srcdoc'),'')
        p.get_by_role('button',name='밝기 적용',exact=True).click();paper=self.ready(p)
        expect(paper.locator('.keys')).to_contain_text('출력 W 1000 / L -100')
        second=self.image_pixels(p,paper);self.assertFalse(np.array_equal(first,second))
        self.assertLessEqual(float(np.max(np.abs(second.astype(float)-np.clip(((hu+100.5)/999+.5)*255,0,255)))),2)
        p.evaluate('''()=>{const open=window.open;window.open=(...a)=>{const w=open(...a);if(w)w.print=()=>w.__printed=true;return w;};}''')
        with p.expect_popup() as opened:p.get_by_role('button',name='인쇄 / PDF',exact=True).click()
        printed=opened.value;printed.wait_for_function('()=>window.__printed===true')
        output=Path(__file__).parent/'artifacts/report-window.pdf';printed.pdf(path=str(output),prefer_css_page_size=True)
        pdf=PdfReader(output);text='\n'.join(sheet.extract_text() for sheet in pdf.pages)
        self.assertIn('출력 W 1000 / L -100',text)
        for sheet in pdf.pages:self.assertIn(f.patient_id,sheet.extract_text())
        images=[np.asarray(image.image.convert('L')) for sheet in pdf.pages for image in sheet.images]
        self.assertEqual(len(images),1);self.assertTrue(np.array_equal(images[0],second))
        printed.close()
        p.get_by_role('combobox',name='출력 영상 밝기',exact=True).select_option('auto');paper=self.ready(p)
        expect(paper.locator('.keys')).to_contain_text('밝기 자동 조정')
        p.locator('#report-preview').get_by_role('button',name='닫기',exact=True).click()
        p.locator('#b-print').click();self.ready(p)
        expect(p.get_by_role('combobox',name='출력 영상 밝기',exact=True)).to_have_value('auto')
        expect(p.get_by_label('W (폭)',exact=False)).to_have_value('400')
        expect(p.get_by_label('L (중심)',exact=False)).to_have_value('40')
        expect(p.get_by_label('W (폭)',exact=False)).not_to_be_visible()
        self.assertEqual(self.saved_rows(f),before);self.assertEqual(self.hashes(),original)

    def test_03_invalid_mixed_and_render_failure_recovery(self):
        f=self.fixture();self.seed_report(f);_,_,_,key=self.window_key(f);_,other=self.add_keys(f)
        p=self.login();self.select(p,f);before=self.saved_rows(f);self.select_ct(p,key)
        for width,center in [('',40),(0,40),(20001,40),(400,''),(400,10001)]:
            p.get_by_label('W (폭)',exact=False).fill(str(width));p.get_by_label('L (중심)',exact=False).fill(str(center))
            p.get_by_role('button',name='밝기 적용',exact=True).click()
            expect(p.locator('#report-preview [role=status]')).to_contain_text('숫자로 입력')
            expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()
        p.get_by_label('W (폭)',exact=False).fill('400');p.get_by_label('L (중심)',exact=False).fill('40')
        mixed=p.locator('#report-preview').get_by_role('checkbox',name=other[0]['item']['title'],exact=True)
        mixed.check()
        expect(p.locator('#report-preview [role=status]')).to_contain_text('일반 흑백 CT')
        expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()
        mixed.uncheck();self.ready(p)
        p.route('**/image-int16',lambda route:route.fulfill(status=503,body='temporary'))
        p.get_by_role('button',name='밝기 적용',exact=True).click()
        expect(p.locator('#report-preview [role=status]')).to_contain_text('불러오지 못했습니다')
        expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()
        p.unroute('**/image-int16');p.get_by_role('button',name='밝기 적용',exact=True).click();self.ready(p)
        self.assertEqual(self.saved_rows(f),before)

    def test_04_late_image_cannot_restore_old_window(self):
        f=self.fixture();self.seed_report(f);_,_,_,key=self.window_key(f)
        p=self.login();self.select(p,f);before=self.saved_rows(f);self.select_ct(p,key)
        p.evaluate('''()=>{const fetch=window.fetch;let hold=true;window.fetch=async(...args)=>{
            const target=hold&&String(args[0]).includes('/image-int16');if(target)hold=false;
            const r=await fetch(...args);if(!target)return r;
            const body=await r.arrayBuffer();return await new Promise(resolve=>window.__releaseWindow=()=>{
                const response=new Response(body,{status:r.status,headers:r.headers});
                const getReader=response.body.getReader.bind(response.body);
                response.body.getReader=()=>{const reader=getReader(),cancel=reader.cancel.bind(reader);
                    reader.cancel=async()=>{await cancel();window.__oldWindowDrained=true;};return reader;};
                resolve(response);
            });
        };}''')
        p.get_by_role('button',name='밝기 적용',exact=True).click()
        p.wait_for_function('()=>typeof window.__releaseWindow === "function"')
        p.get_by_label('L (중심)',exact=False).fill('80')
        p.get_by_role('button',name='밝기 적용',exact=True).click();paper=self.ready(p)
        expect(paper.locator('.keys')).to_contain_text('출력 W 400 / L 80');current=self.image_pixels(p,paper)
        p.evaluate('()=>window.__releaseWindow()')
        p.wait_for_function('()=>window.__oldWindowDrained===true')
        expect(paper.locator('.keys')).to_contain_text('출력 W 400 / L 80')
        self.assertTrue(np.array_equal(self.image_pixels(p,paper),current))
        expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_enabled()
        self.assertEqual(self.saved_rows(f),before)

    def test_05_manual_source_change_and_lut_gate(self):
        f=self.fixture();self.seed_report(f);_,_,orth,key=self.window_key(f)
        p=self.login();self.select(p,f);before=self.saved_rows(f);original=self.hashes();self.select_ct(p,key)
        for name,value in [('ModalityLUTSequence',[]),('VOILUTSequence',[]),('VOILUTFunction','SIGMOID'),('BitsAllocated','8')]:
            def lut(route):
                response=route.fetch();body=response.json();body[name]=value;route.fulfill(response=response,json=body)
            p.route('**/'+orth+'/simplified-tags',lut)
            p.get_by_role('button',name='밝기 적용',exact=True).click()
            expect(p.locator('#report-preview [role=status]')).to_contain_text('일반 흑백 CT')
            expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()
            p.unroute('**/'+orth+'/simplified-tags',lut)
        calls=[0]
        def changed(route):
            response=route.fetch();body=response.json();calls[0]+=1
            if calls[0]>1:body['UncompressedMD5']='0'*32
            route.fulfill(response=response,json=body)
        p.route('**/'+orth+'/attachments/dicom/info',changed)
        p.get_by_role('button',name='밝기 적용',exact=True).click()
        expect(p.locator('#report-preview [role=status]')).to_contain_text('원본이 변경')
        expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()
        p.unroute('**/'+orth+'/attachments/dicom/info',changed)
        p.get_by_role('button',name='밝기 적용',exact=True).click();self.ready(p)
        p.route('**/'+orth+'/attachments/dicom/info',changed)
        p.get_by_role('button',name='인쇄 / PDF',exact=True).click()
        expect(p.locator('#report-preview [role=status]')).to_contain_text('원본이 변경')
        expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()
        self.assertEqual(self.saved_rows(f),before);self.assertEqual(self.hashes(),original)

    def test_07_full_32_key_manual_batch(self):
        f=self.fixture();self.seed_report(f)
        for _ in range(32):self.window_key(f,size=512)
        p=self.login();self.select(p,f);before=self.saved_rows(f);original=self.hashes()
        p.locator('#b-print').click();self.ready(p)
        p.get_by_role('combobox',name='출력 영상 밝기',exact=True).select_option('manual')
        boxes=p.locator('#report-preview').get_by_role('checkbox');self.assertEqual(boxes.count(),32)
        for box in boxes.all():box.check()
        paper=self.ready(p);self.assertEqual(paper.locator('.key img').count(),32)
        started=time.monotonic();p.get_by_role('button',name='밝기 적용',exact=True).click();paper=self.ready(p)
        self.assertEqual(paper.locator('.key img').count(),32)
        self.assertLess(time.monotonic()-started,15)
        print('32 distinct 512x512 manual keys prepared in',round(time.monotonic()-started,3),'seconds')
        self.assertEqual(self.saved_rows(f),before);self.assertEqual(self.hashes(),original)

    def test_06_narrow_fractional_unsigned_and_malformed_pixels(self):
        f=self.fixture();self.seed_report(f)
        _,pixels,orth,key=self.window_key(f,slope=.00005,intercept=39.5,signed=False)
        p=self.login();self.select(p,f);before=self.saved_rows(f);original=self.hashes();self.select_ct(p,key)
        hu=pixels.astype(float)*.00005+39.5
        for center,width in [(40,1),(40.0001,1),(40,1.5),(40,2),(40,20000)]:
            p.get_by_label('W (폭)',exact=False).fill(str(width));p.get_by_label('L (중심)',exact=False).fill(str(center))
            p.get_by_role('button',name='밝기 적용',exact=True).click();paper=self.ready(p)
            expected=np.where(hu>center-.5,255,0) if width==1 else np.clip(((hu-(center-.5))/(width-1)+.5)*255,0,255)
            self.assertLessEqual(float(np.max(np.abs(self.image_pixels(p,paper).astype(float)-expected))),.51)
        for body in [b'bad',b'P7\nWIDTH 9999\nHEIGHT 9999\nDEPTH 1\nMAXVAL 65535\nTUPLTYPE GRAYSCALE\nENDHDR\n',
                     b'P7\nWIDTH 64\nHEIGHT 64\nDEPTH 1\nMAXVAL 65535\nTUPLTYPE GRAYSCALE\nENDHDR\n\0']:
            p.route('**/image-uint16',lambda route:route.fulfill(status=200,content_type='image/x-portable-arbitrarymap',body=body))
            p.get_by_role('button',name='밝기 적용',exact=True).click()
            expect(p.locator('#report-preview [role=status]')).to_contain_text('출력 원본 화소')
            expect(p.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled()
            p.unroute('**/image-uint16')
        p.get_by_role('button',name='밝기 적용',exact=True).click();self.ready(p)
        self.assertEqual(self.saved_rows(f),before);self.assertEqual(self.hashes(),original)

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    names=sys.argv[1:] or [n for n in ReportWindowE2E.__dict__ if n.startswith('test_')]
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(ReportWindowE2E(n) for n in names))
    sys.exit(not result.wasSuccessful())
