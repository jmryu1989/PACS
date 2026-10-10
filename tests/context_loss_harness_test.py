"""TEST-HYGIENE-2 / 167: recovery oracle readiness and bounded SQL harness.

Exercise the E2E helper in an isolated browser with synthetic image events, never
LiveStack. This checks the harness; native OHIF recovery still needs the live class.
"""
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from playwright.sync_api import Error, sync_playwright

sys.path.insert(0, str(Path(__file__).parent / 'e2e'))
import test_context_loss as context_loss
import invariants_live as live


class ContextLossHarnessTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.addCleanup(self.page.close)
        self.oracle = context_loss.ContextLossE2E('test_context_02_embedded_2d_reload_keeps_report_and_session')
        self.page.evaluate('''() => {
          window.contextLossRendered=new WeakMap();window.enabled=[];
          window.cornerstone={getEnabledElements:()=>enabled,
            Enums:{Events:{IMAGE_RENDERED:'paint'},ViewportStatus:{RENDERED:'rendered'}},
            metaData:{get:(_,id)=>({StudyInstanceUID:id==='expected'?'study':'other',
              SeriesInstanceUID:'series',ImagePositionPatient:[0,0,40]})}};
          window.makeView=(imageId='expected',currentId=imageId)=>{
            const element=document.createElement('div'),canvas=document.createElement('canvas');
            canvas.width=canvas.height=64;document.body.append(element);element.append(canvas);
            return {element,type:'stack',csImage:{imageId,getPixelData:()=>new Uint16Array(4096).fill(1000)},
              viewportStatus:'rendered',getCurrentImageId:()=>currentId,getCanvas:()=>canvas,
              getProperties:()=>({voiRange:{lower:0,upper:2000}}),
              getRenderingEngine:()=>({offscreenMultiRenderWindow:{getOpenGLRenderWindow:()=>({getContext:()=>({isContextLost:()=>false})})}}),
              render(){queueMicrotask(()=>{
                canvas.getContext('2d').fillStyle='rgb(128,128,128)';canvas.getContext('2d').fillRect(0,0,64,64);
                contextLossRendered.set(element,{canvas,width:64,height:64,imageId});element.dispatchEvent(new Event('paint'));
              });}};
          };
        }''')

    def read_original(self, timeout=2000):
        return self.oracle.assert_original_stack(self.page, SimpleNamespace(uid='study'), timeout_ms=timeout)

    def test_delayed_loaded_image_and_expected_study(self):
        # Render-frame transitions cover the reload gap, an unloaded viewport,
        # another study, and a cached image which is not the current image.
        self.page.evaluate('''() => {
          const steps=[[],[{viewport:{type:'stack'}}],[{viewport:makeView('other')}],
            [{viewport:makeView('expected','other')}],[{viewport:makeView()}]];
          function next(){enabled=steps.shift();if(steps.length)requestAnimationFrame(next)}
          requestAnimationFrame(next);
        }''')
        state = self.read_original()
        self.assertEqual((state['study'], state['series'], state['raw'], state['pixel']), ('study', 'series', 1000, 128))

    def test_missing_or_wrong_image_fails_with_readiness_reason(self):
        for setup in ('[]', "[{viewport:makeView('other')}]", "[{viewport:makeView('expected','other')}]"):
            with self.subTest(setup=setup):
                self.page.evaluate('enabled=' + setup)
                with self.assertRaisesRegex(Error, 'loaded stack viewport with the expected study image; study=study'):
                    self.read_original(timeout=100)

    def test_loaded_image_without_fresh_render_still_fails(self):
        self.page.evaluate("enabled=[{viewport:makeView()}];enabled[0].viewport.render=()=>{}")
        with self.assertRaisesRegex(Error, 'fresh IMAGE_RENDERED receipt'):
            self.read_original(timeout=100)

    def test_wrong_voxel_is_not_accepted_after_readiness(self):
        self.page.evaluate("enabled=[{viewport:makeView()}];enabled[0].viewport.csImage.getPixelData=()=>new Uint16Array(4096)")
        with self.assertRaises(AssertionError):
            self.read_original()


class SqlHarnessTest(unittest.TestCase):
    def test_sql_retains_output_and_a_finite_load_tolerant_limit(self):
        with patch.object(live.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='one\n\ntwo\n')) as run:
            self.assertEqual(live.psql('SELECT synthetic'), ['one', 'two'])
        self.assertGreater(run.call_args.kwargs['timeout'], 30)
        self.assertLessEqual(run.call_args.kwargs['timeout'], 120)
        self.assertEqual(run.call_args.args[0][-1], 'SELECT synthetic')

    def test_timeout_and_sql_error_propagate_without_retry(self):
        for failure in (subprocess.TimeoutExpired('synthetic', 120), None):
            with self.subTest(timeout=bool(failure)):
                with patch.object(live.subprocess, 'run', side_effect=failure,
                                  return_value=SimpleNamespace(returncode=1, stdout='', stderr='SQL rejected')) as run:
                    with self.assertRaises(subprocess.TimeoutExpired if failure else RuntimeError):
                        live.psql('SELECT synthetic')
                run.assert_called_once()


if __name__ == '__main__':
    unittest.main(verbosity=2)
