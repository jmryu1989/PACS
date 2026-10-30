"""D1887: REQ-PATIENTLESS-HELD -> RISK-UNIDENTIFIED-READING -> TEST-PATIENTLESS-SERVED.

Real served doctor/clinician/admin pages and image delivery with its PostgreSQL access record.
Only owned synthetic C-STORE studies are corrected/replaced; public sample originals are never rewritten.
Source correction is performed at the sending/archive boundary, not by a display overlay or a new queue.
"""
import json
import unittest
import uuid
from datetime import date

from playwright.sync_api import expect
from pydicom.uid import generate_uid
from test_held_source import HeldSourceE2E, quoted, public_ct_series, DEFAULT_SOURCE
from invariants_live import psql, ROOT
from document_session import document_request


class PatientlessHeldE2E(HeldSourceE2E):
    def clinician_page(self, owner):
        self.stack.create_test_identity('clinician', ['clinician'], owner)
        self.stack.token('clinician')
        context = self.browser.new_context(ignore_https_errors=True)
        self.contexts.append(context)
        page = context.new_page()
        page.goto(self.stack.proxy + '/')
        page.locator('#username').fill(self.stack.username('clinician'))
        page.locator('#password').fill(self.stack.passwords['clinician'])
        page.locator('#kc-login').click()
        page.wait_for_url('**/clinician.html')
        return page

    def test_patientless_hold_and_original_correction(self):
        run = uuid.uuid4().hex[:10].upper()
        device, unknown = 'KP' + run, 'SYNTHETIC PATIENTLESS ' + run
        missing, both, control = generate_uid(), generate_uid(), generate_uid()
        owner = self.owner()
        _, base = public_ct_series(DEFAULT_SOURCE, 1)[0]
        base.StudyDate = date.today().strftime('%Y%m%d')
        self.own_cleanup(owner, [missing, both, control], [device], ['UNUSED ' + run])
        self.send(base, missing, device, 'HALLYM', '')
        self.send(base, both, device, unknown, '   ')
        self.send(base, control, device, 'HALLYM', 'CONTROL-' + run)

        for path in ('/studies', '/studies?limit=100', '/studies?uids=' + ','.join([missing, both, control])):
            answer = self.stack.request('GET', path, 'doctor')
            self.assertEqual(answer.status, 200, answer.text)
            listed = {row['uid'] for row in answer.body['studies']}
            self.assertIn(control, listed)
            self.assertTrue({missing, both}.isdisjoint(listed))
        bootstrap = self.stack.request('GET', '/bootstrap', 'doctor')
        self.assertEqual(bootstrap.status, 200, bootstrap.text)
        self.assertNotIn(missing, bootstrap.body['states'])
        self.assertNotIn(both, bootstrap.body['states'])

        doctor = self.login('doctor')
        expect(doctor.locator(f'#rows tr[data-uid="{control}"]')).to_be_visible()
        for uid in (missing, both):
            expect(doctor.locator(f'#rows tr[data-uid="{uid}"]')).to_have_count(0)
        clinician = self.clinician_page(owner)
        expect(clinician.locator(f'#studies tr[data-uid="{control}"]')).to_be_visible()
        for uid in (missing, both):
            expect(clinician.locator(f'#studies tr[data-uid="{uid}"]')).to_have_count(0)

        admin = self.login('jmryu')
        expect(admin.locator('#m-held')).to_be_visible()
        admin.goto(self.stack.proxy + '/worklist/hpacs-lite/admin.html#held-sources')
        row = admin.locator('#held-rows tr', has_text=unknown)
        expect(row).to_contain_text('Patient Not Identified')
        held = self.stack.request('GET', '/admin/held-sources', 'jmryu')
        self.assertEqual(held.status, 200, held.text)
        groups = [group for group in held.body['groups']
                  if group['device'] == device and group['institutionText'] == unknown]
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]['reason'], 'patient_not_identified')
        self.assertEqual(groups[0]['count'], 1)
        row.get_by_role('button', name='Register Device').click()
        admin.locator('#held-form input[name=confirmation]').fill('SYNTHETIC source confirmed ' + run)
        admin.locator('#held-form button[type=submit]').click()
        expect(admin.locator('#held-message')).to_contain_text('1건')
        # Registering the institution does not invent a patient or make it a reading item.
        expect(row).to_contain_text('Patient Not Identified')
        expect(row.get_by_role('button', name='Register Device')).to_have_count(0)
        self.assertNotIn(both, self.listed('doctor'))

        objects = self.stack._orthanc_request('POST', '/tools/find',
            json.dumps({'Level': 'Instance', 'Query': {'StudyInstanceUID': missing}, 'Expand': True}).encode())
        self.assertEqual(objects.status, 200, objects.text)
        self.assertEqual(len(objects.body), 1)
        tags = self.stack._orthanc_request('GET', '/instances/' + objects.body[0]['ID'] + '/simplified-tags').body
        path = f"/dicom-web/studies/{missing}/series/{tags['SeriesInstanceUID']}/instances/{tags['SOPInstanceUID']}/frames/1"
        refused = document_request(doctor, 'GET', self.stack.proxy + path)
        self.assertEqual(refused.status, 404, 'An unidentified patient must not receive image provision')

        out = ROOT / 'tmp/patientless-served'
        out.mkdir(exist_ok=True)
        for name, page in [('doctor-held', doctor), ('clinician-held', clinician), ('held', admin)]:
            page.screenshot(path=str(out / (name + '.png')), full_page=True)

        # A corrected resend coexists with the blank resource until the archive administrator removes it.
        found = self.stack._orthanc_request('POST', '/tools/lookup', missing.encode()).body
        studies = [r['ID'] for r in found if r['Type'] == 'Study']
        self.assertEqual(len(studies), 1)
        current = self.stack._orthanc_request('GET', '/studies/' + studies[0]).body
        self.assertEqual(current['MainDicomTags']['StudyInstanceUID'], missing)
        self.assertEqual(current['PatientMainDicomTags'].get('PatientID', ''), '')
        corrected = 'CORRECTED-' + run
        self.send(base, missing, device, 'HALLYM', corrected)
        found = self.stack._orthanc_request('POST', '/tools/lookup', missing.encode()).body
        self.assertEqual(len([r for r in found if r['Type'] == 'Study']), 2)
        self.assertNotIn(missing, self.listed('doctor'))
        admin.get_by_role('button', name='Refresh Held Studies').click()
        expect(admin.locator('#held-rows tr', has_text='HALLYM')).to_contain_text('Patient Not Identified')
        self.assertEqual(self.stack._orthanc_request('DELETE', '/studies/' + studies[0]).status, 200)
        admin.get_by_role('button', name='Refresh Held Studies').click()
        expect(admin.locator('#held-rows tr', has_text='HALLYM')).to_have_count(0)
        expect(admin.locator('#held-rows tr', has_text=unknown)).to_contain_text('Patient Not Identified')
        doctor.reload()
        expect(doctor.locator(f'#rows tr[data-uid="{missing}"]')).to_be_visible()
        clinician.reload()
        expect(clinician.locator(f'#studies tr[data-uid="{missing}"]')).to_contain_text(corrected)

        objects = self.stack._orthanc_request('POST', '/tools/find',
            json.dumps({'Level': 'Instance', 'Query': {'StudyInstanceUID': missing}, 'Expand': True}).encode()).body
        tags = self.stack._orthanc_request('GET', '/instances/' + objects[0]['ID'] + '/simplified-tags').body
        path = f"/dicom-web/studies/{missing}/series/{tags['SeriesInstanceUID']}/instances/{tags['SOPInstanceUID']}/frames/1"
        image = document_request(doctor, 'GET', self.stack.proxy + path)
        self.assertEqual(image.status, 200)
        self.assertGreater(len(image.body()), 0)
        events = [json.loads(row) for row in psql(
            'SELECT e.payload FROM emr_access.access_entry e WHERE EXISTS '
            "(SELECT 1 FROM jsonb_array_elements(e.payload::jsonb->'targets') t "
            "WHERE t->>'kind'='image' AND t->'studyId'->>'value'=" + quoted([missing]) + ');')]
        prepared = [e for e in events if e['action'] == 'provide-prepared']
        self.assertTrue(prepared, 'Image bytes require the normal committed access record')
        for event in prepared:
            self.assertEqual(event['managingInstitution']['value'], owner)
            self.assertEqual(event['userId']['status'], 'known')
            for target in event['targets']:
                self.assertEqual(target['patientLinkSnapshot']['value']['patientId'], corrected)
        for name, page in [('doctor-corrected', doctor), ('clinician-corrected', clinician), ('held-after', admin)]:
            page.screenshot(path=str(out / (name + '.png')), full_page=True)
        (out / 'result.json').write_text(json.dumps({'study': missing, 'patient': corrected,
            'image_status': image.status, 'access_events': prepared}, ensure_ascii=False, indent=2))


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([PatientlessHeldE2E('test_patientless_hold_and_original_correction')])
