# coding: utf-8
"""Caution cleanup: real member import, pinned OHIF measurements and cine on synthetic modalities.
PR #253 review F3/F8; existing census C05 (member import), M02 (measurements), C06 (cine).
Large objects use the review's measured DBT dimensions, not an inflated Content-Length.
"""
import json, os, struct, subprocess, tempfile, time, unittest, uuid
from pathlib import Path
import numpy as np
import requests
from pydicom.dataset import FileDataset, FileMetaDataset, Dataset
from pydicom.uid import ExplicitVRLittleEndian
from playwright.sync_api import expect
from invariants_live import Fixture, s9u4_cleanup, psql, ROOT
from test_viewer_history import ViewerHistoryE2E
from test_prior_selection import canvas_ready
from viewer_tools import select_image_tool

class CautionImagingE2E(ViewerHistoryE2E):
    def make_object(self, folder, modality, rows, cols, frames, sop_class):
        uid = '2.25.' + str(uuid.uuid4().int)
        ds = FileDataset(None, {}, file_meta=FileMetaDataset(), preamble=b'\0'*128)
        ds.is_little_endian=True; ds.is_implicit_VR=False
        ds.file_meta.TransferSyntaxUID=ExplicitVRLittleEndian
        ds.SOPClassUID=sop_class; ds.SOPInstanceUID=uid+'.2'; ds.StudyInstanceUID=uid; ds.SeriesInstanceUID=uid+'.1'
        ds.file_meta.MediaStorageSOPClassUID=ds.SOPClassUID; ds.file_meta.MediaStorageSOPInstanceUID=ds.SOPInstanceUID
        ds.PatientID='CAUTION-'+uuid.uuid4().hex[:12]; ds.PatientName='CAUTION^SYNTHETIC'; ds.PatientBirthDate='19700101'; ds.PatientSex='F'
        ds.InstitutionName='HALLYM'; ds.Modality=modality;
        if modality=='MG': ds.ImageLaterality='L'; ds.ViewPosition='CC'; ds.PresentationIntentType='FOR PRESENTATION'
        ds.StudyDate=ds.SeriesDate='20261027'; ds.StudyTime='120000'
        ds.StudyDescription=ds.SeriesDescription='Caution '+modality; ds.SeriesNumber=1; ds.InstanceNumber=1
        ds.FrameOfReferenceUID=uid+'.3'; ds.ImageOrientationPatient=[1,0,0,0,1,0]; ds.ImagePositionPatient=[0,0,0]
        ds.Rows=rows; ds.Columns=cols; ds.PixelSpacing=[.1,.1]; ds.ImagerPixelSpacing=[.1,.1]
        ds.SamplesPerPixel=1; ds.PhotometricInterpretation='MONOCHROME2'; ds.BitsAllocated=16; ds.BitsStored=12; ds.HighBit=11; ds.PixelRepresentation=0
        ds.WindowCenter=1024; ds.WindowWidth=2048; ds.ImageType=['ORIGINAL','PRIMARY']; ds.RescaleSlope=1; ds.RescaleIntercept=0
        if frames>1: ds.NumberOfFrames=frames; ds.FrameTime=100
        if sop_class.endswith('.13.1.3'):
            shared=Dataset(); spacing=Dataset(); spacing.PixelSpacing=[.1,.1]; spacing.SliceThickness=1
            shared.PixelMeasuresSequence=[spacing]; orient=Dataset(); orient.ImageOrientationPatient=[1,0,0,0,1,0]; shared.PlaneOrientationSequence=[orient]
            ds.SharedFunctionalGroupsSequence=[shared]; groups=[]
            for i in range(frames):
                group=Dataset(); pos=Dataset(); pos.ImagePositionPatient=[0,0,i]; group.PlanePositionSequence=[pos]; groups.append(group)
            ds.PerFrameFunctionalGroupsSequence=groups
        path=folder/(uid+'.dcm'); ds.save_as(path,write_like_original=False)
        # Write one native frame at a time so fixture construction does not double the DBT in Python memory.
        frame=np.broadcast_to(np.arange(cols,dtype='<u2')%2048,(rows,cols)).copy(); frame[rows//3:rows//2,cols//3:cols//2]=3500
        block=frame.tobytes()
        with path.open('ab') as stream:
            stream.write(struct.pack('<HH2sHI',0x7fe0,0x10,b'OW',0,len(block)*frames))
            for _ in range(frames):stream.write(block)
        return ds,path

    def test_large_dbt_import_and_served_viewer(self):
        self.exercise([('MG',2457,1890,73,'1.2.840.10008.5.1.4.1.1.13.1.3'),
                       ('MG',2457,1890,113,'1.2.840.10008.5.1.4.1.1.13.1.3')])

    def test_native_modalities_measurements_and_cine(self):
        self.exercise([('MG',4096,4096,1,'1.2.840.10008.5.1.4.1.1.1.2'),
                       ('XA',512,512,12,'1.2.840.10008.5.1.4.1.1.12.1'),
                       ('DX',1024,1024,1,'1.2.840.10008.5.1.4.1.1.1.1'),
                       ('MR',512,512,1,'1.2.840.10008.5.1.4.1.1.4'),
                       ('US',512,512,8,'1.2.840.10008.5.1.4.1.1.3.1')])

    def select_series(self,p,modality):
        # MG hanging protocols can leave empty cells for missing contralateral views.
        # The reader explicitly selects one pane and drags this synthetic series into it.
        p.locator('[data-cy=Layout]').click()
        p.get_by_text('Common',exact=True).locator('..').locator(':scope > div').nth(1).locator(':scope > div').nth(0).click()
        thumb=p.locator('[draggable=true]').filter(has_text='Caution '+modality).first
        expect(thumb).to_be_visible(timeout=60000)
        thumb.drag_to(p.locator('[data-cy=viewport-grid] > div').first)
        canvas_ready(p,1);self.open_measurement_tools(p)

    def exercise(self, cases):
        output=Path(os.environ.get('KIN_HEAVY_ARTIFACTS',Path(__file__).parent/'artifacts'))/'caution-imaging';output.mkdir(parents=True,exist_ok=True)
        memory=(output/'container-memory.jsonl').open('w',encoding='utf-8')
        containers=subprocess.check_output(['docker','compose','ps','-q','api','orthanc','keycloak','db'],cwd=ROOT,text=True,timeout=10).split()
        self.assertEqual(len(containers),4)
        sampler=subprocess.Popen(['docker','stats','--format','{{json .}}',*containers],stdout=memory,stderr=subprocess.STDOUT)
        def stop_sampler():
            sampler.terminate();sampler.wait(timeout=10);memory.close()
        self.addCleanup(stop_sampler)
        evidence=[]
        with tempfile.TemporaryDirectory(prefix='caution-dicom-') as folder:
            for modality,rows,cols,frames,sop_class in cases:
                ds,path=self.make_object(Path(folder),modality,rows,cols,frames,sop_class)
                op=str(uuid.uuid4()); uid=str(ds.StudyInstanceUID)
                fixture=Fixture(uid,str(ds.PatientID),'한림병원','jmryu','CAUTION')
                self.stack.active[uid]=fixture
                self.addCleanup(lambda u=uid,o=op: self.assertEqual([],s9u4_cleanup(self.stack._orthanc_request,psql,[u],[o])))
                self.addCleanup(self.stack.cleanup_fixture,uid)
                start=time.monotonic()
                with path.open('rb') as body:
                    response=requests.post(self.stack.api+'/dicom-import',data=body,verify=False,timeout=180,
                        headers={'Authorization':'Bearer '+self.stack.token('tech'),'Content-Type':'application/dicom','X-KIN-Operation-Id':op,'X-KIN-File-Index':'0'})
                self.assertEqual(response.status_code,200,response.text[:1000]);self.assertEqual(response.json()['outcome'],'stored')
                record={'modality':modality,'frames':frames,'bytes':path.stat().st_size,'import_seconds':time.monotonic()-start,'outcome':response.json()['outcome']}
                path.unlink()
                self.assertEqual(self.stack.request('PATCH','/studies/'+uid,'jmryu',{'ss':'Verified'}).status,200)
                w=self.login('doctor');p=w.context.new_page();errors=[]
                p.on('pageerror',lambda error:errors.append(str(error)))
                try:
                    p.goto(self.stack.proxy+'/ohif/viewer?StudyInstanceUIDs='+uid)
                    self.select_series(p,modality)
                    expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('개 저장 항목')
                    record['rendered']=p.evaluate("()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());return {image:v.getCurrentImageId(),frames:v.getImageIds().length,cacheMax:cornerstone.cache.getMaxCacheSize(),cacheable:String(cornerstone.cache.isCacheable)}}")
                    p.evaluate('''()=>{
                        window.cautionTrace=[];
                        const status=document.querySelector('#kin-viewer-history [role=status]');
                        new MutationObserver(()=>cautionTrace.push({status:status.textContent})).observe(status,{childList:true,subtree:true,characterData:true});
                        const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
                        const group=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId);
                        for(const name of ['Length','Angle','EllipticalROI']){
                            const tool=group.getToolInstance(name),original=tool.addNewAnnotation;
                            tool.addNewAnnotation=function(...args){const result=original.apply(this,args);cautionTrace.push({tool:name,result:!!result,status:status.textContent,point:args[0]?.detail?.currentPoints?.world});return result};
                        }
                    }''')
                    if frames>1:
                        p.evaluate('''async()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());await v.setImageIdIndex(v.getImageIds().length-1)}''')
                        p.wait_for_function('()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());return v.getCurrentImageIdIndex()===v.getImageIds().length-1}',timeout=60000)
                        canvas_ready(p,1)
                        record['last_frame']=p.evaluate('()=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());return {index:v.getCurrentImageIdIndex(),image:v.getCurrentImageId()}}')
                    # The three measurement tools are exercised on native scalar DX/XA/MR/US and single-frame MG.
                    if frames<73:
                        for index,(kind,tool,label) in enumerate([('length','Length','Length'),('angle','Angle','Angle'),('ellipse','EllipticalROI','Ellipse ROI')]):
                            p.locator('#kin-viewer-history').get_by_role('button',name=label,exact=True).click()
                            box=p.locator('.cornerstone-canvas').bounding_box();x=box['x']+box['width']*(.55 if kind=='ellipse' else .35);y=box['y']+box['height']*(.25 if kind=='ellipse' else .3+.2*index)
                            record['gesture']={'tool':tool,'x':x,'y':y,'box':box,'target':p.evaluate('([x,y])=>document.elementFromPoint(x,y)?.outerHTML.slice(0,300)',[x,y])}
                            p.mouse.move(x,y);p.mouse.down();p.mouse.move(x+65,y+32,steps=10);p.mouse.up()
                            if kind=='angle':p.mouse.move(x+85,y-15,steps=8);p.mouse.click(x+85,y-15)
                            p.wait_for_function('''tool=>{const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());const t=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId).getToolInstance(tool);return !t.isDrawing&&cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName===tool&&!a.invalidated&&Object.keys(a.data.cachedStats).length)}''',arg=tool)
                            if index==0:p.get_by_role('button',name='Yes',exact=True).click()
                            row=p.locator('#kin-viewer-history section[data-kind='+kind+']').last
                            row.get_by_role('button',name='Save',exact=True).click();expect(row).to_contain_text('저장 완료',timeout=30000)
                        record['saved']=len(self.saved(fixture));self.assertEqual(record['saved'],3)
                        p.reload();self.select_series(p,modality)
                        p.locator('#kin-viewer-history section[data-kind=length]').first.get_by_role('button',name='Go to Image',exact=True).click()
                        p.wait_for_function('frame=>services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId()).getCurrentImageIdIndex()===frame-1',arg=frames,timeout=60000)
                        p.wait_for_function('()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>["Length","Angle","EllipticalROI"].includes(a.metadata.toolName)).length===3')
                    if modality in ('XA','US'):
                        record['cine_initial']=p.evaluate('()=>{const s=services.cineService.getState();return {enabled:s.isCineEnabled,playing:!!s.cines?.[services.viewportGridService.getActiveViewportId()]?.isPlaying}}')
                        if not p.locator('#kin-cine').is_visible():select_image_tool(p,'Cine')
                        expect(p.locator('#kin-cine')).to_be_visible()
                        if record['cine_initial']['playing']:p.locator('[data-cy="cine-player-play-pause"]').click()
                        p.evaluate('''()=>{window.cautionFrames=[];const v=services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());v.element.addEventListener(cornerstone.Enums.Events.STACK_NEW_IMAGE,()=>cautionFrames.push(v.getCurrentImageIdIndex()))}''')
                        p.locator('[data-cy="cine-player-play-pause"]').click()
                        p.wait_for_function('()=>new Set(cautionFrames).size>2',timeout=30000)
                        p.locator('[data-cy="cine-player-play-pause"]').click();record['cine_frames']=p.evaluate('()=>[...new Set(cautionFrames)]')
                    p.screenshot(path=str(output/(modality+'-'+str(frames)+'.png')))
                except Exception:
                    record['trace']=p.evaluate('()=>window.cautionTrace');record['annotations']=p.evaluate('()=>cornerstoneTools.annotation.state.getAllAnnotations().map(a=>({tool:a.metadata.toolName,invalidated:a.invalidated,stats:a.data.cachedStats,points:a.data.handles?.points}))');record['errors']=errors;record['screen']=p.locator('body').inner_text()[-4000:]
                    p.screenshot(path=str(output/(modality+'-'+str(frames)+'-failure.png')))
                    (output/'failure.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
                    raise
                finally:p.close();w.close()
                evidence.append(record);(output/'observations.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
                print('CAUTION',modality,frames,record['bytes'],round(record['import_seconds'],2),flush=True)

def load_tests(loader,tests,pattern):
    return unittest.TestSuite([CautionImagingE2E(name) for name in ('test_large_dbt_import_and_served_viewer','test_native_modalities_measurements_and_cine')])
if __name__=='__main__':unittest.main(verbosity=2)
