"""FC-070 Query/Retrieve on the served stack with the synthetic peer PACS (docker-compose.qr-peer.yml).

A synthetic study (two instances, InstitutionName HALLYM) is put into the peer (AE KINPEER) by C-STORE. The hospital's
administrator registers the peer through the API (Members > DICOM Peers' route); a radiologist then opens the real
worklist's More > Query/Retrieve, searches the peer by patient ID, retrieves the study and sees it arrive: the row says
Arrived, and the worklist lists the study. Asserted beside the page: Orthanc was told the peer with no find, get or move
allowed back, the audit rows carry no patient value, and removing the peer removes Orthanc's modality.

Run (CI or a development stack, never a hospital):
  docker compose -f docker-compose.yml -f docker-compose.qr-peer.yml up -d qr-peer
  python tests/e2e/test_query_retrieve.py
Synthetic only: run-unique UID and patient ID. Cleanup deletes exactly that study from both archives, its StudyState
and audit rows, and the run's peer row with its audit rows.
"""
import base64
import copy
import json
import os
import re
import sys
import time
import unittest
import uuid
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from playwright.sync_api import expect
from pydicom.uid import generate_uid
from pynetdicom import AE

from test_worklist import WorklistE2E
from invariants_live import AUDIT_GUARD_OFF, AUDIT_GUARD_ON, ROOT, psql

sys.path.insert(0, str(ROOT / "scripts"))
from send_cstore import DEFAULT_SOURCE, public_ct_series  # noqa: E402

PEER_DICOM_PORT = int(os.environ.get("QR_PEER_DICOM_PORT", "4244"))
PEER_HTTP = "http://127.0.0.1:" + os.environ.get("QR_PEER_HTTP_PORT", "8044")
PEER_AUTH = "Basic " + base64.b64encode(("qrpeer:" + os.environ.get("QR_PEER_PASS", "synthetic-qr-peer")).encode()).decode()


def peer_rest(method, path, body=None):
    request = Request(PEER_HTTP + path, method=method, data=body, headers={"Authorization": PEER_AUTH})
    try:
        with urlopen(request, timeout=30) as response:
            text = response.read().decode()
            return response.status, json.loads(text) if text.strip() else None
    except HTTPError as error:
        return error.code, None


class QueryRetrieveE2E(WorklistE2E):
    def put_on_peer(self, uid, patient):
        ae = AE(ae_title="KINQRTEST")
        series = public_ct_series(DEFAULT_SOURCE, 2)
        series_uid = generate_uid()
        for _, base in series:
            ds = copy.deepcopy(base)
            ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.SOPInstanceUID = uid, series_uid, generate_uid()
            ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
            ds.PatientID, ds.PatientName = patient, "SYNTHETIC^QUERY^RETRIEVE"
            ds.InstitutionName, ds.AccessionNumber = "HALLYM", "QR" + patient[-8:]
            ds.StudyDescription = "SYNTHETIC query retrieve"
            ae.add_requested_context(str(ds.SOPClassUID), str(ds.file_meta.TransferSyntaxUID))
            association = ae.associate("127.0.0.1", PEER_DICOM_PORT, ae_title="KINPEER")
            self.assertTrue(association.is_established, "the synthetic peer (docker-compose.qr-peer.yml) is not up")
            try:
                self.assertEqual(getattr(association.send_c_store(ds), "Status", None), 0)
            finally:
                association.release()
        return len(series)

    def own_cleanup(self, uid, peer_ids):
        def cleanup():
            self.close_contexts()
            self.contexts = []
            for peer in list(peer_ids):
                self.stack.request("DELETE", "/admin/dicom-peers/" + peer, "jmryu")
            status, found = peer_rest("POST", "/tools/lookup", uid.encode())
            for item in found or []:
                if item.get("Type") == "Study":
                    peer_rest("DELETE", "/studies/" + item["ID"])
            found = self.stack._orthanc_request("POST", "/tools/lookup", uid.encode())
            for item in found.body if found.status == 200 else []:
                if item.get("Type") == "Study":
                    self.assertEqual(self.stack._orthanc_request("DELETE", "/studies/" + item["ID"]).status, 200)
            ids = [uid, *peer_ids]
            for value in ids:
                if not re.fullmatch(r"[0-9a-f.-]+", value):
                    raise RuntimeError("Refusing an unexpected synthetic value in SQL")
            listed = ",".join("'" + value + "'" for value in ids)
            psql(f'BEGIN; DELETE FROM "StudyState" WHERE uid=\'{uid}\'; DELETE FROM "DicomPeer" WHERE id::text IN ({listed}); '
                 f'{AUDIT_GUARD_OFF} DELETE FROM "AuditLog" WHERE target IN ({listed}); {AUDIT_GUARD_ON} COMMIT;')
            self.assertEqual(psql(f'SELECT count(*) FROM "StudyState" WHERE uid=\'{uid}\';'), ["0"])
        self.addCleanup(cleanup)

    def test_qr_01_search_retrieve_and_the_study_arrives_in_the_worklist(self):
        run = uuid.uuid4().hex[:10].upper()
        uid, patient = generate_uid(), "QR-" + run
        peers = []
        self.own_cleanup(uid, peers)
        instances = self.put_on_peer(uid, patient)
        # The administrator registers the peer: on the stack's network the peer is the qr-peer service's DICOM port.
        registered = self.stack.request("POST", "/admin/dicom-peers", "jmryu",
                                        {"name": "SYN QR Peer " + run, "aet": "KINPEER", "host": "qr-peer", "port": 4242})
        self.assertIn(registered.status, (200, 201), registered.text)
        peer = registered.body["peer"]["id"]
        peers.append(peer)
        # A radiologist: More > Query/Retrieve (after the existing More items), search by patient ID, retrieve.
        page = self.login("doctor")
        self.open_toolbar_group(page, "#query-retrieve-open")
        more = page.locator("#toolbar-more .toolbar-menu-panel > button")
        ids = more.evaluate_all("buttons => buttons.map(b => b.id)")
        self.assertEqual(ids[-1], "query-retrieve-open")
        self.assertLess(ids.index("worklist-alerts-open"), ids.index("query-retrieve-open"))
        page.locator("#query-retrieve-open").click()
        panel = page.locator("#query-retrieve")
        expect(panel).to_be_visible()
        expect(panel.locator("#qr-peer")).to_have_value(peer)
        panel.locator("#qr-peer").select_option(peer)
        panel.locator("#qr-patient-id").fill(patient)
        panel.locator("#qr-search").click()
        row = panel.locator(f'#qr-rows tr[data-uid="{uid}"]')
        expect(row).to_be_visible(timeout=30000)
        expect(row).to_contain_text(patient)
        row.locator(".qr-pick").check()
        panel.locator("#qr-retrieve").click()
        expect(row.locator(".qr-state")).to_have_text("Arrived", timeout=90000)
        # Arrived means the radiologist's own list opens it: the worklist lists the study now.
        page.locator('#filterrow [data-f="id"]').fill(patient)
        expect(page.locator(f'#rows tr[data-uid="{uid}"]')).to_be_visible(timeout=30000)
        counts = self.stack._orthanc_request("POST", "/tools/find", json.dumps({"Level": "Study", "Query": {"StudyInstanceUID": uid},
            "Expand": True, "RequestedTags": ["NumberOfStudyRelatedInstances"]}).encode())
        self.assertEqual([int(r["RequestedTags"]["NumberOfStudyRelatedInstances"]) for r in counts.body], [instances])
        # Orthanc was told the peer with nothing allowed back into this archive but echo and store.
        key = f"kin-{self.stack.request('GET', '/me', 'jmryu').body['institution']}-{peer}"
        modality = self.stack._orthanc_request("GET", "/modalities/" + key + "/configuration")
        self.assertEqual(modality.status, 200, modality.text)
        self.assertEqual({name: modality.body.get(name) for name in ("AET", "Host", "Port", "AllowFind", "AllowMove", "AllowGet", "AllowStore")},
                         {"AET": "KINPEER", "Host": "qr-peer", "Port": 4242, "AllowFind": False, "AllowMove": False, "AllowGet": False, "AllowStore": True})
        # The audit rows: criteria names and counts, never the patient ID or name.
        rows = psql(f'SELECT action || chr(31) || detail FROM "AuditLog" WHERE action LIKE \'query-retrieve.%\' AND (target=\'{peer}\' OR target=\'{uid}\');')
        self.assertEqual(sorted(r.split(chr(31))[0] for r in rows), ["query-retrieve.retrieve", "query-retrieve.search"])
        self.assertFalse(any(patient in r or "SYNTHETIC" in r for r in rows), rows)
        # Removing the peer removes Orthanc's modality.
        removed = self.stack.request("DELETE", "/admin/dicom-peers/" + peer, "jmryu")
        self.assertEqual(removed.status, 200, removed.text)
        self.assertEqual(self.stack._orthanc_request("GET", "/modalities/" + key + "/configuration").status, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
