# coding: utf-8
"""TEST-MPR-PRINT: review-requested fractional CSS sizes and composited pixels."""
import unittest
from unittest.mock import patch
from test_volume_mpr_print import VolumeMprPrintE2E

class VolumeMprPrintExtraE2E(VolumeMprPrintE2E):
 def test_mpr_extra_18_fractional_css_width(self):
  a,p,v=self.starting();v.set_viewport_size({'width':1523,'height':970});v.wait_for_timeout(500);expected=self.native_pixels(v);self.assertTrue(any(x['width']%3 for x in expected));self.save_volume(v);create=self.browser.new_context
  with patch.object(self.browser,'new_context',side_effect=lambda **options:create(**dict(options,device_scale_factor=1.5,viewport={'width':1400,'height':950}))):fresh=self.login()
  self.launch(fresh,[a]);self.ready(fresh);paper=self.open_print(fresh);self.assertEqual(self.print_pixels(paper),expected)
 def test_mpr_extra_19_visible_marks_keep_image_pixels(self):
  a,p,v=self.starting();self.add_mark(v,point=(20,20,16));expected=self.native_pixels(v);self.save_volume(v);paper=self.open_print(v);actual=self.print_pixels(paper);self.assertEqual([x['pixel'] for x in actual],[x['pixel'] for x in expected])
  colors=paper.locator('.cell img').evaluate_all("""async images=>Promise.all(images.map(async img=>{await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const a=ctx.getImageData(0,0,c.width,c.height).data;let gold=0,gray=0;for(let i=0;i<a.length;i+=4){if(a[i]>a[i+1]+10&&a[i+1]>a[i+2]+50)gold++;if(a[i]===a[i+1]&&a[i+1]===a[i+2]&&a[i]>0)gray++;}return {gold,gray}}))""")
  for x in colors:self.assertGreater(x['gold'],5);self.assertGreater(x['gray'],1000)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeMprPrintExtraE2E(n) for n in loader.getTestCaseNames(VolumeMprPrintExtraE2E) if n.startswith('test_mpr_extra_'))
if __name__=='__main__':unittest.main(verbosity=2)
