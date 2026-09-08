# coding: utf-8
"""TEST-D04-MANUAL-SR: real downloadable DICOM, Orthanc storage and independent readback."""
import base64, copy, hashlib, io, json, math, sys, unittest, uuid, time, subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from pydicom import dcmread
import numpy as np
from test_sr_provenance import SRProvenanceE2E
from test_viewer_history import expect, base, literal
from viewer_api_test import ViewerAPI


def nums(ds):
    result = []
    for item in getattr(ds, 'ContentSequence', []):
        if item.ValueType == 'NUM':
            measured = item.MeasuredValueSequence[0]
            result.append((item.ConceptNameCodeSequence[0].CodeMeaning, float(measured.NumericValue), measured.MeasurementUnitsCodeSequence[0].CodeValue))
        result.extend(nums(item))
    return result


def imaging(ds):
    return next(item for item in ds.ContentSequence if item.ConceptNameCodeSequence[0].CodeValue == '126010')


class ManualSrE2E(SRProvenanceE2E):
    def download(self, p):
        try:
            with p.expect_download() as downloaded:
                p.get_by_role('button', name='SR 다운로드', exact=True).click()
        except Exception:
            print('SR DOWNLOAD FAILURE',p.locator('#kin-viewer-history').inner_text(),flush=True)
            p.screenshot(path=str(Path(__file__).parent/'artifacts/manual-sr-download-failure.png'))
            raise
        raw = downloaded.value.path().read_bytes()
        self.assertEqual(raw[128:132], b'DICM')
        return raw, dcmread(io.BytesIO(raw))

    def post(self, f, items, user='doctor', status=200, request_id=None):
        body = dict(requestId=request_id or str(uuid.uuid4()), items=items)
        r = self.stack.request('POST', '/studies/'+f.uid+'/manual-sr', user, body)
        self.assertEqual(r.status, status, r.text)
        return r, body

    def saved_report(self, f):
        rows = base.psql('SELECT id::text FROM "ManualSr" WHERE "studyUid"='+literal(f.uid)+' ORDER BY "createdAt"')
        self.assertTrue(rows)
        return rows[-1]

    def assert_originals(self, original):
        current = self.hashes()
        self.assertEqual({key: current[key] for key in original}, original)

    def store_api(self, f, report, status=200, user='doctor'):
        r = self.stack.request('POST', '/studies/'+f.uid+'/manual-sr/'+report['id']+'/store', user, {})
        self.assertEqual(r.status, status, r.text)
        return r

    def test_01_file_store_and_fresh_login(self):
        f = self.specimen(); original = self.hashes(); before = self.state(f), self.versions(f)
        p = self.observed(f); self.draw_length(p)
        raw, ds = self.download(p)
        self.assertEqual(ds.SOPClassUID, '1.2.840.10008.5.1.4.1.1.88.33')
        self.assertEqual(ds.file_meta.TransferSyntaxUID, '1.2.840.10008.1.2.1')
        self.assertEqual(ds.file_meta.MediaStorageSOPInstanceUID, ds.SOPInstanceUID)
        self.assertEqual(ds.StudyInstanceUID, f.uid); self.assertEqual(ds.VerificationFlag, 'UNVERIFIED')
        self.assertNotIn('TimezoneOffsetFromUTC',ds)
        self.assertEqual(str(ds.ContentSequence[2].PersonName), self.stack.actor('doctor'))
        points = p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.metadata.toolName==='Length').data.handles.points")
        self.assertAlmostEqual(nums(ds)[0][1], math.dist(*points), places=8)
        source = dcmread(io.BytesIO(self.stack.orthanc_bytes(next(iter(original)))))
        coords = imaging(ds).ContentSequence[0].ContentSequence[3].ContentSequence[0]
        expected = [n for point in points for n in [point[0]/float(source.PixelSpacing[1])+.5, point[1]/float(source.PixelSpacing[0])+.5]]
        np.testing.assert_allclose(coords.GraphicData, expected, rtol=1e-6, atol=1e-5)
        self.assertEqual(coords.ContentSequence[0].ReferencedSOPSequence[0].ReferencedSOPInstanceUID, source.SOPInstanceUID)
        self.assertNotIn('ReferencedFrameNumber',coords.ContentSequence[0].ReferencedSOPSequence[0])
        self.assertEqual([item.ConceptNameCodeSequence[0].CodeValue for item in ds.ContentSequence][-2:], ['111028','126010'])
        self.assertEqual(self.hashes(), original, 'download must not store a DICOM instance')
        # A repeated download uses the identical durable file and request.
        raw2, _ = self.download(p); self.assertEqual(raw2, raw)
        p.get_by_role('button', name='SR 저장', exact=True).click()
        expect(p.locator('#kin-viewer-history [role=status]')).to_contain_text('SR 저장 완료', timeout=30000)
        hits = self.stack._orthanc_request('POST', '/tools/lookup', str(ds.SOPInstanceUID).encode()).body
        self.assertEqual(len(hits), 1, hits)
        self.assertEqual(self.stack.orthanc_bytes('/instances/'+hits[0]['ID']+'/file'), raw)
        report_source = dict(series=str(ds.SeriesInstanceUID), sop=str(ds.SOPInstanceUID))
        self.open_sr(p, report_source)
        expect(p.locator('#kin-sr-provenance')).to_contain_text(str(ds.SOPInstanceUID))
        expect(p.locator('svg.svg-layer')).to_contain_text(str(imaging(ds).ContentSequence[0].ContentSequence[3].MeasuredValueSequence[0].NumericValue))
        p.close()
        fresh = self.observed(f)
        _, restored = self.download(fresh)
        self.assertAlmostEqual(nums(restored)[0][1], nums(ds)[0][1], places=8)
        self.open_sr(fresh, report_source)
        expect(fresh.locator('#kin-sr-provenance')).to_contain_text(str(ds.SOPInstanceUID))
        self.assertFalse(fresh.evaluate('()=>sourceDS.isRehydratable'))
        self.assertEqual((self.state(f), self.versions(f)), before); self.assert_originals(original)
        fresh.screenshot(path=str(Path(__file__).parent/'artifacts/manual-sr-readback.png'))

    def test_02_roi_and_angle_numbers(self):
        f = self.specimen(); original = self.hashes(); p = self.observed(f)
        self.draw_length(p);p.get_by_role('button',name='Yes',exact=True).click()
        for index, (tool, label) in enumerate([('Angle', '수동 각도'), ('EllipticalROI', '수동 ROI')]):
            p.get_by_role('button', name=label, exact=True).click()
            box=p.locator('.cornerstone-canvas').bounding_box()
            x,y=box['x']+box['width']*.4,box['y']+box['height']*(.50+index*.18)
            p.mouse.move(x,y);p.mouse.down();p.mouse.move(x+65,y+32,steps=10);p.mouse.up()
            if tool=='Angle':p.mouse.move(x+85,y-15,steps=8);p.mouse.click(x+85,y-15)
            try:
                p.wait_for_function('''tool=>{const v=cornerstone.getEnabledElements()[0].viewport;
                    const active=cornerstoneTools.ToolGroupManager.getToolGroupForViewport(v.id,v.renderingEngineId).getToolInstance(tool);
                    return !active.isDrawing && cornerstoneTools.annotation.state.getAllAnnotations().some(a=>a.metadata.toolName===tool &&
                    !a.invalidated && Object.keys(a.data.cachedStats).length);}''',arg=tool,timeout=7000)
            except Exception:
                print('DRAW',tool,p.evaluate('''()=>cornerstoneTools.annotation.state.getAllAnnotations().map(a=>({tool:a.metadata.toolName,points:a.data.handles?.points,stats:a.data.cachedStats,invalidated:a.invalidated}))'''),flush=True)
                p.screenshot(path=str(Path(__file__).parent/'artifacts/manual-sr-draw-failure.png'))
                raise
        raw, ds=self.download(p); numbers={name:(value,unit) for name,value,unit in nums(ds)}
        points=p.evaluate('''()=>Object.fromEntries(cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>['Angle','EllipticalROI'].includes(a.metadata.toolName)).map(a=>[a.metadata.toolName,a.data.handles.points]))''')
        first,vertex,last=np.array(points['Angle']);u,v=first-vertex,last-vertex
        angle=math.degrees(math.acos(np.dot(u,v)/np.linalg.norm(u)/np.linalg.norm(v)))
        self.assertAlmostEqual(numbers['Angle'][0],angle,places=8);self.assertEqual(numbers['Angle'][1],'deg')
        source=dcmread(io.BytesIO(self.stack.orthanc_bytes(next(iter(original)))))
        bottom,top,left,right=np.array(points['EllipticalROI']); center=(bottom+top+left+right)/4
        a,b=right-left,bottom-top;ra,rb=np.linalg.norm(a)/2,np.linalg.norm(b)/2
        yy,xx=np.mgrid[:int(source.Rows),:int(source.Columns)]
        world=np.stack([xx*float(source.PixelSpacing[1]),yy*float(source.PixelSpacing[0]),np.zeros_like(xx)],axis=-1)
        delta=world-center;mask=(delta@(a/np.linalg.norm(a))/ra)**2+(delta@(b/np.linalg.norm(b))/rb)**2<=1
        hu=source.pixel_array[mask].astype(float)*float(source.RescaleSlope)+float(source.RescaleIntercept)
        for name,value in [('Area',math.pi*ra*rb),('Mean CT attenuation',hu.mean()),('Minimum CT attenuation',hu.min()),('Maximum CT attenuation',hu.max()),('ROI pixel count',hu.size)]:
            self.assertAlmostEqual(numbers[name][0],value,places=7)
        self.assertEqual(numbers['Area'][1],'mm2');self.assertEqual(numbers['Mean CT attenuation'][1],"[hnsf'U]")
        report={'id':self.saved_report(f)};self.store_api(f,report)
        p.close();fresh=self.observed(f);self.open_sr(fresh,dict(series=str(ds.SeriesInstanceUID),sop=str(ds.SOPInstanceUID)))
        expect(fresh.locator('#kin-sr-provenance')).to_contain_text('Mean CT attenuation')
        self.assertEqual(fresh.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='DICOMSRDisplay').length"),3)
        self.assert_originals(original)

    def test_03_api_authority_conflict_and_recovery(self):
        f=self.specimen();original=self.hashes();before=self.state(f),self.versions(f);p=self.observed(f)
        row=self.draw_length(p);row.get_by_role('button',name='저장',exact=True).click();expect(row).to_contain_text('저장 완료')
        head=self.saved(f)[0];items=[dict(id=head['id'],revision=head['revision'])]
        for user in ['tech','doctor2','kdoctor']:
            self.post(f,items,user=user,status=403)
        self.post(f,[dict(id=head['id'],revision=head['revision']+1)],status=409)
        self.post(f,items*2,status=400)
        r,command=self.post(f,items); report=r.body
        headers_response=p.request.post(self.stack.proxy+'/api/studies/'+f.uid+'/manual-sr', data=command, headers={'X-KIN-CSRF':'1'})
        self.assertEqual(headers_response.status,200)
        self.assertEqual(headers_response.headers.get('cache-control'),'no-store')
        again,_=self.post(f,items,request_id=command['requestId']);self.assertEqual(again.body,report)
        # Same request ID may not select another revision, even in this study.
        changed=copy.deepcopy(head['item']);changed.pop('hidden');changed.pop('sourceDigest');changed['label']='next'
        edit=self.stack.request('POST','/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions','doctor',dict(requestId=str(uuid.uuid4()),expectedRevision=head['revision'],action='edit',item=changed))
        self.assertEqual(edit.status,200,edit.text)
        self.post(f,[dict(id=head['id'],revision=2)],request_id=command['requestId'],status=409)
        self.store_api(f,report,status=409)
        report=self.post(f,[dict(id=head['id'],revision=2)])[0].body
        self.store_api(f,report,status=403,user='doctor2')
        # Store succeeds at Orthanc, then the audit transaction is made to fail.
        # The committed intent must survive and the retry must reuse its bytes.
        trigger='sr_fault_'+uuid.uuid4().hex[:12];target=literal(f.uid)
        base.psql(f'''CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target={target} AND NEW.action='manualSr.store' THEN RAISE EXCEPTION 'SYNTHETIC SR audit fault'; END IF; RETURN NEW; END $$;
            CREATE TRIGGER {trigger} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION {trigger}();''')
        try:self.store_api(f,report,status=500)
        finally:base.psql(f'DROP TRIGGER {trigger} ON "AuditLog"; DROP FUNCTION {trigger}();')
        self.assertEqual(base.psql('SELECT count(*) FROM "ManualSr" WHERE id='+literal(report['id'])+'::uuid AND "storedAt" IS NULL'),['1'])
        sop=report['dataset']['SOPInstanceUID']
        hits=self.stack._orthanc_request('POST','/tools/lookup',sop.encode()).body;self.assertEqual(len(hits),1)
        raw=base64.b64decode(report['dicom']);self.assertEqual(self.stack.orthanc_bytes('/instances/'+hits[0]['ID']+'/file'),raw)
        # The initiating measurement and current access can both change after
        # Orthanc accepts the immutable bytes. Background receipt recovery must
        # still work without a privileged user's retry or another upload.
        changed['label']='changed after SR upload'
        edit=self.stack.request('POST','/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions','doctor',dict(requestId=str(uuid.uuid4()),expectedRevision=2,action='edit',item=changed))
        self.assertEqual(edit.status,200,edit.text)
        base.psql('UPDATE "StudyState" SET rs=\'P\',"preDoc"=\'SYNTHETIC-other\',"preReviewer"=\'SYNTHETIC-reviewer\' WHERE uid='+target)
        try:
            base.psql('UPDATE "ManualSr" SET "nextCheckAt"=now() WHERE id='+literal(report['id'])+'::uuid')
            deadline=time.monotonic()+35
            while time.monotonic()<deadline:
                if base.psql('SELECT count(*) FROM "ManualSr" WHERE id='+literal(report['id'])+'::uuid AND "storedAt" IS NOT NULL')==['1']:break
                time.sleep(.5)
            else:self.fail('background SR receipt was not recovered')
            self.store_api(f,report,status=403)
        finally:base.psql('UPDATE "StudyState" SET rs=\'W\',"preDoc"=NULL,"preReviewer"=NULL WHERE uid='+target)
        stored=self.store_api(f,report).body;replay=self.store_api(f,report).body;self.assertEqual(stored,replay)
        self.assertEqual(self.stack.orthanc_bytes('/instances/'+hits[0]['ID']+'/file'),raw)
        self.assertEqual(base.psql('SELECT count(*) FROM "AuditLog" WHERE target='+target+" AND action='manualSr.store'"),['1'])
        # Server source identity and baseline numbers are independent gates.
        snapshot=copy.deepcopy(edit.body['item']);original_snapshot=json.dumps(snapshot)
        snapshot['sourceDigest']='0'*32
        base.psql('UPDATE "ViewerItem" SET snapshot='+literal(json.dumps(snapshot))+'::jsonb WHERE id='+literal(head['id'])+'::uuid')
        try:self.post(f,[dict(id=head['id'],revision=3)],status=409)
        finally:base.psql('UPDATE "ViewerItem" SET snapshot='+literal(original_snapshot)+'::jsonb WHERE id='+literal(head['id'])+'::uuid')
        snapshot['sourceDigest']=edit.body['item']['sourceDigest'];snapshot['baseline']['values'][0]+=10
        base.psql('UPDATE "ViewerItem" SET snapshot='+literal(json.dumps(snapshot))+'::jsonb WHERE id='+literal(head['id'])+'::uuid')
        try:self.post(f,[dict(id=head['id'],revision=3)],status=409)
        finally:base.psql('UPDATE "ViewerItem" SET snapshot='+literal(original_snapshot)+'::jsonb WHERE id='+literal(head['id'])+'::uuid')
        self.assertEqual((self.state(f),self.versions(f)),before);self.assert_originals(original)

    def test_04_open_series_replaces_document_and_overlay(self):
        f=self.specimen();p=self.observed(f);self.draw_length(p)
        raw,first=self.download(p);report={'id':self.saved_report(f)};self.store_api(f,report)
        p.close();p=self.observed(f);self.open_sr(p,dict(series=str(first.SeriesInstanceUID),sop=str(first.SOPInstanceUID)))
        head=self.saved(f)[0];item=copy.deepcopy(head['item']);item.pop('hidden');item.pop('sourceDigest')
        item['points'][1][0]+=4;item['baseline']['values'][0]=math.dist(*item['points'])
        edited=self.stack.request('POST','/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions','doctor',dict(requestId=str(uuid.uuid4()),expectedRevision=head['revision'],action='edit',item=item))
        self.assertEqual(edited.status,200,edited.text)
        new=self.post(f,[dict(id=head['id'],revision=edited.body['revision'])])[0].body
        stored=self.store_api(f,new).body
        self.assertEqual(stored['dataset']['SeriesInstanceUID'],str(first.SeriesInstanceUID))
        # Publish the actual server-stored document through the exact public
        # integration API used by the product's completed SR store command.
        p.evaluate('dataset=>__d05c1.services.displaySetService.makeDisplaySets([dataset],true)',stored['dataset'])
        expect(p.locator('#kin-sr-provenance')).to_contain_text(stored['dataset']['SOPInstanceUID'])
        expected=next(x for x in stored['dataset']['ContentSequence'] if x['ConceptNameCodeSequence']['CodeValue']=='126010')['ContentSequence'][0]['ContentSequence'][3]['MeasuredValueSequence']['NumericValue']
        expect(p.locator('svg.svg-layer')).to_contain_text(expected)
        self.assertFalse(p.evaluate('sop=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>String(a.annotationUID).startsWith("kin-sr:"+sop+":"))',str(first.SOPInstanceUID)))
        self.assertEqual(p.evaluate('()=>sourceDS.instance.SOPInstanceUID'),stored['dataset']['SOPInstanceUID'])
        # A late store/explicit selection of an older prepared document must
        # select that SOP, even though native sorting prefers the newer one.
        p.get_by_label('SR 문서 선택').select_option(str(first.SOPInstanceUID))
        expect(p.locator('#kin-sr-provenance')).to_contain_text(str(first.SOPInstanceUID))
        old_value=str(imaging(first).ContentSequence[0].ContentSequence[3].MeasuredValueSequence[0].NumericValue)
        expect(p.locator('svg.svg-layer')).to_contain_text(old_value)
        self.assertEqual(p.evaluate('()=>sourceDS.instance.SOPInstanceUID'),str(first.SOPInstanceUID))
        p.get_by_label('SR 문서 선택').select_option(stored['dataset']['SOPInstanceUID'])
        expect(p.locator('svg.svg-layer')).to_contain_text(expected)
        p.evaluate("()=>window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended',newValue:'test'}))")
        expect(p.locator('#kin-sr-provenance')).to_be_empty();expect(p.locator('svg.svg-layer')).not_to_contain_text(expected)

    def test_05_pending_access_recheck_and_hidden_selection(self):
        f=self.specimen();self.uid=f.uid;p=self.observed(f);self.draw_length(p);self.download(p)
        head=self.saved(f)[0];items=[dict(id=head['id'],revision=head['revision'])]
        report=self.post(f,items)[0].body;target=literal(f.uid)
        original=self.state(f);original_bytes=self.hashes()
        changed=f"rs='P',\"preDoc\"={literal(self.stack.actor('doctor2'))},\"preReviewer\"={literal(self.stack.actor('jmryu'))}"
        with ThreadPoolExecutor(max_workers=1) as pool:
            with ViewerAPI.parent_lock(self,changed):
                pending=pool.submit(self.stack.request,'POST','/studies/'+f.uid+'/manual-sr/'+report['id']+'/store','doctor',{})
                ViewerAPI.wait_blocked(self)
            self.assertEqual(pending.result().status,403)
        self.assertEqual(self.stack._orthanc_request('POST','/tools/lookup',report['dataset']['SOPInstanceUID'].encode()).body,[])
        base.psql('UPDATE "StudyState" SET rs=\'W\',"preDoc"=NULL,"preReviewer"=NULL WHERE uid='+target)
        # A hidden current revision cannot become a new SR or be stored from a
        # prepared older revision. This uses the product's ordinary hide API.
        item=copy.deepcopy(head['item']);item.pop('hidden');item.pop('sourceDigest')
        hidden=self.stack.request('POST','/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions','doctor',dict(requestId=str(uuid.uuid4()),expectedRevision=head['revision'],action='hide',reason='synthetic SR boundary',item=item))
        self.assertEqual(hidden.status,200,hidden.text)
        self.post(f,[dict(id=head['id'],revision=hidden.body['revision'])],status=409)
        self.store_api(f,report,status=409)
        # No browser-wide STOW permission was introduced.
        response=p.request.post(self.stack.proxy+'/dicom-web/studies/'+f.uid,data=b'not a DICOM',headers={'X-KIN-CSRF':'1','Content-Type':'application/dicom'})
        self.assertEqual(response.status,403)
        self.assertEqual(self.state(f),original);self.assertEqual(self.hashes(),original_bytes)

    def test_06_upload_lock_temporary_expiry_and_source_deadline(self):
        f=self.specimen();p=self.observed(f);self.draw_length(p);self.download(p)
        original=self.hashes();before=self.state(f),self.versions(f)
        head=self.saved(f)[0]
        institution=base.psql('SELECT "institutionId" FROM "StudyState" WHERE uid='+literal(f.uid))[0]
        payload=dict(uid=f.uid,items=[dict(id=head['id'],revision=head['revision'])],caller=dict(sub=self.stack.user_ids['doctor'],
            actor=self.stack.actor('doctor'),institution=institution,kind='member',roles=['radiologist']))
        script=(Path(__file__).parents[1]/'manual_sr_fault.cjs').read_text(encoding='utf-8')
        run=subprocess.run(['docker','exec','-i','kin-api','node'],input='const fixture = '+json.dumps(payload)+';\n'+script,
            text=True,encoding='utf-8',capture_output=True,timeout=65)
        self.assertEqual(run.returncode,0,run.stdout+'\n'+run.stderr);self.assertIn('MANUAL SR FAULT PASS',run.stdout)
        self.assertEqual((self.state(f),self.versions(f)),before);self.assert_originals(original)

    def test_07_late_native_load_arrival_and_mode_exit(self):
        f=self.specimen();p=self.observed(f);self.draw_length(p);_,first=self.download(p)
        self.store_api(f,dict(id=self.saved_report(f)));p.close();p=self.observed(f)
        self.open_sr(p,dict(series=str(first.SeriesInstanceUID)))
        head=self.saved(f)[0];item=copy.deepcopy(head['item']);item.pop('hidden');item.pop('sourceDigest');item['label']='late SR'
        edit=self.stack.request('POST','/studies/'+f.uid+'/viewer-items/'+head['id']+'/revisions','doctor',dict(requestId=str(uuid.uuid4()),expectedRevision=head['revision'],action='edit',item=item))
        self.assertEqual(edit.status,200,edit.text)
        report=self.post(f,[dict(id=head['id'],revision=edit.body['revision'])])[0].body
        stored=self.store_api(f,report).body;original=self.hashes()
        delay='''()=>{
          const data=__d05c1.extensions.getDataSources()[0], prior=data.retrieve.bulkDataURI;
          window.waitingSR=false;
          const pause=new Promise(resolve=>window.releaseSR=resolve);
          data.retrieve.bulkDataURI=async args=>{if(args.BulkDataURI!=='synthetic-sr-wait')return prior(args);
            window.waitingSR=true; await pause; return new ArrayBuffer(0);};
          // Test-only transport marker on the decoded array. Neither the source
          // DICOM bytes nor any content item/graphic is changed by this delay.
          const sequence=sourceDS.instance.ContentSequence;
          sequence.kinTestWait={BulkDataURI:'synthetic-sr-wait'};sourceDS.isLoaded=false;
          window.lateSR=sourceDS.load().catch(e=>{window.lateError=e.message;}).finally(()=>{
            delete sequence.kinTestWait;data.retrieve.bulkDataURI=prior;window.lateDone=true;});
        }'''
        p.evaluate(delay);p.wait_for_function('()=>waitingSR')
        p.evaluate('dataset=>__d05c1.services.displaySetService.makeDisplaySets([dataset],true)',stored['dataset'])
        self.assertEqual(p.evaluate('()=>sourceDS.instance.SOPInstanceUID'),str(first.SOPInstanceUID))
        p.evaluate('()=>releaseSR()')
        p.wait_for_function('sop=>sourceDS.isLoaded && sourceDS.instance.SOPInstanceUID===sop',arg=stored['dataset']['SOPInstanceUID'])
        expect(p.locator('#kin-sr-provenance')).to_contain_text(stored['dataset']['SOPInstanceUID'])
        self.assertFalse(p.evaluate('sop=>cornerstoneTools.annotation.state.getAllAnnotations().some(a=>String(a.annotationUID).startsWith("kin-sr:"+sop+":"))',str(first.SOPInstanceUID)))
        p.evaluate('()=>{window.lateDone=false;}');p.evaluate(delay);p.wait_for_function('()=>waitingSR')
        p.evaluate("()=>window.config.extensions.find(e=>e.id==='kin.sr-provenance').onModeExit()")
        p.evaluate('()=>releaseSR()');p.wait_for_function('()=>lateDone')
        expect(p.locator('#kin-sr-provenance')).to_have_count(0)
        self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>String(a.annotationUID).startsWith('kin-sr:')).length"),0)
        self.assertEqual(self.hashes(),original)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    names = [name for name in ManualSrE2E.__dict__ if name.startswith('test_')]
    if len(sys.argv)>1:
        assert all(name in names for name in sys.argv[1:])
        names=sys.argv[1:]
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(ManualSrE2E(name) for name in names))
    sys.exit(not result.wasSuccessful())
