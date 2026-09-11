# coding: utf-8
"""TEST-VOLUME-AVERAGE-AFFINE: average of constant CT remains unchanged."""
import unittest
from unittest.mock import patch
from test_volume_mpr_print import VolumeMprPrintE2E
import test_volume_projection as projection

class VolumeAverageAffineE2E(VolumeMprPrintE2E):
 def constant_average(self,signed):
  make=projection.phantom
  with patch.object(projection,'phantom',side_effect=lambda stack,intercept,constant:make(stack,intercept,True,signed=signed)):
   a,p,v=self.opened_projection(intercept=-100 if signed else 0,constant=True)
  if signed:v.evaluate('()=>{projectionVP.setProperties({voiRange:{lower:-1124,upper:-124}});projectionVP.render()}')
  v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');expected=v.evaluate('()=>projectionPixel()');self.assertIn(expected,[127,128])
  v.evaluate("""()=>{const v=projectionVP;v.getActors()[0].actor.getMapper().setViewSpecificProperties({OpenGL:{ShaderReplacements:[{shaderType:'Fragment',originalValue:'float jitter = 0.01 + 0.99*texture2D(jtexture, gl_FragCoord.xy/32.0).r;',replacementValue:'float jitter = 0.5;',replaceFirst:true,replaceAll:false}]}})}""")
  self.project(v,3,20);v.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');actual=v.evaluate('()=>projectionPixel()');print('CONSTANT_AVERAGE',{'signed':signed,'thin':expected,'average':actual},flush=True);self.assertEqual(actual,expected)
 def test_average_affine_01_negative_constant(self):self.constant_average(True)
 def test_average_affine_02_positive_constant(self):self.constant_average(False)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeAverageAffineE2E(n) for n in loader.getTestCaseNames(VolumeAverageAffineE2E) if n.startswith('test_average_affine_'))
if __name__=='__main__':unittest.main(verbosity=2)
