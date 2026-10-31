# coding: utf-8
"""Every image-byte path of the served product, walked as one table (D1877, 의료법 제23조④).

The 열람 record of an image read is the study delivery of one member session: one provide-prepared access event, durable
before the first image byte, and one terminal event when the delivery ends after its idle gap
(api/src/image-delivery-record.ts). It is one record whichever route a read takes - the viewer's frames (E's image API
with the deployed asset catalog, the API's frame reader without it), the series strip's previews, the worklist
thumbnails, whole-study, series and object retrieval through the recorded relay or E, and the same API routes reached
under /api/. A HEAD sends no image byte and a description (QIDO, DICOMweb metadata, tags) carries none: neither opens a
delivery nor counts in one. Rounds 5 to 7 of #244 each closed one path while another kept a second recorder, counted a
HEAD or lost a contract (R244-GPT-FIX5-01, FIX6-01/02, FIX7-03). The original-download archive is an image-byte path
too, under its own download record (S9-U4b/D1489), not a viewing read.

TEST-IMAGE-PATHS-01, on the served stack it runs against (stock or catalog: the deployment's asset catalog setting says
which; each cell's location column is a label of the printed matrix, not an assertion on the proxy configuration):
  (b) each image path is the FIRST read of a fresh study delivery (its own synthetic study): while the ledger refuses
      that study's record (a synthetic trigger on the access ledger) its GET sends no image byte and leaves no entry;
      then its GET answers its image under exactly one provide-prepared entry for the member, recorded after the request
      left and before the response headers arrived (E names it). A path whose GET answers no image on this stack (E
      without the catalog, a refused frame list) leaves no entry either time;
  (c) descriptions - QIDO, DICOMweb metadata, tags, and E's metadata - as the first reads of a fresh study open nothing;
  (d) the original-download archive under its download contract: HEAD is refused with no supply and no record; the GET
      sends the archive only after its own durable provide-prepared entry, and opens no viewing delivery.
TEST-IMAGE-PATHS-02, cross-route joining on the same stack:
  (a) one session GETs every image cell of one study: the study has exactly one provide-prepared entry, and HEADs and
      descriptions of the study add none; after the idle gap one transfer-ended entry closes it;
  (b) HEAD alone: a HEAD of every image cell of a second study answers with no body and leaves no entry;
  (c) HEAD beside an unsuccessful GET: on a third study, GETs admitted then refused by the archive and successful HEADs
      of every image cell close as one transfer-aborted pair, never transfer-ended.

Synthetic studies only (test_image_route's D03A phantom series); cleaned through the local guard like the other suites.
The ledger refusal is a trigger this suite creates on the synthetic stack's own database and drops before it ends.
"""
from __future__ import annotations

import json
import ssl
import time
import unittest
import uuid
from dataclasses import dataclass
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

import test_worklist as base
from invariants_live import psql
from test_image_route import FRAME_ACCEPT, asset_catalog_deployed, ct_series, quoted

DICOM = 'multipart/related; type="application/dicom"'
FRAME = "/dicom-web/studies/{study}/series/{series}/instances/{sop}/frames/{frame}"
OBJECT = "/dicom-web/studies/{study}/series/{series}/instances/{sop}"
SERIES = "/dicom-web/studies/{study}/series/{series}"
# The shared recorder's idle gap (DEFAULT_IMAGE_DELIVERY_IDLE_MS, 120 s) and a margin for the close's own append.
IDLE_WAIT_SECONDS = 200

# The nginx location each cell is served from, as labels of the printed matrix (proxy/nginx.conf.template,
# proxy/15-kin-config.envsh); nothing asserts them against the rendered configuration.
L_E_FRAMES = "~ ^/dicom-web/studies/[0-9.]+/series/[0-9.]+/instances/[0-9.]+/frames/[0-9]+(,[0-9]+)*$"
L_FRAMES = "~ ^/dicom-web/studies/[0-9.]+/series/[0-9.]+/instances/[0-9.]+/frames/[0-9,]+$"
L_PREVIEW = "~ ^/instances/[0-9a-f-]+/preview$"
L_STUDY = "~ ^/dicom-web/studies/[0-9.]+$"
L_STUDY_READ = "@kin_study_image_read"
L_DESCRIPTIONS = ("~ ^/dicom-web/(studies|series|instances|studies/[0-9.]+/(series|instances|series/[0-9.]+/instances)"
                  "|studies/[0-9.]+(/series/[0-9.]+(/instances/[0-9.]+)?)?/metadata)$")
L_DICOMWEB = "/dicom-web/"
L_INSTANCES = "/instances/"
L_API = "/api/"
L_ARCHIVE = "~ ^/api/studies/[0-9.]+/original-downloads/[0-9a-f-]+/archive$"


@dataclass(frozen=True)
class Cell:
    """One image-byte path: what it is, the location(s) nginx serves it from (stock, catalog), the route behind it and
    the answer its GET gives on each stack (an image unless a status says otherwise)."""
    name: str
    path: str
    accept: str
    locations: tuple
    routes: tuple
    get_status: tuple = (200, 200)


E_TARGET = "/api/images/dicom-web?target="
IMAGE_CELLS = [
    Cell("viewer frame", FRAME, FRAME_ACCEPT, (L_FRAMES, L_E_FRAMES), ("frame reader", "E image API")),
    Cell("series strip preview", "/instances/{id}/preview", "image/png", (L_PREVIEW, L_PREVIEW), ("frame reader preview",) * 2),
    Cell("worklist thumbnail", "/instances/{id}/frames/0/rendered", "image/png", (L_INSTANCES,) * 2, ("recorded relay",) * 2),
    Cell("DICOMweb rendering", OBJECT + "/rendered", "image/png", (L_DICOMWEB,) * 2, ("recorded relay",) * 2),
    Cell("whole study", "/dicom-web/studies/{study}", DICOM, (L_STUDY + " -> " + L_STUDY_READ,) * 2, ("recorded relay",) * 2),
    Cell("series retrieve", SERIES, DICOM, (L_DICOMWEB,) * 2, ("recorded relay",) * 2),
    Cell("object retrieve", OBJECT, DICOM, (L_DICOMWEB,) * 2, ("recorded relay",) * 2),
    Cell("original object", "/instances/{id}/file", "*/*", (L_INSTANCES,) * 2, ("recorded relay",) * 2),
    Cell("frame reader under /api/", "/api" + FRAME, FRAME_ACCEPT, (L_API,) * 2, ("frame reader",) * 2),
    Cell("preview under /api/", "/api/instances/{id}/preview", "image/png", (L_API,) * 2, ("frame reader preview",) * 2),
    Cell("relay under /api/", "/api/image-relay/instances/{id}/file", "*/*", (L_API,) * 2, ("recorded relay",) * 2),
    # The frame reader's location also takes list spellings E's location does not (an empty element); the reader
    # refuses them before its gate, so with the catalog that location sends no frame at all.
    Cell("frame list with an empty element", FRAME.replace("{frame}", "1,"), FRAME_ACCEPT, (L_FRAMES,) * 2,
         ("frame reader, refused",) * 2, (400, 400)),
    # Without the asset catalog E builds no manifest: 503 before any source read or record (batch-2 B1).
    Cell("E frame", E_TARGET + "{q_frame}", FRAME_ACCEPT, (L_API,) * 2, ("E image API",) * 2, (503, 200)),
    Cell("E object", E_TARGET + "{q_object}", DICOM, (L_API,) * 2, ("E image API",) * 2, (503, 200)),
    Cell("E series retrieve", E_TARGET + "{q_series}", DICOM, (L_API,) * 2, ("E image API",) * 2, (503, 200)),
    Cell("E whole study", E_TARGET + "{q_study}", DICOM, (L_API,) * 2, ("E image API",) * 2, (503, 200)),
]
DESCRIPTION_CELLS = [
    Cell("study metadata", "/dicom-web/studies/{study}/metadata", "application/dicom+json", (L_DESCRIPTIONS,) * 2, ("authz -> Orthanc",) * 2),
    Cell("study query", "/dicom-web/studies?StudyInstanceUID={study}", "application/dicom+json", (L_DESCRIPTIONS,) * 2, ("authz -> Orthanc",) * 2),
    Cell("instance tags", "/instances/{id}/tags", "application/json", (L_INSTANCES,) * 2, ("recorded relay, description",) * 2),
]
# E's study metadata: a description E does not answer from its fixed source (no catalog: no manifest at all); refused,
# and never under a record.
E_METADATA = Cell("E study metadata", E_TARGET + "{q_metadata}", "application/dicom+json", (L_API,) * 2, ("E image API",) * 2)
# The failing GETs of TEST-IMAGE-PATHS-02 (c): admitted by their route (the study is readable), refused after admission.
FAILING_CELLS = [
    Cell("rendering of a frame past the object", "/instances/{id}/frames/99/rendered", "image/png", (L_INSTANCES,) * 2, ("recorded relay",) * 2),
    Cell("frame past the object", FRAME.replace("{frame}", "99"), FRAME_ACCEPT, (L_FRAMES, L_E_FRAMES), ("frame reader", "E image API")),
]
# The original-download archive: image bytes under the download's own record, exercised by (d).
ARCHIVE = Cell("original-download archive", "/api/studies/{study}/original-downloads/{operation}/archive", "*/*",
               (L_ARCHIVE,) * 2, ("download archive",) * 2)


def entries_of(record_id, *, image_only=False):
    """(event_id, recorded_at epoch seconds, payload) of the access entries whose targets name the record `record_id`."""
    quoted([record_id])
    target = " AND target_kind = 'image'" if image_only else ""
    rows = psql("SELECT e.event_id || E'\\t' || extract(epoch FROM e.recorded_at)::text || E'\\t' || e.payload "
                "FROM emr_access.access_entry e WHERE e.entry_id IN "
                f"(SELECT entry_id FROM emr_access.access_target WHERE record_id = '{record_id}'{target}) ORDER BY e.sequence;")
    return [(row.split("\t", 2)[0], float(row.split("\t", 2)[1]), json.loads(row.split("\t", 2)[2])) for row in rows]


# A synthetic ledger refusal: an entry naming a listed study cannot be written, as a database that refuses the append.
# Created on the synthetic stack's own database for (b) and dropped with its table after it.
REFUSAL_ON = ("CREATE TABLE public.kin_test_refused_study (uid text PRIMARY KEY); "
              "GRANT SELECT ON public.kin_test_refused_study TO PUBLIC; "
              "CREATE FUNCTION public.kin_test_refuse_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
              "IF EXISTS (SELECT 1 FROM public.kin_test_refused_study r WHERE strpos(NEW.payload::text, r.uid) > 0) "
              "THEN RAISE EXCEPTION 'SyntheticLedgerRefusal'; END IF; RETURN NEW; END $$; "
              "CREATE TRIGGER kin_test_refuse_entry BEFORE INSERT ON emr_access.access_entry FOR EACH ROW "
              "EXECUTE FUNCTION public.kin_test_refuse_entry();")
REFUSAL_OFF = ("DROP TRIGGER IF EXISTS kin_test_refuse_entry ON emr_access.access_entry; "
               "DROP FUNCTION IF EXISTS public.kin_test_refuse_entry(); DROP TABLE IF EXISTS public.kin_test_refused_study;")


class ImagePathsE2E(base.WorklistE2E):
    def fetch(self, path, method="GET", accept="*/*"):
        """(status, headers, body, seconds when the request left, seconds when the response headers had arrived)."""
        request = Request(self.stack.proxy + path, method=method, headers={
            "Accept": accept, "Authorization": "Bearer " + self.stack.token("doctor")})
        sent = time.time()
        try:
            with urlopen(request, timeout=120, context=ssl._create_unverified_context()) as response:
                headed = time.time()
                return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read(), sent, headed
        except HTTPError as error:
            return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read(), sent, time.time()

    def study(self, label):
        fixture, series, sops, _ = ct_series(self.stack, label, 2, 64)
        lookup = self.stack._orthanc_request("POST", "/tools/lookup", sops[0].encode("ascii")).body
        values = {"study": fixture.uid, "series": series, "sop": sops[0], "frame": "1",
                  "id": next(row["ID"] for row in lookup if row["Type"] == "Instance")}
        for name, template in (("q_frame", FRAME), ("q_object", OBJECT), ("q_series", SERIES),
                               ("q_study", "/dicom-web/studies/{study}"), ("q_metadata", "/dicom-web/studies/{study}/metadata")):
            values[name] = quote(template.format(**values), safe="")
        self.assertEqual([], self.member_entries(values["study"]), "a fresh study has no image delivery entry")
        return values

    def member_entries(self, uid, action=None):
        # A5 also records the fixture's administrator reading study metadata; these assertions cover image deliveries.
        rows = entries_of(uid, image_only=True)
        self.assertTrue(all(p["userId"]["value"]["subject"] == self.stack.user_ids["doctor"] for _, _, p in rows), rows)
        return [row for row in rows if action is None or row[2]["action"] == action]

    def mode(self):
        catalog = asset_catalog_deployed()
        print("IMAGE_PATHS " + json.dumps({"stack": "catalog" if catalog else "stock"}), flush=True)
        return 1 if catalog else 0

    def test_image_paths_01_each_image_path_opens_its_own_delivery_record_first(self):
        mode = self.mode()
        matrix = []

        # (b) each image path first, on its own study: refused by the ledger, then recorded before its headers.
        studies = [(cell, self.study("paths-first-%02d" % index)) for index, cell in enumerate(IMAGE_CELLS)]
        try:
            psql(REFUSAL_OFF)
            psql(REFUSAL_ON)
            for cell, values in studies:
                psql(f"INSERT INTO public.kin_test_refused_study VALUES ('{values['study']}');")
                with self.subTest(cell=cell.name, ledger="refusing"):
                    status, headers, body, _, _ = self.fetch(cell.path.format(**values), accept=cell.accept)
                    matrix.append({"cell": cell.name, "location": cell.locations[mode], "route": cell.routes[mode],
                                   "method": "GET", "ledger": "refusing", "status": status, "bytes": len(body)})
                    expected = cell.get_status[mode] if cell.get_status[mode] != 200 else 503
                    self.assertEqual(expected, status, body[:300])
                    self.assertIsNone(headers.get("x-kin-image-event"), "no record is named")
                    self.assertEqual([], self.member_entries(values["study"]), "no entry while the ledger refuses")
                psql(f"DELETE FROM public.kin_test_refused_study WHERE uid = '{values['study']}';")
        finally:
            psql(REFUSAL_OFF)
        for cell, values in studies:
            with self.subTest(cell=cell.name, ledger="recording"):
                status, headers, body, sent, headed = self.fetch(cell.path.format(**values), accept=cell.accept)
                matrix.append({"cell": cell.name, "location": cell.locations[mode], "route": cell.routes[mode],
                               "method": "GET", "ledger": "recording", "status": status, "bytes": len(body),
                               "e_record": headers.get("x-kin-image-event")})
                self.assertEqual(cell.get_status[mode], status, body[:300])
                provided = self.member_entries(values["study"], "provide-prepared")
                if status != 200:
                    self.assertEqual([], provided, "a GET that sends no image opens no delivery")
                    continue
                self.assertTrue(body, "an image answer carries its image")
                self.assertEqual(1, len(provided), "the path's first GET opens exactly one delivery")
                self.assertTrue(sent <= provided[0][1] <= headed,
                                f"{cell.name}: the record ({provided[0][1]}) is written after the request left ({sent}) and "
                                f"before the response headers arrived ({headed})")
                target = provided[0][2]["targets"][0]
                self.assertEqual((target["kind"], target["studyId"]["value"]), ("image", values["study"]))
                if headers.get("x-kin-image-event"):
                    self.assertEqual(provided[0][0], headers["x-kin-image-event"], "E's response names its record")

        # (c) descriptions as the first reads of a fresh study open nothing.
        described = self.study("paths-descriptions")
        for cell in DESCRIPTION_CELLS + [E_METADATA]:
            with self.subTest(cell=cell.name, method="GET first"):
                status, headers, body, _, _ = self.fetch(cell.path.format(**described), accept=cell.accept)
                matrix.append({"cell": cell.name, "location": cell.locations[mode], "route": cell.routes[mode],
                               "method": "GET", "status": status, "bytes": len(body)})
                if cell is E_METADATA:
                    self.assertGreaterEqual(status, 400, "E does not answer metadata from its fixed source")
                else:
                    self.assertEqual(200, status, body[:300])
                self.assertIsNone(headers.get("x-kin-image-event"))
                self.assertEqual([], self.member_entries(described["study"]), "a description opens no delivery")
                if cell.name == "instance tags":
                    # B2-GPT-03: the relayed tag dump is the member's 열람 of the study metadata, one record of its own.
                    relayed = [p for _, _, p in entries_of(described["study"]) if p["surface"] == "GET image-relay/*"]
                    self.assertEqual([(p["action"], p["targets"][0]["kind"], p["userId"]["value"]["subject"]) for p in relayed],
                                     [("provide-prepared", "study-metadata", self.stack.user_ids["doctor"])])

        # (d) the original-download archive: HEAD refused before any supply, GET after its own durable record.
        archived = self.study("paths-archive")
        operation = str(uuid.uuid4())
        prepared = self.stack.request("POST", f"/studies/{archived['study']}/original-downloads", "doctor", {"operationId": operation})
        self.assertEqual(200, prepared.status, prepared.body)
        before = entries_of(operation)
        self.assertTrue(before and all(p["formatVersion"] == 2 for _, _, p in before), "the preparation's own download record")
        path = ARCHIVE.path.format(operation=operation, **archived)
        status, headers, body, _, _ = self.fetch(path, "HEAD")
        matrix.append({"cell": ARCHIVE.name, "location": ARCHIVE.locations[mode], "route": ARCHIVE.routes[mode],
                       "method": "HEAD", "status": status, "bytes": len(body)})
        self.assertEqual((405, b""), (status, body), "a HEAD starts no supply")
        self.assertEqual(before, entries_of(operation), "and adds no record")
        status, headers, body, sent, headed = self.fetch(path)
        matrix.append({"cell": ARCHIVE.name, "location": ARCHIVE.locations[mode], "route": ARCHIVE.routes[mode],
                       "method": "GET", "status": status, "bytes": len(body)})
        self.assertEqual(200, status, body[:300])
        self.assertTrue(body.startswith(b"PK"), "the archive's bytes")
        opened = [row for row in entries_of(operation) if row not in before and row[2]["action"] == "provide-prepared"]
        self.assertEqual(1, len(opened), "the archive GET opens one download record")
        self.assertTrue(sent <= opened[0][1] <= headed,
                        f"the download record ({opened[0][1]}) is durable after the request left ({sent}) and before the "
                        f"archive's headers arrived ({headed})")
        self.assertEqual((2, "original-download"), (opened[0][2]["formatVersion"], opened[0][2]["branch"]))
        self.assertEqual([], self.member_entries(archived["study"]), "a download is not a viewing delivery")
        print("IMAGE_PATHS_FIRST " + json.dumps(matrix), flush=True)

    def test_image_paths_02_every_image_path_joins_the_one_study_delivery(self):
        mode = self.mode()
        a, b, c = self.study("paths-read"), self.study("paths-head"), self.study("paths-fail")

        # (a) one session reads every image cell of study a: one delivery whichever route a read takes.
        matrix = []
        for cell in IMAGE_CELLS:
            with self.subTest(cell=cell.name, method="GET"):
                status, headers, body, _, _ = self.fetch(cell.path.format(**a), accept=cell.accept)
                matrix.append({"cell": cell.name, "location": cell.locations[mode], "route": cell.routes[mode], "method": "GET",
                               "status": status, "bytes": len(body), "e_record": headers.get("x-kin-image-event")})
                self.assertEqual(cell.get_status[mode], status, body[:300])
                if status == 200:
                    self.assertTrue(body, "an image answer carries its image")
                provided = self.member_entries(a["study"], "provide-prepared")
                self.assertEqual(1, len(provided), "one provide-prepared entry for the session's reads of the study, whichever route")
                if headers.get("x-kin-image-event"):
                    self.assertEqual(provided[0][0], headers["x-kin-image-event"], "E's response names the shared record")
        opened = self.member_entries(a["study"], "provide-prepared")[0]
        print("IMAGE_PATHS_RECORD " + json.dumps({"surface": opened[2].get("surface"), "event": opened[0]}), flush=True)
        for cell in IMAGE_CELLS + DESCRIPTION_CELLS:
            for method in ("HEAD",) if cell in IMAGE_CELLS else ("GET", "HEAD"):
                with self.subTest(cell=cell.name, method=method):
                    status, headers, body, _, _ = self.fetch(cell.path.format(**a), method, cell.accept)
                    matrix.append({"cell": cell.name, "location": cell.locations[mode], "route": cell.routes[mode],
                                   "method": method, "status": status, "bytes": len(body)})
                    if method == "HEAD":
                        self.assertEqual(b"", body)
                        self.assertIsNone(headers.get("x-kin-image-event"), "a HEAD names no record")
                        if cell in IMAGE_CELLS:
                            self.assertEqual(cell.get_status[mode], status, "a HEAD answers as its GET does, without the body")
                    else:
                        self.assertEqual(200, status, body[:300])
                    self.assertEqual([opened[0]], [e for e, _, _ in self.member_entries(a["study"])],
                                     "a HEAD or a description adds no entry")

        # (b) HEAD alone on study b.
        for cell in IMAGE_CELLS:
            with self.subTest(cell=cell.name, method="HEAD alone"):
                status, headers, body, _, _ = self.fetch(cell.path.format(**b), "HEAD", cell.accept)
                self.assertEqual((cell.get_status[mode], b""), (status, body))
                self.assertEqual([], self.member_entries(b["study"]), "a HEAD opens no delivery")

        # (c) on study c: GETs admitted then refused, and successful HEADs of every image cell.
        for cell in FAILING_CELLS:
            status, _, body, _, _ = self.fetch(cell.path.format(**c), accept=cell.accept)
            matrix.append({"cell": cell.name, "location": cell.locations[mode], "route": cell.routes[mode], "method": "GET",
                           "status": status, "bytes": len(body)})
            self.assertGreaterEqual(status, 400, "a frame past the object is not an image")
        for cell in IMAGE_CELLS:
            status, _, body, _, _ = self.fetch(cell.path.format(**c), "HEAD", cell.accept)
            self.assertEqual((cell.get_status[mode], b""), (status, body))
        print("IMAGE_PATHS_MATRIX " + json.dumps(matrix), flush=True)

        # The deliveries end: a's pair ended after the idle gap, b has none, and every pair of c (the frame past E's
        # manifest ends its own at once with the forgotten manifest) is aborted - a HEAD never counts as served.
        deadline = time.monotonic() + IDLE_WAIT_SECONDS
        while time.monotonic() < deadline and not (len(self.member_entries(a["study"])) >= 2 and
                                                   len(self.member_entries(c["study"])) % 2 == 0 and
                                                   self.member_entries(c["study"])):
            time.sleep(2)
        entries = self.member_entries(a["study"])
        self.assertEqual(["provide-prepared", "transfer-ended"], [p["action"] for _, _, p in entries], "exactly one pair")
        self.assertEqual(("succeeded", entries[0][0]), (entries[1][2]["result"], entries[1][2]["relatedEventId"]))
        failed = self.member_entries(c["study"])
        prepared = [row for row in failed if row[2]["action"] == "provide-prepared"]
        closings = [row[2] for row in failed if row[2]["action"] != "provide-prepared"]
        self.assertTrue(prepared, "the refused reads were admitted under a record")
        self.assertEqual(sorted(e for e, _, _ in prepared), sorted(p["relatedEventId"] for p in closings), "every record closed once")
        self.assertEqual({("transfer-aborted", "aborted")}, {(p["action"], p["result"]) for p in closings}, "never transfer-ended")
        self.assertEqual([], self.member_entries(b["study"]), "HEADs alone left no pair after the idle gap either")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ImagePathsE2E(name) for name in loader.getTestCaseNames(ImagePathsE2E)
                              if name.startswith("test_image_paths_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
