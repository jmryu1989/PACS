# coding: utf-8
"""TEST-D06-SR-PROVENANCE: received source NUM values and native SR overlays."""
import io, unittest, uuid, json
from pathlib import Path
from unittest.mock import patch
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import ComprehensiveSRStorage, ExplicitVRLittleEndian, generate_uid
from pynetdicom import AE
import test_viewer_history as history
from test_measurement_readback import MeasurementReadbackE2E, expect


def code(value, meaning, scheme='DCM'):
    d=Dataset(); d.CodeValue=value; d.CodeMeaning=meaning; d.CodingSchemeDesignator=scheme
    return d


def node(kind, value, meaning):
    d=Dataset(); d.ValueType=kind; d.RelationshipType='CONTAINS'; d.ConceptNameCodeSequence=[code(value,meaning)]
    if kind=='CONTAINER': d.ContinuityOfContent='SEPARATE'
    return d


class SRProvenanceE2E(MeasurementReadbackE2E):
    def source(self,f,values=None,tracking=None,series_uid=None,instance_number=1,legacy=False):
        if not hasattr(self,'source_ct'): self.source_ct={}
        if f.uid not in self.source_ct:
            self.source_ct[f.uid]=pydicom.dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+self.stack.first_instance_id(f.uid)+'/file')))
        original=self.source_ct[f.uid]; self.assertEqual(original.Modality,'CT')
        sop,series=generate_uid(),series_uid or generate_uid()
        meta=FileMetaDataset(); meta.TransferSyntaxUID=ExplicitVRLittleEndian
        meta.MediaStorageSOPClassUID=ComprehensiveSRStorage; meta.MediaStorageSOPInstanceUID=sop; meta.ImplementationClassUID=generate_uid()
        d=FileDataset(None,{},file_meta=meta,preamble=b'\0'*128)
        for key in ['PatientName','PatientID','PatientBirthDate','PatientSex','InstitutionName','StudyInstanceUID','StudyDate','StudyTime','AccessionNumber','StudyID','StudyDescription']:
            setattr(d,key,getattr(original,key))
        d.SOPClassUID=ComprehensiveSRStorage; d.SOPInstanceUID=sop; d.SeriesInstanceUID=series
        d.SpecificCharacterSet='ISO_IR 192'; d.Modality='SR'; d.SeriesNumber=9; d.InstanceNumber=instance_number
        d.SeriesDescription='External SR source'; d.Manufacturer='SOURCE <img src=x onerror="window.srBad=1">'
        d.ContentDate='20260908'; d.ContentTime='090000'; d.CompletionFlag='COMPLETE'; d.VerificationFlag='UNVERIFIED'
        d.ValueType='CONTAINER'; d.ContinuityOfContent='SEPARATE'; d.ConceptNameCodeSequence=[code('126000','Imaging Measurement Report')]
        template=Dataset(); template.MappingResource='DCMR'; template.TemplateIdentifier='1500'; d.ContentTemplateSequence=[template]
        imaging=node('CONTAINER','126010','Imaging Measurements'); groups=[]
        for index,value in enumerate(values or ['123.456789','0']):
            group=node('CONTAINER','125007','Measurement Group')
            tracking_node=node('TEXT','112039','Tracking Identifier'); tracking_node.TextValue=('cornerstoneTools@^4.0.0' if legacy else 'Cornerstone3DTools@^0.1.0')+':Length'
            identity=node('UIDREF','112040','Tracking Unique Identifier'); identity.UID=tracking[index] if tracking else generate_uid()
            num=node('NUM','G-D7FE','Length'); measured=Dataset(); measured.NumericValue=value
            measured.MeasurementUnitsCodeSequence=[code('mm','millimeter','UCUM')]; num.MeasuredValueSequence=[measured]
            coords=node('SCOORD','111030','Image Region'); coords.RelationshipType='INFERRED FROM'; coords.GraphicType='POLYLINE'
            coords.GraphicData=[20,20+index*20,40,30+index*20]
            image=node('IMAGE','111030','Image'); image.RelationshipType='SELECTED FROM'
            ref=Dataset(); ref.ReferencedSOPClassUID=original.SOPClassUID; ref.ReferencedSOPInstanceUID=original.SOPInstanceUID; ref.ReferencedFrameNumber=1
            image.ReferencedSOPSequence=[ref]; coords.ContentSequence=[image]; num.ContentSequence=[coords]
            group.ContentSequence=[tracking_node,identity,num]; groups.append(group)
        imaging.ContentSequence=groups; d.ContentSequence=[imaging]
        ae=AE(ae_title='HALLYM_CT'); ae.add_requested_context(ComprehensiveSRStorage,ExplicitVRLittleEndian)
        assoc=ae.associate('127.0.0.1',4242,ae_title='KINLAB'); self.assertTrue(assoc.is_established)
        try:self.assertEqual(assoc.send_c_store(d).Status,0)
        finally:assoc.release()
        return dict(study=f.uid,series=series,sop=sop,reference=str(original.SOPInstanceUID))

    def observed(self,f):
        hook=history.hook.replace('preRegistration({servicesManager})','preRegistration({servicesManager, extensionManager, commandsManager})').replace(
            'window.__d05c1.services=servicesManager.services;',
            'window.__d05c1.services=servicesManager.services; window.__d05c1.extensions=extensionManager; window.__d05c1.commands=commandsManager;')
        with patch.object(history,'hook',hook):w,p=self.open_viewer(f,observer=True)
        self.addCleanup(w.close); self.addCleanup(p.close)
        return p

    def open_sr(self,p,source):
        p.wait_for_function('series=>__d05c1.services.displaySetService.getActiveDisplaySets().some(d=>d.SeriesInstanceUID===series)',arg=source['series'])
        # Select the real display set through the same service used by the study
        # browser; rendering/loading remains the pinned native SR viewport.
        p.evaluate('''series=>{const s=__d05c1.services;window.sourceDS=s.displaySetService.getActiveDisplaySets().find(d=>d.SeriesInstanceUID===series);
            window.sourceBefore=JSON.stringify(sourceDS.instance.ContentSequence);
            s.viewportGridService.setDisplaySetsForViewport({viewportId:s.viewportGridService.getActiveViewportId(),displaySetInstanceUIDs:[sourceDS.displaySetInstanceUID]});}''',source['series'])
        p.wait_for_function('()=>sourceDS.isLoaded && cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName==="DICOMSRDisplay")')

    def test_01_source_values_are_read_only_and_distinct(self):
        f=self.specimen(); source=self.source(f); original=self.hashes(); before=self.state(f),self.versions(f)
        p=self.observed(f); self.open_sr(p,source)
        expect(p.locator('svg.svg-layer')).to_contain_text('외부 SR 원문')
        expect(p.locator('svg.svg-layer')).to_contain_text('123.456789 mm')
        expect(p.locator('svg.svg-layer')).to_contain_text('0 mm')
        panel=p.locator('#kin-sr-provenance'); expect(panel).to_be_visible()
        for value in [source['sop'],'SOURCE <img','UNVERIFIED','123.456789','0 mm']:
            expect(panel).to_contain_text(value)
        self.assertEqual(panel.locator('img,script').count(),0); self.assertIsNone(p.evaluate('window.srBad'))
        self.assertFalse(p.evaluate('()=>sourceDS.isRehydratable'))
        self.assertFalse(p.evaluate('()=>window.kinViewerHistoryHasUnsaved()'))
        self.assertEqual(p.locator('#kin-viewer-history section[data-kind=length]').count(),0)
        self.assertEqual(p.evaluate('()=>__d05c1.services.measurementService.getMeasurements().length'),0)
        self.assertEqual(p.evaluate('()=>JSON.stringify(sourceDS.instance.ContentSequence)'),p.evaluate('()=>sourceBefore'))
        self.assertEqual(self.saved(f),[]); self.assertEqual((self.state(f),self.versions(f)),before); self.assertEqual(self.hashes(),original)
        p.screenshot(path=str(Path(__file__).parent/'artifacts/SR-provenance.png'))

    def test_02_reused_tracking_id_and_local_measurement_stay_separate(self):
        f=self.specimen(); ids=[generate_uid(),generate_uid()]
        a=self.source(f,tracking=ids); b=self.source(f,values=['987.654321','0'],tracking=ids)
        original=self.hashes(); before=self.state(f),self.versions(f); p=self.observed(f)
        for source,value,other in [(a,'123.456789','987.654321'),(b,'987.654321','123.456789'),(a,'123.456789','987.654321')]:
            self.open_sr(p,source)
            try: expect(p.locator('svg.svg-layer')).to_contain_text(value)
            except Exception:
                print('SR SWITCH',json.dumps(p.evaluate('''()=>({wanted:sourceDS.SOPInstanceUID,sets:__d05c1.services.displaySetService.getActiveDisplaySets().filter(d=>d.Modality==='SR').map(d=>({sop:d.SOPInstanceUID,loaded:d.isLoaded,measurements:d.measurements})),annotations:cornerstoneTools.annotation.state.getAllAnnotations().map(a=>({uid:a.annotationUID,image:a.metadata.referencedImageId,tracking:a.data.TrackingUniqueIdentifier,labels:a.data.labels}))})'''),ensure_ascii=False),flush=True)
                raise
            expect(p.locator('svg.svg-layer')).not_to_contain_text(other)
            expect(p.locator('#kin-sr-provenance')).to_contain_text(source['sop'])
            self.assertEqual(p.evaluate('()=>JSON.stringify(sourceDS.instance.ContentSequence)'),p.evaluate('()=>sourceBefore'))
        self.assertEqual(p.evaluate('()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==="DICOMSRDisplay").length'),4)
        p.evaluate('''()=>{const s=__d05c1.services; const v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId());
            const camera=v.getCamera();v.setCamera({parallelScale:camera.parallelScale*.8});v.render();}''')
        expect(p.locator('svg.svg-layer')).to_contain_text('123.456789 mm')
        self.assertFalse(p.evaluate('()=>kinViewerHistoryHasUnsaved()'))
        p.get_by_role('button',name='CT D05C5 readback S:1 info-series 1',exact=True).dblclick()
        expect(p.locator('#kin-sr-provenance')).not_to_be_visible()
        row=self.draw_length(p); row.get_by_role('button',name='저장',exact=True).click(); expect(row).to_contain_text('저장 완료')
        self.assertEqual(len(self.saved(f)),1)
        self.assertNotEqual(self.saved(f)[0]['item']['baseline']['values'][0],123.456789)
        self.open_sr(p,b); expect(p.locator('svg.svg-layer')).to_contain_text('987.654321 mm')
        self.assertEqual(len(self.saved(f)),1)
        self.assertEqual((self.state(f),self.versions(f)),before); self.assertEqual(self.hashes(),original)

    def test_03_hydration_guard_and_session_cleanup(self):
        f=self.specimen(); source=self.source(f,legacy=True); p=self.observed(f); self.open_sr(p,source)
        expect(p.get_by_text('LOAD',exact=True)).to_have_count(0)
        result=p.evaluate('''()=>{
            let req;webpackChunk.push([["sr-provenance-test"],{},r=>req=r]);
            const original=JSON.stringify(sourceDS.instance.ContentSequence);
            try { req(22989).A({servicesManager:{services:__d05c1.services},extensionManager:__d05c1.extensions,appConfig:window.config},sourceDS.displaySetInstanceUID); }
            catch(e){return {error:e.message,unchanged:original===JSON.stringify(sourceDS.instance.ContentSequence),
                measurements:__d05c1.services.measurementService.getMeasurements().length,
                tools:cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>['Length','Angle','EllipticalROI'].includes(a.metadata.toolName)).length};}
        }''')
        self.assertIn('외부 SR 원문은 읽기 전용',result['error']); self.assertTrue(result['unchanged']); self.assertEqual(result['measurements'],0); self.assertEqual(result['tools'],0)
        self.assertEqual(self.saved(f),[])
        p.evaluate("()=>window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended',newValue:'test'}))")
        expect(p.locator('#kin-sr-provenance')).not_to_be_visible(); expect(p.locator('#kin-sr-provenance')).to_be_empty()
        expect(p.locator('svg.svg-layer')).not_to_contain_text('외부 SR 원문')
        self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>String(a.annotationUID).startsWith('kin-sr:')).length"),0)
        p.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.sr-provenance').onModeExit()")
        expect(p.locator('#kin-sr-provenance')).to_have_count(0)
        self.assertFalse(p.evaluate("()=>!!Object.getOwnPropertyDescriptor(sourceDS,'isRehydratable')?.get"))
        self.assertIsNone(p.evaluate("()=>__d05c1.services.customizationService.get('onBeforeSRHydration')?.value"))

    def test_04_same_series_uses_selected_document_and_delivered_numbers(self):
        f=self.specimen(); series=generate_uid(); ids=[generate_uid(),generate_uid(),generate_uid()]
        self.source(f,values=['7','8','9'],tracking=ids,series_uid=series)
        source=self.source(f,values=['1.50','1.0E2','1234567890.12345'],tracking=ids,series_uid=series,instance_number=2)
        original=self.hashes(); p=self.observed(f); self.open_sr(p,source)
        # Native groups a series into one display set and selects its newest
        # instance. This pinned stack delivers these DS values as strings; a
        # different stack may deliver numbers, so byte spelling is not promised.
        state=p.evaluate('series=>({sets:__d05c1.services.displaySetService.getActiveDisplaySets().filter(d=>d.SeriesInstanceUID===series).length,instances:sourceDS.instances.length,sop:sourceDS.instance.SOPInstanceUID})',series)
        self.assertEqual(state,dict(sets=1,instances=2,sop=source['sop']))
        for value in ['1.50 mm','1.0E2 mm','1234567890.12345 mm']:
            expect(p.locator('svg.svg-layer')).to_contain_text(value)
            expect(p.locator('#kin-sr-provenance')).to_contain_text(value)
        self.assertEqual(p.evaluate('()=>JSON.stringify(sourceDS.instance.ContentSequence)'),p.evaluate('()=>sourceBefore'))
        self.assertEqual(self.saved(f),[]); self.assertEqual(self.hashes(),original)

    def test_05_access_failure_clears_source_panel_and_overlays(self):
        f=self.specimen(); source=self.source(f); original=self.hashes(); p=self.observed(f); self.open_sr(p,source)
        expect(p.locator('svg.svg-layer')).to_contain_text('외부 SR 원문')
        # Explicit transport fault at the existing authenticated /me boundary.
        # The viewer history gate must notify source views, not just manual rows.
        p.route('**/api/me',lambda route:route.fulfill(status=401,body='ended'))
        p.evaluate("()=>window.dispatchEvent(new Event('focus'))")
        expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('로그인이 종료')
        expect(p.locator('#kin-sr-provenance')).to_be_empty()
        expect(p.locator('svg.svg-layer')).not_to_contain_text('외부 SR 원문')
        self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>String(a.annotationUID).startsWith('kin-sr:')).length"),0)
        self.assertEqual(self.saved(f),[]); self.assertEqual(self.hashes(),original)


if __name__=='__main__':
    unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(SRProvenanceE2E(n) for n in [
        'test_01_source_values_are_read_only_and_distinct',
        'test_02_reused_tracking_id_and_local_measurement_stay_separate',
        'test_03_hydration_guard_and_session_cleanup',
        'test_04_same_series_uses_selected_document_and_delivered_numbers',
        'test_05_access_failure_clears_source_panel_and_overlays',
    ])).wasSuccessful() or __import__('sys').exit(1)
