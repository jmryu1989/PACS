# coding: utf-8
"""EMR-E E_ROUTE: the viewer's image frames over the served nginx -> API E boundary -> Orthanc path (E-01/E-02/E-03/E-05).

TEST-E-ROUTE-01 one frame through the public HTTPS entry: the exact stored frame bytes, sent only as one durable B2
  provide-prepared entry whose fixed response manifest names that frame, followed by its transfer-ended entry and the
  transport/copy observations; a member of another institution gets no bytes and leaves no provide entry.
TEST-E-ROUTE-02 the served OHIF viewer opens a synthetic CT series twice (the first opening after arrival, then again
  from a fresh browser): every slice reaches the viewer (the browser read its frame response to the end, or the viewer
  holds its image), every frame response carries its E event, and every one the browser read to the end has exactly
  one provide entry; a provide entry the browser did not receive has at most one terminal entry and is never recorded
  as ended short of its planned bytes (E-03). E observes its own connection to nginx: a frame nginx took whole and the
  page dropped afterwards is an ended transfer, never a viewed one. The pinned viewer's streaming frame loader stops
  reading at Content-Length without reading the end of the stream, and the browser then sometimes cancels a response it
  received whole (net::ERR_ABORTED, every byte received, no page abort; runs e-route-diag3/diag4-opus-20261026a): such
  a slice is in the viewer, so the viewer's own state is read as well as the network events. Each opening prints one
  MEASURE line (first rendered image, every slice reached) and one FRAME_REQUEST_FAILED line per failed frame request
  before the assertions, so the same test times the route it runs against (direct Orthanc before E_ROUTE, the E
  boundary after it).
TEST-E-ROUTE-03 after a frame went through E (which then keeps the study's manifest for the next frames), one more
  object arrives in the same series; a series retrieve and a study retrieve through E's image API answer with every
  object the study holds now, the arrival included, byte for byte as stored (R244-01).

Synthetic studies only (the D03A phantom pattern, larger matrix); cleaned through the local guard like the other D03A suites.
"""
from __future__ import annotations

import hashlib
import json
import os
import ssl
import time
import unittest
import uuid
from email.parser import BytesParser
from email.policy import default as email_policy
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

import numpy as np
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid
from pynetdicom import AE

import test_worklist as base
from invariants_live import Fixture, psql
from test_prior_selection import canvas_ready

FRAME_ACCEPT = 'multipart/related; type="application/octet-stream"; transfer-syntax=*'
SLICES = int(os.environ.get("KIN_E_ROUTE_SLICES", "200"))
MATRIX = int(os.environ.get("KIN_E_ROUTE_MATRIX", "512"))
# The SOP Instance UIDs among `sops` whose image the served viewer holds: a loaded image of a viewport's stack, or a
# loaded frame of a viewport's volume.
HELD_BY_VIEWER = r"""sops => {
  const cs = window.cornerstone, held = new Set();
  const note = id => { const sop = String(id).split('/instances/')[1]?.split('/')[0]; if (sops.includes(sop)) held.add(sop); };
  for (const engine of cs?.getRenderingEngines?.() || []) for (const viewport of engine.getViewports()) {
    try { for (const id of viewport.getImageIds?.() || []) if (cs.cache.getImage(id)) note(id); } catch (_) {}
    try {
      const volume = viewport.getVolumeId?.() && cs.cache.getVolume(viewport.getVolumeId());
      (volume?.imageIds || []).forEach((id, k) => { if (volume.loadStatus?.cachedFrames?.[k]) note(id); });
    } catch (_) {}
  }
  return [...held];
}"""


def ct_series(stack, label, slices, size):
    """An owned synthetic CT series (D03A phantom drawn at `size`), registered for cleanup before the first write.
    Returns (fixture, series UID, SOP Instance UIDs, the study's identity for store_ct)."""
    study = (generate_uid(), generate_uid(), generate_uid(), "EROUTE-" + uuid.uuid4().hex[:12])
    uid = study[0]
    fixture = Fixture(uid, study[3], "한림병원", "jmryu", "EROUTE-SYNTHETIC-" + label)
    stack.active[uid] = fixture
    sops = store_ct(study, label, 0, slices, size)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        result = stack.request("GET", "/studies", "jmryu")
        if result.status == 200 and any(s.get("uid") == uid for s in result.body.get("studies", [])):
            break
        time.sleep(.25)
    else:
        raise RuntimeError("Synthetic CT did not reach the real API")
    if stack.request("PATCH", "/studies/" + uid, "jmryu", {"ss": "Verified"}).status != 200:
        raise RuntimeError("Synthetic CT verification failed")
    return fixture, study[1], sops, study


def store_ct(study, label, first, slices, size):
    """C-STORE `slices` phantom slices, numbered from `first`, into study = (study UID, series UID, frame of reference,
    patient ID) of an owned series; their SOP Instance UIDs."""
    uid, series, frame, patient = study
    yy, xx = np.mgrid[:size, :size]
    scale = size / 256
    body = np.where((xx - 125 * scale) ** 2 + (yy - 128 * scale) ** 2 < (95 * scale) ** 2, 300 + xx * 2 / scale, 0).astype(np.uint16)
    ae = AE(ae_title="HALLYM_CT")
    ae.add_requested_context(CTImageStorage, ExplicitVRLittleEndian)
    assoc = ae.associate("127.0.0.1", 4242, ae_title="KINLAB")
    if not assoc.is_established:
        raise RuntimeError("Local synthetic CT association failed")
    sops = []
    try:
        for z in range(first, first + slices):
            sop = generate_uid()
            meta = FileMetaDataset()
            meta.TransferSyntaxUID, meta.MediaStorageSOPClassUID = ExplicitVRLittleEndian, CTImageStorage
            meta.MediaStorageSOPInstanceUID, meta.ImplementationClassUID = sop, generate_uid()
            ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
            ds.is_little_endian, ds.is_implicit_VR = True, False
            ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
            ds.SpecificCharacterSet = "ISO_IR 192"
            ds.PatientName, ds.PatientID = "EROUTE^SYNTHETIC", patient
            ds.PatientBirthDate, ds.PatientSex, ds.InstitutionName = "", "O", "한림병원"
            ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = uid, series, frame
            ds.StudyDate = ds.SeriesDate = "20261026"
            ds.StudyTime = ds.SeriesTime = "120000"
            ds.AccessionNumber, ds.StudyID = "ER" + label, "EROUTE"
            ds.StudyDescription = ds.SeriesDescription = "EROUTE " + label
            ds.Modality, ds.SeriesNumber, ds.InstanceNumber = "CT", 1, z + 1
            ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
            ds.ImageOrientationPatient, ds.ImagePositionPatient = [1, 0, 0, 0, 1, 0], [0, 0, z * 1.25]
            ds.SliceLocation, ds.PixelSpacing = z * 1.25, [0.7, 0.7]
            ds.SliceThickness = ds.SpacingBetweenSlices = 1.25
            ds.Rows = ds.Columns = size
            ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
            ds.BitsAllocated = ds.BitsStored = 16
            ds.HighBit, ds.PixelRepresentation = 15, 0
            ds.WindowCenter, ds.WindowWidth = -500, 1000
            ds.RescaleIntercept, ds.RescaleSlope, ds.RescaleType = -1000, 1, "HU"
            pixels = body.copy()
            pixels[int(50 * scale):int(82 * scale), int(45 * scale):int(88 * scale)] = 950
            pixels[int(190 * scale):int(200 * scale), int(30 * scale):int(30 * scale) + (z % 20 + 1) * int(9 * scale)] = 1000
            ds.PixelData = pixels.astype("<u2").tobytes()
            status = assoc.send_c_store(ds)
            if status is None or status.Status != 0:
                raise RuntimeError("Synthetic CT C-STORE failed")
            sops.append(sop)
    finally:
        assoc.release()
    return sops


def multipart_parts(content_type, body):
    message = BytesParser(policy=email_policy).parsebytes(
        ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode("ascii") + body)
    if not message.is_multipart():
        raise AssertionError("A WADO-RS frame answer is multipart/related: " + content_type)
    return [(part.get("Content-Type", ""), part.get_payload(decode=True)) for part in message.iter_parts()]


def entries(where):
    """B2 access entries (event_id, payload) matching a SQL condition on emr_access.access_entry e."""
    rows = psql("SELECT e.event_id || E'\\t' || e.payload FROM emr_access.access_entry e WHERE " + where + " ORDER BY e.sequence;")
    return [(row.split("\t", 1)[0], json.loads(row.split("\t", 1)[1])) for row in rows]


def quoted(values):
    for value in values:
        if not all(c.isdigit() or c in ".-abcdef" for c in value):
            raise RuntimeError("Refusing an unexpected identifier in SQL")
    return ",".join("'" + value + "'" for value in values)


class ImageRouteE2E(base.WorklistE2E):
    def frame(self, path, actor, method="GET", accept=FRAME_ACCEPT):
        request = Request(self.stack.proxy + path, method=method, headers={
            "Accept": accept, "Authorization": "Bearer " + self.stack.token(actor)})
        try:
            with urlopen(request, timeout=120, context=ssl._create_unverified_context()) as response:
                return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
        except HTTPError as error:
            return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()

    def orthanc_instance(self, sop):
        rows = self.stack._orthanc_request("POST", "/tools/lookup", sop.encode("ascii")).body
        return next(row["ID"] for row in rows if row["Type"] == "Instance")

    def wait_entries(self, where, count, seconds=30):
        deadline = time.monotonic() + seconds
        while True:
            found = entries(where)
            if len(found) >= count or time.monotonic() >= deadline:
                return found
            time.sleep(.25)

    def test_route_01_one_frame_through_https_is_one_recorded_delivery(self):
        fixture, series, sops, _ = ct_series(self.stack, "single", 2, 64)
        path = f"/dicom-web/studies/{fixture.uid}/series/{series}/instances/{sops[1]}/frames/1"
        stored = self.stack.orthanc_bytes(f"/instances/{self.orthanc_instance(sops[1])}/frames/0/raw")
        status, headers, body = self.frame(path, "doctor")
        self.assertEqual(200, status, body[:300])
        parts = multipart_parts(headers.get("content-type", ""), body)
        self.assertEqual(1, len(parts))
        self.assertEqual(stored, parts[0][1], "the exact stored frame bytes")
        event = headers.get("x-kin-image-event")
        self.assertTrue(event, "a frame through the public entry is an E delivery with its B2 event")
        quoted([event])
        provided = entries(f"e.event_id = '{event}'")
        self.assertEqual(1, len(provided), "exactly one provide entry for the delivery")
        payload = provided[0][1]
        self.assertEqual(("provide-prepared", "prepared", "GET images/dicom-web"),
                         (payload["action"], payload["result"], payload["surface"]))
        self.assertEqual(self.stack.user_ids["doctor"], payload["userId"]["value"]["subject"])
        self.assertEqual([(fixture.uid, sops[1])], [(t["studyId"]["value"], t["recordId"]["value"]) for t in payload["targets"]])
        rows = psql(f"SELECT response_manifest::text FROM emr_image.preparation WHERE event_id = '{event}'::uuid;")
        self.assertEqual(1, len(rows))
        fixed = json.loads(rows[0])
        self.assertEqual(headers.get("x-kin-image-manifest"), fixed["sha256"])
        self.assertEqual([(sops[1], 1, len(stored), hashlib.sha256(stored).hexdigest())],
                         [(r["sopInstanceUid"], r["frame"], r["bytes"], r["sha256"]) for r in fixed["representations"]])
        self.assertEqual((200, True, int(headers["content-length"])),
                         (fixed["http"]["status"], fixed["http"]["body"], fixed["http"]["plannedBytes"]))
        ended = self.wait_entries(f"e.payload::jsonb->>'relatedEventId' = '{event}'", 1)
        self.assertEqual([("transfer-ended", "succeeded")], [(p["action"], p["result"]) for _, p in ended])
        kinds = psql(f"SELECT kind FROM emr_image.observation WHERE event_id = '{event}'::uuid ORDER BY sequence;")
        self.assertEqual(["transport", "copies"], kinds)

        # HEAD is the same prepared representation without a body.
        status, head, body = self.frame(path, "doctor", "HEAD")
        self.assertEqual((200, b""), (status, body))
        head_event = head.get("x-kin-image-event")
        self.assertTrue(head_event)
        self.assertEqual(1, len(entries(f"e.event_id IN ({quoted([head_event])})")))

        # Another institution's member: no bytes, no E event, no provide entry naming this object for that member.
        before = len(entries(f"e.entry_id IN (SELECT entry_id FROM emr_access.access_target WHERE record_id = '{sops[1]}')"))
        status, refused, body = self.frame(path, "kdoctor")
        self.assertIn(status, (403, 404), body[:300])
        self.assertNotIn(stored, body)
        self.assertIsNone(refused.get("x-kin-image-event"))
        after = entries(f"e.entry_id IN (SELECT entry_id FROM emr_access.access_target WHERE record_id = '{sops[1]}')")
        self.assertEqual(before, len(after))

    def open_series(self, fixture, sops, opening):
        """One served-viewer opening in a fresh signed-in browser context; (MEASURE row, answered frame responses).

        A slice reached the viewer when the browser read its frame response to the end or when the viewer holds its
        image. The pinned viewer's streaming frame loader stops reading at Content-Length and never reads the end of the
        stream, so the browser can cancel a response it has already received whole (net::ERR_ABORTED with every byte
        received; runs e-route-diag3/diag4-opus-20261026a); that slice is in the viewer all the same."""
        page = self.login()
        answered, finished, failed = {}, {}, []
        ours = lambda request: "/frames/" in request.url and f"/studies/{fixture.uid}/" in request.url
        sop_of = lambda request: request.url.split("/instances/", 1)[1].split("/", 1)[0]

        def headers(response):
            if ours(response.request):
                answered[id(response.request)] = {"sop": sop_of(response.request), "status": response.status,
                                                  "event": response.headers.get("x-kin-image-event")}

        def done(request):
            if ours(request):
                finished.setdefault(sop_of(request), []).append(answered.get(id(request), {"status": None, "event": None}))

        def lost(request):
            if ours(request):
                failed.append({"url": request.url, "failure": request.failure})

        page.context.on("response", headers)
        page.context.on("requestfinished", done)
        page.context.on("requestfailed", lost)
        started = time.monotonic()
        page.goto(self.stack.proxy + "/ohif/viewer?StudyInstanceUIDs=" + fixture.uid)
        canvas_ready(page, 1)
        first = time.monotonic() - started
        deadline, held, looked = started + 300, set(), 0.0
        while not set(sops) <= set(finished) | held and time.monotonic() < deadline:
            if time.monotonic() - looked >= 1:
                held, looked = set(page.evaluate(HELD_BY_VIEWER, sops)), time.monotonic()
            page.wait_for_timeout(250)
        held = set(page.evaluate(HELD_BY_VIEWER, sops))
        every = time.monotonic() - started if set(sops) <= set(finished) | held else None
        received = [row for rows in finished.values() for row in rows]
        measure = {"route": "e-boundary" if any(r["event"] for r in answered.values()) else "direct", "opening": opening,
                   "slices": SLICES, "matrix": MATRIX,
                   "first_render_seconds": round(first, 3), "all_frames_seconds": None if every is None else round(every, 3),
                   "frame_responses": len(received), "distinct_sops": len(set(finished) & set(sops)),
                   "held_by_viewer": len(held & set(sops)), "failed_requests": len(failed)}
        print("MEASURE " + json.dumps(measure), flush=True)
        for row in failed:
            print("FRAME_REQUEST_FAILED " + json.dumps({"opening": opening, **row}), flush=True)
        page.context.close()
        return measure, received, list(answered.values())

    def test_route_02_served_viewer_ct_series_every_received_frame_recorded_once(self):
        fixture, series, sops, _ = ct_series(self.stack, "series", SLICES, MATRIX)
        # The first opening after the study arrives, then a second opening by a fresh browser (no HTTP cache).
        cold, first, first_answered = self.open_series(fixture, sops, "first")
        warm, second, second_answered = self.open_series(fixture, sops, "again")
        out = Path(os.environ.get("KIN_EVIDENCE_DIR") or Path(__file__).parent / "artifacts")
        out.mkdir(parents=True, exist_ok=True)
        (out / "image-route-measure.json").write_text(json.dumps([cold, warm], indent=2), encoding="utf-8")

        for measure in (cold, warm):
            self.assertIsNotNone(measure["all_frames_seconds"], f"every slice's frame reached the viewer ({measure['opening']})")
        answered = first_answered + second_answered
        self.assertTrue(all(r["status"] == 200 and r["event"] for r in answered), "every frame response came through the E boundary")
        self.assertEqual(len(answered), len({r["event"] for r in answered}), "one E event per delivery")
        received = first + second
        self.assertTrue(all(r["status"] == 200 for r in received), received[:5])
        events = [r["event"] for r in received]
        self.assertTrue(all(events), "every frame the browser received came through the E boundary")
        self.assertEqual(len(events), len(set(events)), "one E event per delivery")
        provided = self.wait_entries(
            f"e.payload::jsonb->>'action' = 'provide-prepared' AND e.entry_id IN (SELECT entry_id FROM emr_access.access_target "
            f"WHERE record_id IN ({quoted(sops)}))", len(events))
        ids = [event for event, _ in provided]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(set(events) <= set(ids), "every received frame has its provide entry")
        terminals = {}
        for event, payload in self.wait_entries(
                f"e.payload::jsonb->>'relatedEventId' IN ({quoted(ids)})", len(events)):
            terminals.setdefault(payload["relatedEventId"], []).append(payload["action"])
        wire = {row.split("\t", 1)[0]: json.loads(row.split("\t", 1)[1]) for row in psql(
            "SELECT event_id || E'\\t' || (body->'wire')::text FROM emr_image.observation "
            f"WHERE kind = 'transport' AND event_id IN ({quoted(ids)});")}
        for event in ids:
            with self.subTest(event=event):
                actions = terminals.get(event, [])
                self.assertLessEqual(len(actions), 1, "at most one terminal entry per delivery")
                if event in events:
                    self.assertEqual(["transfer-ended"], actions)
                if "transfer-ended" in actions:
                    # Ended means E wrote the whole planned response to its connection, whatever the page did later.
                    self.assertEqual(wire[event]["plannedBytes"], wire[event]["bytesWritten"], wire.get(event))
                    self.assertEqual("transfer-ended", wire[event]["terminal"])

    def test_route_03_study_and_series_retrieve_answer_with_an_object_that_arrived_after_a_frame(self):
        fixture, series, sops, study = ct_series(self.stack, "arrival", 2, 64)
        status, headers, body = self.frame(f"/dicom-web/studies/{fixture.uid}/series/{series}/instances/{sops[0]}/frames/1", "doctor")
        self.assertEqual(200, status, body[:300])
        self.assertTrue(headers.get("x-kin-image-event"), "the frame went through E, which keeps this study's manifest")
        arrived = store_ct(study, "arrival", 2, 1, 64)
        digest = lambda data: hashlib.sha256(data).hexdigest()
        stored = sorted(digest(self.stack.orthanc_bytes(f"/instances/{self.orthanc_instance(sop)}/file")) for sop in sops + arrived)
        for target in (f"/dicom-web/studies/{fixture.uid}/series/{series}", f"/dicom-web/studies/{fixture.uid}"):
            with self.subTest(target=target):
                status, headers, body = self.frame("/api/images/dicom-web?target=" + quote(target, safe=""), "doctor",
                                                   accept='multipart/related; type="application/dicom"')
                self.assertEqual(200, status, body[:300])
                self.assertTrue(headers.get("x-kin-image-event"))
                parts = multipart_parts(headers.get("content-type", ""), body)
                self.assertEqual(stored, sorted(digest(payload) for _, payload in parts),
                                 "every object the study holds now, the later arrival included, as stored")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ImageRouteE2E(name) for name in loader.getTestCaseNames(ImageRouteE2E)
                              if name.startswith("test_route_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
