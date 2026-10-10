# coding: utf-8
"""REQ-S8-CTX / D549 -> RISK-CTX-BLANK/WORK -> CTX-HOSTED.

Requires an explicitly authorized isolated synthetic LiveStack through run-tests.py.
Known voxels and source identity are the recovery oracle.
"""
import unittest
from playwright.sync_api import expect
import test_volume_mip as mip
from test_prior_selection import canvas_ready

LOSS = '''() => {
 const view=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);
 const gl=view.getRenderingEngine().offscreenMultiRenderWindow.getOpenGLRenderWindow().getContext();
 const extension=gl.getExtension('WEBGL_lose_context');if(!extension)throw Error('WEBGL_lose_context unavailable');
 extension.loseContext();return true;
}'''


class ContextLossE2E(mip.VolumeMipE2E):
    def login(self, *args, **kwargs):
        page = super().login(*args, **kwargs)
        # Observe each new viewer document before its first paint. A resize can
        # clear the canvas while Cornerstone still reports the old RENDERED state.
        page.context.add_init_script('''(() => {
          window.contextLossRendered = new WeakMap();
          document.addEventListener('CORNERSTONE_IMAGE_RENDERED', event => {
            const v=window.cornerstone?.getEnabledElements().map(e=>e.viewport).find(v=>v.element===event.target);
            if(v?.type!=='stack'||!v.csImage)return;
            const canvas=v.getCanvas();
            contextLossRendered.set(v.element,{canvas,width:canvas.width,height:canvas.height,imageId:v.csImage.imageId});
          },true);
        })()''')
        return page

    def recovery_ready(self, viewer):
        # Cache a function predicate: re-evaluating a bare expression on the next
        # animation frame is blocked by the viewer's CSP when it starts false.
        viewer.wait_for_function('() => !!window.kinViewerContextLoss && !!window.cornerstone && cornerstone.getEnabledElements().some(e=>e.viewport.type==="stack"&&e.viewport.csImage)', timeout=60000)
        canvas_ready(viewer, 1)

    def recover(self, viewer):
        expect(viewer.get_by_role('heading', name='Viewer Recovery').last).to_be_visible()
        # Recovery also replaces history state before reload. Wait for a new
        # document so that same-document navigation cannot admit the old stack.
        previous = viewer.evaluate('performance.timeOrigin')
        viewer.get_by_role('button', name='Reload Viewer', exact=True).last.click()
        viewer.wait_for_function('previous => performance.timeOrigin !== previous', arg=previous, timeout=60000)
        self.recovery_ready(viewer)

    def assert_original_stack(self, viewer, study, timeout_ms=60000):
        state = viewer.evaluate('''([studyUid,timeout]) => new Promise((resolve,reject) => {
          let v,event,previousReceipt,frame;
          let phase='loaded stack viewport with the expected study image';
          const stop=()=>{clearTimeout(timer);cancelAnimationFrame(frame);if(v)v.element.removeEventListener(event,sample)};
          const timer=setTimeout(()=>{stop();reject(Error('Original stack recovery timed out: '+phase+'; study='+studyUid))},timeout);
          function discover(){
            v=window.cornerstone?.getEnabledElements().map(e=>e.viewport).find(view=>{
              if(view.type!=='stack'||!view.csImage||view.csImage.imageId!==view.getCurrentImageId())return false;
              return cornerstone.metaData.get('instance',view.csImage.imageId)?.StudyInstanceUID===studyUid;
            });
            if(!v){frame=requestAnimationFrame(discover);return;}
            event=cornerstone.Enums.Events.IMAGE_RENDERED;
            previousReceipt=contextLossRendered.get(v.element);
            phase='fresh IMAGE_RENDERED receipt for the expected study image';
            v.element.addEventListener(event,sample);v.render();
          }
          function sample(){
            try{
              const image=v.csImage,canvas=v.getCanvas(),receipt=contextLossRendered.get(v.element);
              if(v.viewportStatus!==cornerstone.Enums.ViewportStatus.RENDERED||!image||image.imageId!==v.getCurrentImageId()
                  ||!receipt||receipt===previousReceipt||receipt.canvas!==canvas||receipt.imageId!==image.imageId
                  ||!canvas.width||!canvas.height||receipt.width!==canvas.width||receipt.height!==canvas.height)return;
              // Read in the same task as the matching render receipt so a resize
              // cannot clear the canvas between readiness and the pixel oracle.
              const m=cornerstone.metaData.get('instance',v.getCurrentImageId());
              if(m?.StudyInstanceUID!==studyUid)return;
              const state={study:m.StudyInstanceUID,series:m.SeriesInstanceUID,z:Number(m.ImagePositionPatient[2])/2.5,
                raw:image.getPixelData()[32*64+32],voi:v.getProperties().voiRange,
                pixel:canvas.getContext('2d').getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data[0],
                lost:v.getRenderingEngine().offscreenMultiRenderWindow.getOpenGLRenderWindow().getContext().isContextLost()};
              stop();resolve(state);
            }catch(error){stop();reject(error)}
          }
          // Even a same-size canvas reset invalidates the previous pixels.
          // Request a new paint and sample only its matching render receipt.
          discover();
        })''', [study.uid, timeout_ms])
        self.assertEqual(state['study'], study.uid)
        self.assertFalse(state['lost'])
        expected = mip.BASE + mip.Z[mip.band(round(state['z']), 33)]
        self.assertEqual(state['raw'], expected)
        self.near(state['pixel'], expected, (state['voi']['lower'], state['voi']['upper']), 'reloaded 2D known voxel')
        return state

    def test_context_01_mip_manual_reload_known_source_and_projection_pixels(self):
        study, parent, viewer, voi = self.opened_mip_study()
        original = self.originals()
        session = viewer.evaluate('KinViewerSessionBoundary.session()')
        series = viewer.evaluate("cornerstone.metaData.get('instance',cornerstone.cache.getVolume(projectionVP.getVolumeId()).imageIds[0]).SeriesInstanceUID")
        dialog = self.open_mip(viewer)
        before = self.final(viewer, 'MIP', 'Axial')
        self.near(before['pixels'][0], mip.expected_hu('MIP', 'Axial'), voi, 'before loss')
        viewer.evaluate(LOSS)
        expect(dialog).to_have_attribute('data-kin-mip-state', 'stopped')
        self.recover(viewer)
        source = self.assert_original_stack(viewer, study)
        self.assertEqual(viewer.evaluate('KinViewerSessionBoundary.session()'), session)
        self.ready(viewer)
        self.mpr(viewer); self.choose_volume(viewer, viewer, 0)
        viewer.evaluate('''([lower,upper])=>{for(const id of services.viewportGridService.getState().viewports.keys()){
          const v=services.cornerstoneViewportService.getCornerstoneViewport(id);v.setProperties({voiRange:{lower,upper},VOILUTFunction:'LINEAR',interpolationType:0,invert:false});v.render();}}''', list(voi))
        viewer.evaluate(mip.HELPERS)
        self.open_mip(viewer)
        after = self.final(viewer, 'MIP', 'Axial')
        self.near(after['pixels'][0], mip.expected_hu('MIP', 'Axial'), voi, 'after manual recovery')
        self.assertEqual(source['series'], series)
        self.assertEqual(self.originals(), original)

    def test_context_02_embedded_2d_reload_keeps_report_and_session(self):
        study = mip.mip_phantom(self.stack)
        self.seed_report(study)
        parent = self.login(); viewer = self.workspace(parent, study, count=1)
        # The embedded viewer keeps Tech Note in its parent worklist; the
        # standalone note button is not a readiness signal for this document.
        self.recovery_ready(viewer)
        parent.locator('#findings').fill('SYN retained report after viewer recovery')
        before = self.assert_original_stack(viewer, study)
        binding = viewer.evaluate('KinViewerSessionBoundary.session()')
        viewer.evaluate(LOSS); self.recover(viewer)
        after = self.assert_original_stack(viewer, study)
        self.assertEqual(before['series'], after['series'])
        self.assertEqual(viewer.evaluate('KinViewerSessionBoundary.session()'), binding)
        expect(parent.locator('#findings')).to_have_value('SYN retained report after viewer recovery')

    def held_batch(self, viewer, selector):
        viewer.evaluate('''selector=>{
          const encode=HTMLCanvasElement.prototype.toBlob;
          HTMLCanvasElement.prototype.toBlob=function(callback,...args){
            if(!this.closest(selector))return encode.call(this,callback,...args);
            HTMLCanvasElement.prototype.toBlob=encode;
            window.releaseContextBlob=()=>encode.call(this,callback,...args);
          };
        }''', selector)

    def test_context_03_mpr_batch_late_blob_does_not_commit(self):
        study, parent, viewer, voi = self.opened_mip_study()
        self.held_batch(viewer, '[data-kin-batch-render]')
        for label, value in [('Batch Start Offset', '0'), ('Batch Interval', '1'), ('Batch Number', '2')]:
            viewer.get_by_label(label, exact=True).fill(value)
        viewer.get_by_role('button', name='Make Batch', exact=True).click()
        viewer.wait_for_function('() => !!window.releaseContextBlob')
        viewer.evaluate(LOSS); viewer.evaluate('releaseContextBlob()')
        expect(viewer.locator('#kin-volume-batch [role=status]')).to_contain_text('취소')
        expect(viewer.locator('#kin-volume-batch .result')).to_be_hidden()
        self.recover(viewer); self.assert_original_stack(viewer, study)

    def test_context_04_mip_batch_late_blob_keeps_job_inputs(self):
        study, parent, viewer, voi = self.opened_mip_study()
        dialog = self.open_mip(viewer)
        dialog.get_by_label('MIP Job Title', exact=True).fill('SYN preserved title')
        self.held_batch(viewer, '[data-kin-mip-batch-render]')
        dialog.get_by_label('MIP Batch Number', exact=True).fill('2')
        dialog.get_by_role('button', name='Make MIP Batch', exact=True).click()
        viewer.wait_for_function('() => !!window.releaseContextBlob')
        viewer.evaluate(LOSS); viewer.evaluate('releaseContextBlob()')
        expect(dialog.locator('.kin-mip-batch-result')).to_be_hidden()
        expect(dialog.get_by_label('MIP Job Title', exact=True)).to_have_value('SYN preserved title')
        viewer.get_by_role('button', name='Reload Viewer', exact=True).last.click()
        expect(viewer.get_by_role('button', name='Discard Viewer Changes & Reload').last).to_be_visible()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ContextLossE2E(name) for name in loader.getTestCaseNames(ContextLossE2E)
                              if name in ContextLossE2E.__dict__ and name.startswith('test_context_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
