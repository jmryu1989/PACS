# coding: utf-8
"""REQ-D01-IMAGE-PREVIEW: rendered pixels, original identity and recovery."""
import sys,unittest,uuid,base64,io
from pathlib import Path
from PIL import Image
import numpy as np
from playwright.sync_api import expect
from test_thumbnail_series import ThumbnailSeriesE2E
from test_cine import CineE2E
from pydicom import dcmread
from pydicom.uid import generate_uid

class WorklistImagePreviewE2E(ThumbnailSeriesE2E):
    def preview(self,p,n=0):
        button=p.locator('.thumb-preview-open').nth(n);expect(button).to_be_enabled();button.click()
        d=p.locator('#worklist-image-preview');expect(d.locator('[data-status]')).to_contain_text('Rendered',timeout=25000);return d

    def png(self,p):
        data=p.locator('#worklist-image-preview img').evaluate("i=>{const c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;c.getContext('2d').drawImage(i,0,0);return c.toDataURL('image/png').split(',')[1]}")
        return np.asarray(Image.open(io.BytesIO(base64.b64decode(data))).convert('RGB'))

    def test_preview_01_series_frame_window_pixels_and_editor_retention(self):
        f=self.multiple('SYNTHETIC-PREVIEW-'+uuid.uuid4().hex[:12],'current','20260801');self.seed_report(f)
        original=self.originals();versions=self.report_rows(f);p=self.login();self.select(p,f);self.thumbs(p)
        p.locator('#findings').fill('SYNTHETIC PREVIEW UNSAVED');p.evaluate('clearInterval(poll)')
        requests=[];p.on('request',lambda request:requests.append(request.url) if '/rendered?' in request.url else None)
        d=self.preview(p,1);expect(d.locator('[data-series] option')).to_have_count(2)
        initial=self.png(p);self.assertTrue(requests);original_url=requests[-1]
        d.locator('[data-width]').fill('400');d.locator('[data-center]').fill('40');d.locator('[data-apply]').click()
        expect(d.locator('[data-status]')).to_have_text('Rendered · W 400 / L 40');adjusted=self.png(p)
        self.assertFalse(np.array_equal(initial,adjusted));self.assertIn('window-width=400',requests[-1]);self.assertIn('window-center=40',requests[-1])
        expected=p.request.get(requests[-1],headers={'Accept':'image/png'});self.assertEqual(expected.status,200)
        np.testing.assert_array_equal(adjusted,np.asarray(Image.open(io.BytesIO(expected.body())).convert('RGB')))
        d.locator('[data-reset]').click();expect(d.locator('[data-status]')).to_have_text('Rendered · Original Window');np.testing.assert_array_equal(self.png(p),initial)
        d.locator('[data-frame]').fill('1');d.locator('[data-frame]').dispatch_event('change');expect(d.locator('[data-status]')).to_contain_text('Rendered')
        expect(d.locator('[data-prev]')).to_be_disabled();d.locator('[data-next]').click();expect(d.locator('[data-status]')).to_contain_text('Rendered');expect(d.locator('[data-frame]')).to_have_value('2')
        selected=d.locator('[data-series]').input_value();d.locator('[data-series]').select_option('1' if selected=='0' else '0');expect(d.locator('[data-status]')).to_contain_text('Rendered');expect(d.locator('[data-frame]')).to_have_value('1')
        expect(p.locator('#findings')).to_have_value('SYNTHETIC PREVIEW UNSAVED');self.assertEqual(p.evaluate('selectedUid'),f.uid)
        folder=Path('../tmp/worklist-image-preview/screens');folder.mkdir(parents=True,exist_ok=True);p.screenshot(path=str(folder/'preview.png'))
        d.locator('[data-close]').click();self.assertEqual(self.originals(),original);self.assertEqual(self.report_rows(f),versions)

    def test_preview_02_denied_render_retry_and_selection_change(self):
        f=self.multiple('SYNTHETIC-PREVIEW-'+uuid.uuid4().hex[:12],'current','20260801');p=self.login();self.select(p,f);self.thumbs(p)
        p.route('**/frames/*/rendered?*',lambda route:route.fulfill(status=403,body='denied'))
        p.locator('.thumb-preview-open').first.click();d=p.locator('#worklist-image-preview')
        expect(d.locator('[data-status]')).to_contain_text('HTTP 403');expect(d.locator('img')).not_to_be_visible()
        p.unroute('**/frames/*/rendered?*');d.locator('[data-retry]').click();expect(d.locator('[data-status]')).to_contain_text('Rendered',timeout=25000)
        p.evaluate('selectedUid=null;relatedUid=null;renderClinical()');expect(d).not_to_be_visible();self.assertIsNone(d.locator('img').get_attribute('src'))
        p.evaluate("()=>{const c=new BroadcastChannel('kin-session');c.postMessage({type:'session-ended'});c.close();}");expect(d).to_have_count(0)

    def test_preview_04_late_render_cannot_replace_reopened_study(self):
        f=self.multiple('SYNTHETIC-PREVIEW-'+uuid.uuid4().hex[:12],'current','20260801')
        related=self.ct(f.patient_id,'future','20260907')
        self.seed_report(f)
        p=self.login();self.select(p,f);self.thumbs(p)
        p.locator('#findings').fill('SYNTHETIC LATE PREVIEW UNSAVED')
        expect(p.locator('#findings')).to_have_value('SYNTHETIC LATE PREVIEW UNSAVED')
        d=self.preview(p);original=self.png(p)
        p.evaluate("""()=>{clearInterval(poll);const originalFetch=window.fetch;window.previewDelayed=false;
          window.fetch=async(...args)=>{const response=await originalFetch(...args);
            if(String(args[0]).includes('/rendered?')&&!window.previewDelayed){window.previewDelayed=true;
              await new Promise(resolve=>window.releasePreview=resolve);}return response;};} """)
        d.locator('[data-width]').fill('400');d.locator('[data-center]').fill('40');d.locator('[data-apply]').click()
        p.wait_for_function('Boolean(window.previewDelayed && window.releasePreview)')
        d.locator('[data-close]').click();self.related(p,related).click()
        expect(p.locator('#findings')).to_have_value('SYNTHETIC LATE PREVIEW UNSAVED')
        expect(d).not_to_be_visible();self.assertIsNone(d.locator('img').get_attribute('src'))
        p.locator('#related-return').click()
        self.thumbs(p);p.locator('.thumb-preview-open').first.click();expect(d).to_be_visible()
        expect(d.locator('img')).not_to_be_visible();p.evaluate('window.releasePreview()')
        expect(d.locator('[data-status]')).to_have_text('Rendered · Original Window',timeout=25000)
        np.testing.assert_array_equal(self.png(p),original)
        expect(p.locator('#findings')).to_have_value('SYNTHETIC LATE PREVIEW UNSAVED')
        expect(d.locator('[data-identity]')).to_contain_text(f.uid)
        d.locator('[data-close]').click()

    def test_preview_03_multiframe_and_color_preserve_original_frame_identity(self):
        f=self.ct('SYNTHETIC-PREVIEW-'+uuid.uuid4().hex[:12],'current','20260801')
        cine=CineE2E.series(self,f,3,'SYNTHETIC preview cine')
        ds=next(d for d in (dcmread(io.BytesIO(self.stack.orthanc_bytes(path))) for path in self.originals()) if str(d.StudyInstanceUID)==f.uid and d.Modality=='CT')
        ds.SeriesInstanceUID=generate_uid();ds.SOPInstanceUID=generate_uid();ds.SOPClassUID='1.2.840.10008.5.1.4.1.1.3.1';ds.Modality='US'
        ds.file_meta.MediaStorageSOPClassUID=ds.SOPClassUID;ds.file_meta.MediaStorageSOPInstanceUID=ds.SOPInstanceUID
        ds.SeriesDescription='SYNTHETIC preview RGB';ds.Rows=8;ds.Columns=8;ds.NumberOfFrames=2;ds.FrameTime=100
        ds.PhotometricInterpretation='RGB';ds.SamplesPerPixel=3;ds.PlanarConfiguration=0;ds.BitsAllocated=8;ds.BitsStored=8;ds.HighBit=7;ds.PixelRepresentation=0
        pixels=np.zeros((2,8,8,3),dtype=np.uint8);pixels[0,:,:,0]=255;pixels[1,:,:,1]=255;ds.PixelData=pixels.tobytes()
        stream=io.BytesIO();ds.save_as(stream,write_like_original=False);self.assertEqual(self.stack._orthanc_request('POST','/instances',stream.getvalue()).status,200)
        original=self.originals();p=self.login();self.select(p,f);self.thumbs(p,3)
        p.locator('.thumb-card').filter(has_text='SYNTHETIC preview cine').locator('.thumb-preview-open').click();d=p.locator('#worklist-image-preview')
        expect(d.locator('[data-status]')).to_contain_text('Rendered');expect(d.locator('[data-position]')).to_contain_text('Frame 1 / 3');first=self.png(p)
        d.locator('[data-next]').click();expect(d.locator('[data-status]')).to_contain_text('Rendered');expect(d.locator('[data-position]')).to_contain_text('Frame 2 / 3');self.assertFalse(np.array_equal(first,self.png(p)))
        expect(d.locator('[data-position]')).to_contain_text(cine['sops'][0]);d.locator('[data-close]').click()
        p.locator('.thumb-card').filter(has_text='SYNTHETIC preview RGB').locator('.thumb-preview-open').click();expect(d.locator('[data-status]')).to_contain_text('Rendered')
        expect(d.locator('[data-apply]')).to_be_disabled();expect(d.locator('[data-width]')).to_be_disabled();red=self.png(p);self.assertTrue(np.all(red==[255,0,0]))
        d.locator('[data-next]').click();expect(d.locator('[data-status]')).to_contain_text('Rendered');self.assertTrue(np.all(self.png(p)==[0,255,0]))
        d.locator('[data-close]').click();self.assertEqual(self.originals(),original)

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(WorklistImagePreviewE2E(name) for name in WorklistImagePreviewE2E.__dict__ if name.startswith('test_preview_'))

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
