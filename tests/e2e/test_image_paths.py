# coding: utf-8
"""Every image-byte path of the served product, walked as one table (D1877, 의료법 제23조④).

The 열람 record of an image read is the study delivery of one member session: one provide-prepared access event, durable
before the first image byte, and one terminal event when the delivery ends after its idle gap
(api/src/image-delivery-record.ts). It is one record whichever route a read takes - the viewer's frames (E's image API
with the deployed asset catalog, the API's frame reader without it), the series strip's previews, the worklist
thumbnails, whole-study and object retrieval through the recorded relay, and the same API routes reached under /api/.
A HEAD sends no image byte and a description (QIDO, DICOMweb metadata, tags) carries none: neither opens a delivery nor
counts in one. Rounds 5 and 6 of #244 each closed one path while another kept a second recorder or counted a HEAD
(R244-GPT-FIX5-01, R244-GPT-FIX6-01/02). This suite walks the whole matrix on the served stack and refuses an nginx
location it has not classified, so a later path is either in the table or the suite fails.

TEST-IMAGE-PATHS-01, on the served stack it runs against (stock or catalog: the rendered proxy configuration says which):
  (a) every location of the rendered proxy configuration is classified: an image location names the cells that
      exercise it, any other says why it carries no image byte; a location the table does not know fails the suite;
  (b) one session GETs every image cell of one study: each answers its image, the first read's provide-prepared entry
      was recorded after its request left and before its response's headers arrived, and across all cells the study has
      exactly one provide-prepared entry, for that member; HEADs and descriptions of the study add none; after the idle
      gap one transfer-ended entry closes it - one pair for frames, previews, thumbnails, retrieves and relayed reads;
  (c) HEAD alone: a HEAD of every image cell of a second study answers with no body and leaves no entry, also after the
      idle gap;
  (d) HEAD beside an unsuccessful GET: on a third study, a rendering of a frame past the object (admitted, then refused
      by the archive) and a frame past the object, with successful HEADs of every image cell, close as one
      transfer-aborted pair, never transfer-ended.

Synthetic studies only (test_image_route's D03A phantom series); cleaned through the local guard like the other suites.
"""
from __future__ import annotations

import json
import re
import ssl
import subprocess
import time
import unittest
from dataclasses import dataclass
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

import test_worklist as base
from invariants_live import ROOT, psql
from test_image_route import FRAME_ACCEPT, ct_series, quoted

DICOM = 'multipart/related; type="application/dicom"'
FRAME = "/dicom-web/studies/{study}/series/{series}/instances/{sop}/frames/{frame}"
OBJECT = "/dicom-web/studies/{study}/series/{series}/instances/{sop}"
# The shared recorder's idle gap (DEFAULT_IMAGE_DELIVERY_IDLE_MS, 120 s) and a margin for the close's own append.
IDLE_WAIT_SECONDS = 200

# nginx locations as the rendered configuration writes them (proxy/nginx.conf.template, proxy/15-kin-config.envsh).
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
    Cell("E whole study", E_TARGET + "{q_study}", DICOM, (L_API,) * 2, ("E image API",) * 2, (503, 200)),
]
DESCRIPTION_CELLS = [
    Cell("study metadata", "/dicom-web/studies/{study}/metadata", "application/dicom+json", (L_DESCRIPTIONS,) * 2, ("authz -> Orthanc",) * 2),
    Cell("study query", "/dicom-web/studies?StudyInstanceUID={study}", "application/dicom+json", (L_DESCRIPTIONS,) * 2, ("authz -> Orthanc",) * 2),
    Cell("instance tags", "/instances/{id}/tags", "application/json", (L_INSTANCES,) * 2, ("recorded relay, description",) * 2),
]
# The failing GETs of (d): admitted by their route (the study is readable), refused after the admission.
FAILING_CELLS = [
    Cell("rendering of a frame past the object", "/instances/{id}/frames/99/rendered", "image/png", (L_INSTANCES,) * 2, ("recorded relay",) * 2),
    Cell("frame past the object", FRAME.replace("{frame}", "99"), FRAME_ACCEPT, (L_FRAMES, L_E_FRAMES), ("frame reader", "E image API")),
]
# Every other location of the rendered configuration and why it carries no image byte. A location absent here fails (a).
NO_IMAGE = {
    "/": "the HTTP server's redirect to HTTPS, and the HTTPS server's 404 for every unlisted path",
    "~* ^/auth/realms/kin/account": "Keycloak's account console, answered 404",
    "= /auth/admin": "Keycloak administration, answered 404", "^~ /auth/admin/": "Keycloak administration, answered 404",
    "= /auth/realms/master": "Keycloak master realm, answered 404", "^~ /auth/realms/master/": "Keycloak master realm, answered 404",
    "= /auth/realms/kin/login-actions/registration": "Keycloak registration form",
    "= /auth/realms/kin/protocol/openid-connect/token": "Keycloak token exchange", "/auth/": "Keycloak pages",
    "= /ops-status.json": "the monitor's four-field heartbeat file",
    "= /api/auth/register": "the registration redirect of the API", "= /api/dicom-import": "the member's import upload (a write)",
    "~ ^/api/studies/[0-9.]+/original-downloads/[0-9a-f-]+/archive$":
        "the original-download archive: a separate act (a copy handed over, S9-U4b/D1489) with its own durable "
        "provide-prepared/transfer pair per download, not a viewing read",
    "/worklist/": "the worklist page's files from Orthanc's static folder", "/ohif/": "the viewer bundle from Orthanc's OHIF plugin",
    "^~ /kin-brand/": "branding files", "= /ohif/manifest.json": "the viewer's web manifest",
    "= /statistics": "Orthanc's counters", "= /system": "Orthanc's version", "= /kin-authz": "the internal admission subrequest",
    "^~ /.well-known/acme-challenge/": "certificate challenge files (production only)",
}


def rendered_locations():
    """Every `location` the running proxy's nginx has loaded (`nginx -T`), as written."""
    dump = subprocess.run(["docker", "compose", "exec", "-T", "proxy", "nginx", "-T"], cwd=ROOT, capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=60)
    if dump.returncode:
        raise RuntimeError("nginx -T failed: " + dump.stderr[-500:])
    return {match.strip() for match in re.findall(r"^\s*location\s+([^{]+?)\s*\{", dump.stdout, re.M)}


def study_entries(uid):
    """(event_id, recorded_at epoch seconds, payload) of the access entries whose targets name the study `uid`."""
    quoted([uid])
    rows = psql("SELECT e.event_id || E'\\t' || extract(epoch FROM e.recorded_at)::text || E'\\t' || e.payload "
                "FROM emr_access.access_entry e WHERE e.entry_id IN "
                f"(SELECT entry_id FROM emr_access.access_target WHERE record_id = '{uid}') ORDER BY e.sequence;")
    return [(row.split("\t", 2)[0], float(row.split("\t", 2)[1]), json.loads(row.split("\t", 2)[2])) for row in rows]


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
        for name, template in (("q_frame", FRAME), ("q_object", OBJECT), ("q_study", "/dicom-web/studies/{study}")):
            values[name] = quote(template.format(**values), safe="")
        return values

    def member_entries(self, uid, action=None):
        rows = study_entries(uid)
        self.assertTrue(all(p["userId"]["value"]["subject"] == self.stack.user_ids["doctor"] for _, _, p in rows), rows)
        return [row for row in rows if action is None or row[2]["action"] == action]

    def test_image_paths_01_every_image_path_records_the_one_study_delivery(self):
        found = rendered_locations()
        catalog = L_E_FRAMES in found
        mode = 1 if catalog else 0
        print("IMAGE_PATHS " + json.dumps({"stack": "catalog" if catalog else "stock"}), flush=True)

        # (a) the table knows every location; each image location is exercised by a cell on this stack.
        cells = IMAGE_CELLS + DESCRIPTION_CELLS + FAILING_CELLS
        exercised = {part for cell in cells for part in cell.locations[mode].split(" -> ")}
        self.assertEqual(set(), found - exercised - set(NO_IMAGE), "a proxy location the image-path table does not classify")
        for location in (L_STUDY, L_STUDY_READ, L_FRAMES, L_PREVIEW, L_DESCRIPTIONS, L_DICOMWEB, L_INSTANCES, L_API):
            self.assertIn(location, found, "an image location of the template is missing from the rendered proxy")

        a, b, c = self.study("paths-read"), self.study("paths-head"), self.study("paths-fail")
        for values in (a, b, c):
            self.assertEqual([], self.member_entries(values["study"]), "a study nobody has read has no access entry")

        # (b) one session reads every image cell of study a.
        matrix = []
        for index, cell in enumerate(IMAGE_CELLS):
            with self.subTest(cell=cell.name, method="GET"):
                status, headers, body, sent, headed = self.fetch(cell.path.format(**a), accept=cell.accept)
                matrix.append({"cell": cell.name, "location": cell.locations[mode], "route": cell.routes[mode], "method": "GET",
                               "status": status, "bytes": len(body), "e_record": headers.get("x-kin-image-event")})
                self.assertEqual(cell.get_status[mode], status, body[:300])
                if status == 200:
                    self.assertTrue(body, "an image answer carries its image")
                provided = self.member_entries(a["study"], "provide-prepared")
                self.assertEqual(1, len(provided), "one provide-prepared entry for the session's reads of the study, whichever route")
                if index == 0:
                    self.assertTrue(sent <= provided[0][1] <= headed,
                                    f"the record ({provided[0][1]}) is written after the request left ({sent}) and before "
                                    f"the response headers arrived ({headed})")
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

        # (c) HEAD alone on study b.
        for cell in IMAGE_CELLS:
            with self.subTest(cell=cell.name, method="HEAD alone"):
                status, headers, body, _, _ = self.fetch(cell.path.format(**b), "HEAD", cell.accept)
                self.assertEqual((cell.get_status[mode], b""), (status, body))
                self.assertEqual([], self.member_entries(b["study"]), "a HEAD opens no delivery")

        # (d) on study c: GETs admitted then refused, and successful HEADs of every image cell.
        for cell in FAILING_CELLS:
            status, _, body, _, _ = self.fetch(cell.path.format(**c), accept=cell.accept)
            matrix.append({"cell": cell.name, "location": cell.locations[mode], "route": cell.routes[mode], "method": "GET",
                           "status": status, "bytes": len(body)})
            self.assertGreaterEqual(status, 400, "a frame past the object is not an image")
        for cell in IMAGE_CELLS:
            status, _, body, _, _ = self.fetch(cell.path.format(**c), "HEAD", cell.accept)
            self.assertEqual((cell.get_status[mode], b""), (status, body))
        self.assertEqual(1, len(self.member_entries(c["study"], "provide-prepared")), "the refused reads were admitted under one record")
        print("IMAGE_PATHS_MATRIX " + json.dumps(matrix), flush=True)

        # The deliveries end after the idle gap: a's pair ended, c's aborted, b has none.
        deadline = time.monotonic() + IDLE_WAIT_SECONDS
        while time.monotonic() < deadline and not (len(self.member_entries(a["study"])) >= 2 and len(self.member_entries(c["study"])) >= 2):
            time.sleep(2)
        for values, closing in ((a, ("transfer-ended", "succeeded")), (c, ("transfer-aborted", "aborted"))):
            entries = self.member_entries(values["study"])
            self.assertEqual(["provide-prepared", closing[0]], [p["action"] for _, _, p in entries], "exactly one pair")
            self.assertEqual((closing[1], entries[0][0]), (entries[1][2]["result"], entries[1][2]["relatedEventId"]))
        self.assertEqual([], self.member_entries(b["study"]), "HEADs alone left no pair after the idle gap either")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ImagePathsE2E(name) for name in loader.getTestCaseNames(ImagePathsE2E)
                              if name.startswith("test_image_paths_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
