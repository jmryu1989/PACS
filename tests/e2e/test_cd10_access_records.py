"""CD-10: QIDO, metadata, Gateway STOW and local import against the synthetic served stack.

Run only through scripts/run-tests.py. Existing fixture helpers own all cleanup;
the access ledger remains append-only. No direct insertion of access events.
"""
import json
import os
import subprocess
import sys
import time
import unittest
import uuid
from pathlib import Path
from playwright.sync_api import expect

from test_worklist import WorklistE2E
from invariants_live import ROOT, LiveInvariantTests, psql, s9u4_cleanup, s9u4_dicom, s9u4_uid
from test_prior_selection import canvas_ready, synthetic_ct


class Cd10AccessRecordsE2E(WorklistE2E):
    def setUp(self):
        super().setUp()
        self.cd10_studies, self.cd10_operations = [], []
        self.addCleanup(self.cleanup_cd10)

    def cleanup_cd10(self):
        self.assertEqual(s9u4_cleanup(self.stack._orthanc_request, psql,
                                     self.cd10_studies, self.cd10_operations), [])

    def dicom_fixture(self):
        uid = s9u4_uid()
        self.cd10_studies.append(uid)
        patient = "CD10-" + uuid.uuid4().hex
        return uid, patient, s9u4_dicom(study=uid, series=uid + ".1", sop=uid + ".2", patient_id=patient)

    def events(self, uid, act):
        # Generated fixture UID; observe the actual persistent ledger, never insert access events for the test.
        target = json.dumps({"targets": [{"studyId": {"status": "known", "value": uid}}]})
        rows = psql("SELECT DISTINCT payload::jsonb FROM emr_access.access_entry "
                    f"WHERE statutory_act='{act}' AND payload::jsonb @> '{target}'::jsonb;")
        return [json.loads(row) for row in rows]

    @staticmethod
    def linked(event, patient):
        return any(target.get("sourcePatientId", {}).get("value") == patient or
                   target.get("patientLinkSnapshot", {}).get("value", {}).get("patientId") == patient
                   for target in event["targets"])

    def assert_runtime_lookup(self, event, uid):
        # Exercise the same restricted function used by the runtime, with real persisted events.
        quote = lambda value: "'" + value.replace("'", "''") + "'"
        actor = event["userId"]["value"]
        arguments = ",".join(quote(value) for value in
                             (actor["issuer"], actor["subject"], uid, event["occurredAt"]))
        rows = psql("SET ROLE kin_runtime; SELECT emr_access.access_seen(" + arguments + "); RESET ROLE;")
        self.assertIn("t", rows)
        rows = psql("SET ROLE kin_runtime; SELECT emr_access.access_seen(" + arguments +
                    ", 'authref:another-session'); RESET ROLE;")
        self.assertIn("f", rows)

    def import_fixture(self):
        uid, patient, body = self.dicom_fixture()
        operation = str(uuid.uuid4())
        self.cd10_operations.append(operation)
        imported = self.stack.bearer_request("POST", "/dicom-import", self.stack.token("tech"), body,
            headers={"Content-Type": "application/dicom", "X-KIN-Operation-Id": operation,
                     "X-KIN-File-Index": "0"})
        self.assertEqual(imported.status, 200, imported.text)
        written = self.events(uid, "기재")
        self.assertTrue(any(self.linked(event, patient) and event["userId"]["value"]["subject"] ==
                            self.stack.user_ids["tech"] for event in written))
        return uid, patient

    def test_local_import_records_the_patient_and_importer(self):
        self.import_fixture()

    def test_legacy_import_recovery_preserves_missing_roles_through_audit(self):
        helper = LiveInvariantTests()
        helper.stack = self.stack
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/cd10-legacy-import'))
        folder.mkdir(parents=True, exist_ok=True)

        def evidence(name, value):
            (folder / (name + '.json')).write_text(
                json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
            print('CD10_LEGACY ' + name, flush=True)

        uid, patient = self.import_fixture()
        operation = self.cd10_operations[-1]
        original = helper.s9u4_operation(operation)
        facts = original['results'][0]['access']
        before = self.events(uid, '기재')
        self.assertEqual(len(before), 1)
        self.assertEqual(facts['actor']['subject'], self.stack.user_ids['tech'])
        self.assertEqual(facts['roles'], ['technician'])
        self.assertEqual(before[0]['rolesAtTime'], {'status': 'known', 'value': facts['roles']})
        evidence('new-import', before)

        # Reuse the stopped-process fixture, preserving its original owner and object.
        # The already-written modern control event stays append-only; compare event IDs
        # so it cannot masquerade as the subsequent legacy recovery result.
        entry = helper.s9u4_set_attempt(operation, 0, phase='unknown', transport='unknown',
            outcome='unconfirmed', code='IMPORT_UNCONFIRMED', leaseUntil='2000-01-01T00:00:00.000Z')
        helper.s9u4_hold(entry)
        psql(f"UPDATE \"ImportOperation\" SET results=results #- '{{0,access}}' WHERE id='{operation}';")
        legacy = helper.s9u4_operation(operation)
        self.assertNotIn('access', legacy['results'][0])
        self.assertEqual(legacy['results'][0]['outcome'], 'unconfirmed')
        self.assertEqual(legacy['results'][0]['attempts'][-1]['phase'], 'unknown')
        self.assertEqual((legacy['ownerIssuer'], legacy['ownerSubject']),
                         (original['ownerIssuer'], original['ownerSubject']))
        objects = helper.s9u4_sop_objects(entry['sopUid'])
        self.assertEqual(len(objects), 1)
        evidence('legacy-input-before-recovery', legacy)

        recovered = self.stack.request('POST', f'/admin/dicom-import/{operation}/files/0/recovery',
            'jmryu', {'basis': 'orthanc-restarted', 'checkedAt': helper.s9u4_db_now()})
        self.assertEqual((recovered.status, recovered.body.get('outcome')), (200, 'stored'), recovered.text)
        self.assertEqual(helper.s9u4_sop_objects(entry['sopUid']), objects)
        added = [row for row in self.events(uid, '기재') if row['eventId'] not in {r['eventId'] for r in before}]
        self.assertEqual(len(added), 1)
        event = added[0]
        missing = {'status': 'unresolved', 'reason': 'legacy-import-roles-not-stored'}
        self.assertEqual(event['rolesAtTime'], missing)
        self.assertEqual(event['userId'], {'status': 'known', 'value': facts['actor']})
        self.assertNotEqual(event['userId']['value']['subject'], self.stack.user_ids['jmryu'])
        self.assertEqual((event['formatVersion'], event['surface'], event['action'], event['result']),
                         (1, 'POST dicom-import', 'write', 'succeeded'))
        evidence('recovered-pg-event', event)

        # A different actor and read action must keep the actual current roles.
        page = self.login('doctor')
        response = page.context.request.get(self.stack.proxy + '/dicom-web/studies/' + uid + '/metadata',
            headers={'X-KIN-Session': page.evaluate('KinWorkContext.session()'), 'Accept': 'application/dicom+json'})
        self.assertEqual(response.status, 200, response.text())
        reads = [row for row in self.events(uid, '열람') if row['action'] == 'provide-prepared'
                 and row['userId']['value']['subject'] == self.stack.user_ids['doctor']]
        self.assertTrue(reads)
        for row in reads:
            self.assertEqual(row['rolesAtTime'], {'status': 'known', 'value': ['radiologist']})
            self.assertNotEqual(row['surface'], event['surface'])
        evidence('other-path-read', reads)

        issuer, institution = original['ownerIssuer'], original['institutionId']
        grant_id = 'cd10-legacy-' + str(uuid.uuid4())
        bootstrap = subprocess.run([sys.executable, str(ROOT / 'scripts/emr-compose.py'), 'sql', 'audit-grantor',
            '--institution', institution, '--issuer', issuer, '--subject', self.stack.user_ids['jmryu'],
            '--capacity', 'privacy-officer', '--basis-document', grant_id],
            capture_output=True, text=True, encoding='utf-8', check=True, timeout=30)
        # The installer's SQL includes psql meta-commands, so consume it on stdin.
        designation = subprocess.run(['docker', 'compose', 'exec', '-T', 'db', 'psql', '-X',
            '-U', 'kin', '-d', 'kin', '-v', 'ON_ERROR_STOP=1'], input=bootstrap.stdout,
            cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=120)
        self.assertEqual(designation.returncode, 0, designation.stdout + designation.stderr)
        grant_path = '/emr-audit/roster/' + grant_id
        grant = self.stack.request('POST', grant_path, 'jmryu', {'kind': 'granted',
            'subject': {'issuer': issuer, 'subject': self.stack.user_ids['doctor']},
            'scopes': ['investigate', 'export'], 'validFrom': event['occurredAt'], 'validUntil': None})
        self.assertEqual(grant.status, 200, grant.text)

        def revoke():
            result = self.stack.request('POST', grant_path, 'jmryu', {'kind': 'revoked', 'reason': '합성 시험 종료'})
            self.assertEqual(result.status, 200, result.text)
        self.addCleanup(revoke)

        page.goto(self.stack.proxy + '/worklist/hpacs-lite/audit.html')
        expect(page.get_by_role('button', name='Search', exact=True)).to_be_enabled()
        page.get_by_label('Patient ID', exact=True).fill(patient)
        page.get_by_label('Assigning Authority', exact=True).fill(institution)
        with page.expect_response(lambda r: r.url.endswith('/api/emr-audit/investigations')
                                  and r.request.method == 'POST') as queried:
            page.get_by_role('button', name='Search', exact=True).click()
        self.assertEqual(queried.value.status, 200)
        result = queried.value.json()
        evidence('audit-investigations', result)

        def same_event(result):
            # The viewing stream also includes changes; each stream preserves the same event.
            for key in ('changes', 'views'):
                rows = [row for row in result[key]['rows'] if row['eventId'] == event['eventId']]
                self.assertEqual(len(rows), 1, key)
                self.assertEqual(rows[0]['rolesAtTime'], missing)
                self.assertEqual(rows[0]['actor'], event['userId'])
        same_event(result)
        with page.expect_download() as downloaded, page.expect_response(
                lambda r: r.url.endswith('/api/emr-audit/exports') and r.request.method == 'POST') as exported:
            page.get_by_role('button', name='Export', exact=True).click()
        self.assertEqual(exported.value.status, 200)
        same_event(exported.value.json())
        downloaded.value.save_as(str(folder / 'audit-records.json'))
        saved = json.loads((folder / 'audit-records.json').read_text(encoding='utf-8'))
        self.assertEqual(saved, exported.value.json())
        same_event(saved)
        evidence('audit-exports', saved)

        row = page.get_by_role('table', name='Change History', exact=True).get_by_role('row').filter(has_text=event['eventId'])
        expect(row).to_be_visible()
        actor = row.get_by_role('cell').nth(1)
        shown = actor.inner_text()
        evidence('audit-screen', {'eventId': event['eventId'], 'actorCell': shown})
        row.screenshot(path=str(folder / 'legacy-audit-row.png'))
        for invented in ('technician', 'radiologist', 'admin'):
            self.assertNotIn(invented, shown)
        expect(actor).to_contain_text('unresolved: legacy-import-roles-not-stored')

    def check_metadata_read(self, first):
        page = self.login("doctor")
        context = page.context
        session = page.evaluate("KinWorkContext.session()")
        # Stop worklist background reads before creating a study whose first read must be this DICOMweb request.
        page.close()
        uid, patient = self.import_fixture()
        paths = {"qido": "/dicom-web/studies?StudyInstanceUID=" + uid,
                 "metadata": "/dicom-web/studies/" + uid + "/metadata"}
        self.assertEqual(self.events(uid, "열람"), [])
        root = None
        for kind in (first, "metadata" if first == "qido" else "qido", first):
            response = context.request.get(self.stack.proxy + paths[kind],
                headers={"X-KIN-Session": session, "Accept": "application/dicom+json"})
            self.assertEqual(response.status, 200, response.text())
            self.assertEqual(response.headers["content-type"], "application/dicom+json")
            self.assertEqual(int(response.headers["content-length"]), len(response.body()))
            self.assertTrue(any(row.get("00100020", {}).get("Value") == [patient] for row in response.json()))
            prepared = [event for event in self.events(uid, "열람") if event["action"] == "provide-prepared"]
            self.assertEqual(len(prepared), 1, kind)
            self.assertTrue(self.linked(prepared[0], patient))
            self.assert_runtime_lookup(prepared[0], uid)
            if root is not None:
                self.assertEqual(prepared[0]["eventId"], root)
            root = prepared[0]["eventId"]

    def test_qido_records_the_patient_and_reuses_the_session(self):
        self.check_metadata_read("qido")

    def test_metadata_records_the_patient_and_reuses_the_session(self):
        self.check_metadata_read("metadata")

    def test_worklist_read_is_reused_and_new_login_records_once(self):
        uid, patient = self.import_fixture()
        roots = lambda: [event for event in self.events(uid, "열람") if event["action"] == "provide-prepared"]
        previous = 0
        for login_number in range(2):
            page = self.login("doctor")
            page.locator(f'#rows tr[data-uid="{uid}"]').wait_for()
            self.assertIn(patient, page.locator(f'#rows tr[data-uid="{uid}"]').inner_text())
            session = page.evaluate("KinWorkContext.session()")
            before = roots()
            self.assertEqual(len(before), previous + 1, "each new login records the listed study once")
            for path in ("/dicom-web/studies?StudyInstanceUID=" + uid,
                         "/dicom-web/studies/" + uid + "/metadata"):
                response = page.context.request.get(self.stack.proxy + path,
                    headers={"X-KIN-Session": session, "Accept": "application/dicom+json"})
                self.assertEqual(response.status, 200, response.text())
                self.assertEqual(response.headers["content-type"], "application/dicom+json")
                self.assertEqual(int(response.headers["content-length"]), len(response.body()))
                self.assertEqual({event["eventId"] for event in roots()}, {event["eventId"] for event in before})
            previous = len(before)
            page.close()

    def test_gateway_stow_records_the_patient_and_sending_device(self):
        uid, patient, body = self.dicom_fixture()
        gateway = self.stack.service_token("gateway")
        announced = self.stack.bearer_request("POST", "/gateway/announce", gateway,
            {"studyUid": uid, "institutionNameTag": "HALLYM"})
        self.assertIn(announced.status, (200, 201), announced.text)
        boundary = "cd10-" + uuid.uuid4().hex
        multipart = ("--" + boundary + "\r\nContent-Type: application/dicom\r\n\r\n").encode() + body + (
            "\r\n--" + boundary + "--\r\n").encode()
        accepted = self.stack.bearer_request("POST", "/dicom-web/studies/" + uid, gateway, multipart,
            base=self.stack.proxy, headers={"Content-Type": "multipart/related; type=application/dicom; boundary=" + boundary,
                "Accept": "application/dicom+json", "X-Kin-Source-AE": "SYN_CT", "X-Kin-Gateway": "SYN_GATEWAY"})
        self.assertIn(accepted.status, (200, 202), accepted.text)
        written = self.events(uid, "기재")
        self.assertTrue(any(self.linked(event, patient) and
                            json.loads(event["userId"]["value"]["subject"])["sourceAE"] == "SYN_CT"
                            for event in written))

    def test_opening_latency(self):
        # Use the phantom paired with canvas_ready's contrast check; the CI seed's low-contrast ramp cannot satisfy it.
        fixture = synthetic_ct(self.stack, "CD10-" + uuid.uuid4().hex, "CD10", "20261102")
        page = self.login('doctor')
        self.select(page, fixture)
        page.reload()
        page.locator(f'#rows tr[data-uid="{fixture.uid}"]').wait_for()
        worklist_paint = page.evaluate("performance.getEntriesByName('first-contentful-paint')[0]?.startTime")
        self.select(page, fixture)
        start = time.perf_counter()
        with page.context.expect_page() as opened:
            page.locator('#m-filmbox').click()
        viewer = opened.value
        folder = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/cd10-latency'))
        folder.mkdir(parents=True, exist_ok=True)
        label = os.environ.get('CD10_LATENCY_LABEL', 'changed')
        try:
            canvas_ready(viewer, 1)
        except Exception:
            viewer.screenshot(path=str(folder / (label + '-viewer-failed.png')))
            raise
        rendered = (time.perf_counter() - start) * 1000
        viewer_paint = viewer.evaluate("performance.getEntriesByName('first-contentful-paint')[0]?.startTime")
        self.assertIsNotNone(worklist_paint)
        self.assertIsNotNone(viewer_paint)
        # Capture the active viewer before foregrounding the worklist; headless GPU compositing can omit a background canvas.
        viewer.bring_to_front()
        canvas_ready(viewer, 1)
        viewer.screenshot(path=str(folder / (label + '-viewer.png')))
        page.screenshot(path=str(folder / (label + '-worklist.png')))
        result = dict(label=label, worklist_first_contentful_paint_ms=worklist_paint,
                      viewer_first_contentful_paint_ms=viewer_paint, series_first_render_ms=rendered,
                      sample='one synthetic study, one opening; descriptive measurement without a threshold')
        (folder / (label + '.json')).write_text(json.dumps(result, indent=2), encoding='utf-8')
        print('CD10_LATENCY ' + json.dumps(result), flush=True)
        viewer.close()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(Cd10AccessRecordsE2E(name) for name in (
        "test_local_import_records_the_patient_and_importer",
        "test_legacy_import_recovery_preserves_missing_roles_through_audit",
        "test_gateway_stow_records_the_patient_and_sending_device",
        "test_qido_records_the_patient_and_reuses_the_session",
        "test_metadata_records_the_patient_and_reuses_the_session",
        "test_worklist_read_is_reused_and_new_login_records_once",
        "test_opening_latency"))
