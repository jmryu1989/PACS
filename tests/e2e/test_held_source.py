"""D1882 held unknown source on the served stack (REQ-D1882-HELD -> RISK-UNKNOWN-SOURCE-MIX -> TEST-D1882-HELD-SERVED).

A study whose sending hospital is unknown - its InstitutionName matches no registered spelling and its calling AE no
registered device - is held: no member of any institution lists or opens it. The operator alert names the device, the
raw InstitutionName text, the arrival times and a count, and nothing about a patient or a study. An administrator
registers, for the own institution, a device or a spelling confirmed with the hospital, through the real admin page and
the API; the held studies attach to that institution, the attach is audited, and the institution's members then list
them. A-027: GET audit records each returned row to the study's current institution in the EMR ledger.

Synthetic only: two single-instance studies with run-unique UIDs, AE titles and InstitutionName texts. Cleanup deletes
exactly those Orthanc studies, their StudyState and AuditLog rows, the registration audit rows and restores the
institution's registration columns. The API keeps the run-unique registrations in its cache until it restarts; they
name values no other suite sends.
"""
import copy
import json
import re
import sys
import unittest
import uuid

from playwright.sync_api import expect
from pydicom.uid import generate_uid
from pynetdicom import AE

from test_worklist import WorklistE2E
from invariants_live import AUDIT_GUARD_OFF, AUDIT_GUARD_ON, ROOT, psql

sys.path.insert(0, str(ROOT / "scripts"))
from send_cstore import DEFAULT_SOURCE, public_ct_series  # noqa: E402


def quoted(values):
    for value in values:
        if not re.fullmatch(r"[A-Za-z0-9._ -]+", value):
            raise RuntimeError("Refusing an unexpected synthetic value in SQL")
    return ",".join("'" + value + "'" for value in values)


class HeldSourceE2E(WorklistE2E):
    def send(self, base, uid, ae_title, institution, patient):
        ds = copy.deepcopy(base)
        ds.StudyInstanceUID = uid
        ds.SeriesInstanceUID = generate_uid()
        ds.FrameOfReferenceUID = generate_uid()
        ds.SOPInstanceUID = generate_uid()
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        ds.PatientID = patient
        ds.PatientName = "SYNTHETIC^HELD^SOURCE"
        ds.InstitutionName = institution
        ds.StudyDescription = "SYNTHETIC held unknown source"
        ae = AE(ae_title=ae_title)
        ae.add_requested_context(str(ds.SOPClassUID), str(ds.file_meta.TransferSyntaxUID))
        association = ae.associate("127.0.0.1", 4242, ae_title="KINLAB")
        self.assertTrue(association.is_established)
        try:
            self.assertEqual(getattr(association.send_c_store(ds), "Status", None), 0)
        finally:
            association.release()

    def listed(self, actor):
        result = self.stack.request("GET", "/studies", actor)
        self.assertEqual(result.status, 200, result.text)
        return {row["uid"]: row for row in result.body["studies"]}

    def test_held_01_unknown_source_is_held_until_a_confirmed_registration_attaches_it(self):
        run = uuid.uuid4().hex[:10].upper()
        device, other = "KH" + run, "KN" + run          # AE titles: at most 16 characters
        unknown, spelling = "SYNTHETIC UNKNOWN " + run, "SYNTHETIC SPELLING " + run
        by_device, by_spelling = generate_uid(), generate_uid()
        patients = ["HELD-D-" + run, "HELD-S-" + run]
        me = self.stack.request("GET", "/me", "jmryu")
        self.assertEqual(me.status, 200, me.text)
        owner = me.body["institution"]
        self.assertEqual(self.stack.request("GET", "/me", "doctor").body["institution"], owner,
                         "this suite needs the admin and the radiologist in one institution")
        before = psql(f'SELECT "dicomNames" || chr(31) || "dicomAets" FROM "Institution" WHERE id={quoted([owner])};')
        self.assertEqual(len(before), 1)
        source, base = public_ct_series(DEFAULT_SOURCE, 1)[0]

        def cleanup():
            self.close_contexts()
            self.contexts = []
            for uid in (by_device, by_spelling):
                found = self.stack._orthanc_request("POST", "/tools/lookup", uid.encode())
                for item in found.body if found.status == 200 else []:
                    if item.get("Type") == "Study":
                        self.assertEqual(self.stack._orthanc_request("DELETE", "/studies/" + item["ID"]).status, 200)
            uids = quoted([by_device, by_spelling])
            psql('BEGIN; DELETE FROM "StudyState" WHERE uid IN (' + uids + '); ' + AUDIT_GUARD_OFF +
                 ' DELETE FROM "AuditLog" WHERE target IN (' + uids + ') OR (action LIKE \'institution.%.register\' AND detail::jsonb->>\'value\' IN (' +
                 quoted([device, spelling]) + ')); ' + AUDIT_GUARD_ON + ' COMMIT;')
            # Only this run's values leave the registration columns; whatever else they hold stays as it was.
            psql('UPDATE "Institution" SET "dicomNames"=array_to_string(array_remove(string_to_array("dicomNames", \',\'), ' +
                 quoted([spelling]) + '), \',\'), "dicomAets"=array_to_string(array_remove(string_to_array("dicomAets", \',\'), ' +
                 quoted([device]) + '), \',\') WHERE id=' + quoted([owner]) + ';')
            restored = psql(f'SELECT "dicomNames" || chr(31) || "dicomAets" FROM "Institution" WHERE id={quoted([owner])};')
            self.assertEqual(restored, before)
            self.assertEqual(psql('SELECT count(*) FROM "StudyState" WHERE uid IN (' + uids + ');'), ["0"])

        self.addCleanup(cleanup)
        self.send(base, by_device, device, unknown, patients[0])
        self.send(base, by_spelling, other, spelling, patients[1])

        # Held: no institution lists or opens them, the admin included.
        for actor in ("doctor", "kdoctor", "jmryu"):
            listed = self.listed(actor)
            self.assertNotIn(by_device, listed, actor)
            self.assertNotIn(by_spelling, listed, actor)
        for path in (f"/studies/{by_device}/report/versions", f"/audit?uid={by_device}"):
            self.assertEqual(self.stack.request("GET", path, "jmryu").status, 404, path)
        self.assertEqual(psql(f'SELECT count(*) FROM "StudyState" WHERE uid IN ({quoted([by_device, by_spelling])}) AND "institutionId" IS NULL;'), ["2"])

        # The operator alert: device, raw text, arrival times and a count; no UID or patient fact. Admin only.
        self.assertEqual(self.stack.request("GET", "/admin/held-sources", "doctor").status, 403)
        alert = self.stack.request("GET", "/admin/held-sources", "jmryu")
        self.assertEqual(alert.status, 200, alert.text)
        groups = {(g["device"], g["institutionText"]): g for g in alert.body["groups"]}
        self.assertEqual(groups[(device, unknown)]["count"], 1, alert.body)
        self.assertEqual(groups[(other, spelling)]["count"], 1, alert.body)
        text = json.dumps(alert.body)
        for fact in (by_device, by_spelling, *patients, "SYNTHETIC^HELD"):
            self.assertNotIn(fact, text)

        # The worklist tells the admin; the real admin page registers the device after the hospital confirmed it.
        page = self.login("jmryu")
        expect(page.locator("#m-held")).to_be_visible()
        expect(page.locator("#m-held")).to_contain_text("Held Studies")
        page.goto(self.stack.proxy + "/worklist/hpacs-lite/admin.html#held-sources")
        row = page.locator("#held-rows tr", has_text=device)
        expect(row).to_contain_text(unknown)
        row.get_by_role("button", name="Register Device").click()
        expect(page.locator("#held-dialog")).to_be_visible()
        expect(page.locator("#held-dialog-target")).to_contain_text(device)
        page.locator("#held-form input[name=confirmation]").fill("SYNTHETIC phone check " + run)
        page.locator("#held-form button[type=submit]").click()
        expect(page.locator("#held-message")).to_contain_text("1건")
        expect(page.locator("#held-rows tr", has_text=device)).to_have_count(0)

        doctor = self.listed("doctor")
        self.assertIn(by_device, doctor)
        self.assertNotIn(by_spelling, doctor)
        self.assertNotIn(by_device, self.listed("kdoctor"))

        # The spelling, through the API: the remaining held study attaches; a repeat changes nothing.
        registered = self.stack.request("POST", "/admin/institution-aliases", "jmryu",
                                        {"value": spelling, "confirmation": "SYNTHETIC mail " + run})
        self.assertIn(registered.status, (200, 201), registered.text)
        self.assertEqual([registered.body["institutionId"], registered.body["changed"], registered.body["attached"]], [owner, True, 1])
        again = self.stack.request("POST", "/admin/institution-aliases", "jmryu", {"value": spelling, "confirmation": "again"})
        self.assertEqual(again.body["changed"], False, again.text)
        self.assertEqual(self.stack.request("POST", "/admin/source-devices", "doctor",
                                            {"value": other, "confirmation": "SYNTHETIC"}).status, 403)
        self.assertIn(by_spelling, self.listed("doctor"))

        attach = psql('SELECT target || chr(31) || detail FROM "AuditLog" WHERE action=\'study.attach\' AND target IN (' +
                      quoted([by_device, by_spelling]) + ') ORDER BY target;')
        details = {line.split("\x1f")[0]: json.loads(line.split("\x1f")[1]) for line in attach}
        self.assertEqual(details[by_device], {"institutionId": owner, "via": "device", "aet": device})
        self.assertEqual(details[by_spelling], {"institutionId": owner, "via": "alias"})
        register = psql('SELECT detail FROM "AuditLog" WHERE action=\'institution.device.register\' AND detail::jsonb->>\'value\'=' + quoted([device]) + ';')
        self.assertEqual([json.loads(line)["institution"] for line in register], [owner])

        # A-027: GET audit records every returned row (here study.arrived, written before any institution) to the
        # study's current institution in the EMR ledger.
        audit = self.stack.request("GET", f"/audit?uid={by_device}", "jmryu")
        self.assertEqual(audit.status, 200, audit.text)
        ids = [str(row["id"]) for row in audit.body]
        self.assertIn("study.arrived", [row["action"] for row in audit.body])
        managing = psql("SELECT e.payload::jsonb->'managingInstitution'->>'value' FROM emr_access.access_entry e "
                        "JOIN emr_access.access_target t ON t.entry_id = e.entry_id WHERE t.target_kind = 'access-audit' "
                        f"AND e.payload::jsonb->>'surface' = 'GET audit' AND t.record_id IN ({quoted(ids)});")
        self.assertGreaterEqual(len(managing), len(ids))
        self.assertEqual(set(managing), {owner})


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(HeldSourceE2E(name) for name in loader.getTestCaseNames(HeldSourceE2E) if name.startswith("test_held_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
