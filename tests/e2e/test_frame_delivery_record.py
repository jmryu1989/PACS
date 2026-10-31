# coding: utf-8
"""The study-level 열람 record of the viewer's frame path, on whichever route the deployment serves it (D1877, 의료법 제23조④).

A fresh install (the stock docker-compose, no viewer/decoder asset catalog) serves the viewer's WADO-RS frames through
the API's frame range reader (api/src/dicom-frame.controller.ts); a deployment that supplies the catalog serves them
through E (api/src/emr-image). On either route no image byte leaves before the study delivery's provide-prepared event
is durable in the access ledger, and one terminal event closes the delivery. The earlier no-catalog route (authorization
subrequest, then Orthanc) sent frames with no such record (R244-GPT-FIX5-01); this suite asserts the contract on the
served HTTPS entry against the ledger itself, not on a 200 or a visible image. It is route-neutral: it reads the record's
content (action, result, member, study target), not the surface of the route that wrote it, and prints that surface.

TEST-FRAME-RECORD-01 one frame GET through HTTPS by a member of the study's institution answers the exact stored frame
  bytes and, by the time the body has arrived, exactly one durable provide-prepared image event names this study
  (recordId = StudyInstanceUID) for this member; a member of another institution gets no bytes and adds no entry for
  the study; after the delivery's idle gap one terminal event closes the pair as transfer-ended, and the study has
  exactly that pair (nothing per frame).

Synthetic studies only (test_image_route's D03A phantom series); cleaned through the local guard like the other suites.
"""
from __future__ import annotations

import json
import ssl
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import test_worklist as base
from invariants_live import psql
from test_image_route import FRAME_ACCEPT, ct_series, multipart_parts, quoted


def study_entries(uid, where="TRUE"):
    """B2 access entries (event_id, payload) whose image targets name the study record `uid`, in ledger order.
    Image targets only, as test_image_paths.entries_of(image_only=True): a worklist read records the listed study's
    metadata (target kind study-metadata, e.g. the fixture's own GET studies), which is not this delivery's record."""
    quoted([uid])
    rows = psql("SELECT e.event_id || E'\\t' || e.payload FROM emr_access.access_entry e WHERE e.entry_id IN "
                f"(SELECT entry_id FROM emr_access.access_target WHERE record_id = '{uid}' AND target_kind = 'image') "
                f"AND {where} ORDER BY e.sequence;")
    return [(row.split("\t", 1)[0], json.loads(row.split("\t", 1)[1])) for row in rows]


class FrameDeliveryRecordE2E(base.WorklistE2E):
    def frame(self, path, actor):
        request = Request(self.stack.proxy + path, headers={"Accept": FRAME_ACCEPT, "Authorization": "Bearer " + self.stack.token(actor)})
        try:
            with urlopen(request, timeout=120, context=ssl._create_unverified_context()) as response:
                return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
        except HTTPError as error:
            return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()

    def test_frame_record_01_one_frame_through_https_is_recorded_before_its_bytes_and_closed_once(self):
        fixture, series, sops, _ = ct_series(self.stack, "record", 2, 64)
        path = f"/dicom-web/studies/{fixture.uid}/series/{series}/instances/{sops[1]}/frames/1"
        lookup = self.stack._orthanc_request("POST", "/tools/lookup", sops[1].encode("ascii")).body
        instance = next(row["ID"] for row in lookup if row["Type"] == "Instance")
        stored = self.stack.orthanc_bytes(f"/instances/{instance}/frames/0/raw")
        self.assertEqual([], study_entries(fixture.uid), "a study nobody has read has no access entry")

        status, headers, body = self.frame(path, "doctor")
        self.assertEqual(200, status, body[:300])
        parts = multipart_parts(headers.get("content-type", ""), body)
        self.assertEqual([stored], [payload for _, payload in parts], "the exact stored frame bytes")
        provided = study_entries(fixture.uid, "e.payload::jsonb->>'action' = 'provide-prepared'")
        self.assertEqual(1, len(provided), "the frame left under exactly one durable provide-prepared entry naming the study")
        event, payload = provided[0]
        quoted([event])
        self.assertEqual("prepared", payload["result"])
        self.assertEqual(self.stack.user_ids["doctor"], payload["userId"]["value"]["subject"], "the record names the member who read")
        self.assertEqual([(fixture.uid, fixture.uid, "image")],
                         [(t["studyId"]["value"], t["recordId"]["value"], t["kind"]) for t in payload["targets"]],
                         "the record's target is the study as an image record")
        print("FRAME_RECORD " + json.dumps({"surface": payload.get("surface"), "event": event}), flush=True)

        # Another institution's member: no bytes, and nothing added to the study's entries.
        status, _, refused = self.frame(path, "kdoctor")
        self.assertIn(status, (403, 404), refused[:300])
        self.assertNotIn(stored, refused)
        self.assertEqual([event], [e for e, _ in study_entries(fixture.uid)], "a refusal adds no entry")

        # The delivery over (its idle gap passed), one terminal closes the pair: the one response was served whole.
        deadline = time.monotonic() + 180
        while True:
            closing = study_entries(fixture.uid, f"e.payload::jsonb->>'relatedEventId' = '{event}'")
            if closing or time.monotonic() >= deadline:
                break
            time.sleep(1)
        self.assertEqual([("transfer-ended", "succeeded")], [(p["action"], p["result"]) for _, p in closing],
                         "one terminal entry closes the delivery's record")
        self.assertEqual([event, closing[0][0]], [e for e, _ in study_entries(fixture.uid)],
                         "the study has exactly the pair: its opening and its closing, nothing per frame")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(FrameDeliveryRecordE2E(name) for name in loader.getTestCaseNames(FrameDeliveryRecordE2E)
                              if name.startswith("test_frame_record_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
