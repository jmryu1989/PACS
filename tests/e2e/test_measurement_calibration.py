# coding: utf-8
"""D-MEASURE2 A5: observe natural pinned classic CT calibration, no event injection."""
import json, sys, unittest
from pathlib import Path
from test_measurement_panel import MeasurementPanelE2E, expect
from viewer_precision_support import canvas_ready

OBSERVER = '''(()=>{
  const objects=new WeakMap(); let serial=0;
  const key=o=>{if (!o || typeof o!=='object') return null; if(!objects.has(o))objects.set(o,++serial);return objects.get(o);};
  window.calibrationObservation={events:[],replacements:[],samples:0};
  document.addEventListener('CORNERSTONE_IMAGE_SPACING_CALIBRATED',e=>{
    calibrationObservation.events.push({image:e.detail?.imageId,scale:e.detail?.scale});
  },true);
  const seen=new Map();
  setInterval(()=>{
    const annotations=window.cornerstoneTools?.annotation.state.getAllAnnotations()||[];
    for(const a of annotations.filter(a=>['Length','Angle','EllipticalROI'].includes(a.metadata.toolName))){
      const pair=[key(a.data),key(a.data.cachedStats)], old=seen.get(a.annotationUID);
      if(old && old[0]===pair[0] && old[1]!==pair[1]) calibrationObservation.replacements.push({uid:a.annotationUID,old,pair});
      seen.set(a.annotationUID,pair);calibrationObservation.samples++;
    }
  },25);
})();'''


class MeasurementCalibrationE2E(MeasurementPanelE2E):
    def test_calibration_natural_ct_navigation_and_reopen(self):
        f = self.specimen(slices=3)
        w = self.login('doctor'); self.addCleanup(w.close)
        p = w.context.new_page(); self.addCleanup(p.close)
        p.add_init_script(OBSERVER)
        url = self.stack.proxy+'/ohif/viewer?StudyInstanceUIDs='+f.uid
        observations = []
        for opening in ['open', 'reopen']:
            p.goto(url); canvas_ready(p,1)
            expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목')
            row = self.draw_length(p)
            points=p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='Length').at(-1).data.handles.points")
            expect(p.locator('svg.svg-layer')).to_contain_text('mm')
            p.wait_for_function('()=>calibrationObservation.samples>5')
            # Real native stack navigation preserves the current unsaved mark.
            p.evaluate('''async()=>{const v=cornerstone.getEnabledElements()[0].viewport;
              const start=v.getCurrentImageIdIndex(); await v.setImageIdIndex((start+1)%v.getImageIds().length);await v.setImageIdIndex(start);}''')
            expect(p.locator('svg.svg-layer')).to_contain_text('mm')
            row.get_by_role('button',name='Save',exact=True).click()
            expect(row).to_contain_text('저장 완료')
            current = p.evaluate('()=>calibrationObservation')
            current['opening']=opening; observations.append(current)
            expect(p.locator('svg.svg-layer')).not_to_contain_text('재확인 필요')
            saved=next(h for h in self.saved(f) if h['id']==row.get_attribute('data-item-id'))
            self.assertEqual(saved['item']['points'],points, 'Natural cache replacement, if observed, must retain and save the current geometry')
        dest=Path(__file__).parent/'artifacts/measurement-ci'; dest.mkdir(parents=True,exist_ok=True)
        (dest/'calibration-observation.json').write_text(json.dumps(observations,ensure_ascii=False,indent=2),encoding='utf-8')
        print('A5 natural CT observation: '+json.dumps(observations,ensure_ascii=False))

    def test_calibration_native_cache_replacement_recovers_unsaved_measurement(self):
        f=self.specimen(); p=self.observed(f); row,panel=self.tracked(p)
        before=p.evaluate('()=>panelAnnotation.data.handles.points')
        # Separate robustness probe: explicitly invoke the pinned handler.
        # This is not evidence that navigation naturally replaced this cache.
        p.evaluate('''()=>{
          const v=cornerstone.getEnabledElements()[0].viewport;
          const tool=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId).getToolInstance('Length');
          calibrationOldData=panelAnnotation.data;calibrationOldStats=panelAnnotation.data.cachedStats;
          tool.onImageSpacingCalibrated({detail:{element:v.element,imageId:v.getCurrentImageId()}});
          if(panelAnnotation.data!==calibrationOldData || panelAnnotation.data.cachedStats===calibrationOldStats)throw Error('Pinned handler did not replace only the cache');
        }''')
        expect(panel).to_contain_text('mm'); expect(panel).not_to_contain_text('재확인 필요')
        p.wait_for_function('()=>panelAnnotation.data===calibrationOldData && !panelAnnotation.invalidated && panelCaptured[0].getReport().values[0]!=="재확인 필요"')
        row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('저장 완료')
        self.assertEqual(self.saved(f)[0]['item']['points'],before)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    suite=unittest.TestSuite(MeasurementCalibrationE2E(n) for n in unittest.defaultTestLoader.getTestCaseNames(MeasurementCalibrationE2E) if n.startswith('test_calibration_'))
    sys.exit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
