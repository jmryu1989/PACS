# coding: utf-8
"""TEST-MG-DICOM (E-MG R1): the mammography model against real public DICOM headers and pixels.

REQ-MG-01/02/04/05 -> RISK-MG-MISCLASS / RISK-MG-OMIT / RISK-MG-WRONG-STUDY / RISK-MG-FLIP-CLIP.

D73: assertions bind to the model's public output for real objects and to facts read directly from
the DICOM files (header values via pydicom, pixel arrays via numpy). No product source text, function
name or DOM shape is read. Pixel hashes/coordinates here are facts of the original image, not pins.

Samples are read in place from KIN_MG_SAMPLE_ROOT (default: the local public TCIA copy named in
samples.json) and checked by SHA-256; DICOM bytes are never copied into this repository. A missing
or changed sample FAILS the case that needs it; nothing is skipped. Variants (mirrored, relabelled,
damaged) exist only in memory. KIN_MG_MODEL may point at a copy of the model (mutants.py).
"""
from pathlib import Path
import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import pydicom

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
MODEL = Path(os.environ.get("KIN_MG_MODEL") or ROOT / "worklist-v0" / "hpacs-lite" / "mammography-model.js")
SAMPLES = json.loads((HERE / "samples.json").read_text(encoding="utf-8"))
SAMPLE_ROOT = Path(os.environ.get(SAMPLES["root_env"]) or SAMPLES["default_root"])
_verified = {}


def sample_path(sample_id):
    """The local file of a listed sample, after its SHA-256 matches the list."""
    row = next(s for s in SAMPLES["used"] if s["id"] == sample_id)
    if sample_id not in _verified:
        path = SAMPLE_ROOT / row["path"]
        if not path.is_file():
            raise AssertionError("sample %s is not available at %s" % (sample_id, path))
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != row["sha256"]:
            raise AssertionError("sample %s changed: sha256 %s != %s" % (sample_id, digest, row["sha256"]))
        _verified[sample_id] = path
    return _verified[sample_id]


def dataset(sample_id, pixels=False):
    return pydicom.dcmread(str(sample_path(sample_id)), stop_before_pixels=not pixels)


def dicom_json(ds):
    """PS3.18 DICOM JSON of the header (no pixel data), the form the viewer receives as metadata."""
    header = copy.deepcopy(ds)
    for keyword in ("PixelData", "FloatPixelData", "DoubleFloatPixelData"):
        if keyword in header:
            del header[keyword]
    return header.to_json_dict(bulk_data_threshold=1 << 20, bulk_data_element_handler=lambda _element: "")


def node():
    found = os.environ.get("KIN_NODE") or shutil.which("node")
    if not found:
        raise AssertionError("node is required to run the model")
    return found


RUNNER = r"""
const m=require(process.argv[2]);
const calls=JSON.parse(require('fs').readFileSync(process.argv[3],'utf8'));
const out=calls.map(([op,...args])=>{
  if(op==='coverage'){const index=m.frameIndex(args[0]),c=m.createCoverage(index);for(const e of index.entries)c.mark(e);return c.snapshot();}
  return m[op](...args);
});
process.stdout.write(JSON.stringify(out,(k,v)=>k==='item'?undefined:v));
"""


def run_model(*calls):
    with tempfile.TemporaryDirectory(prefix="kin-mg-") as scratch:
        script, data = Path(scratch) / "run.cjs", Path(scratch) / "calls.json"
        script.write_text(RUNNER, encoding="utf-8")
        data.write_text(json.dumps(list(calls)), encoding="utf-8")
        done = subprocess.run([node(), str(script), str(MODEL), str(data)], capture_output=True, text=True, encoding="utf-8", timeout=120)
    if done.returncode != 0:
        raise AssertionError("model run failed: " + done.stderr[-2000:])
    return json.loads(done.stdout)


def tag(item, key):
    value = item.get(key, {}).get("Value")
    return value[0] if value else None


def per_frame_projection(ds):
    """Position of every stored frame along the slice normal, from the header (PS3.3 C.7.6.16.2.3)."""
    iop = np.array(ds.SharedFunctionalGroupsSequence[0].PlaneOrientationSequence[0].ImageOrientationPatient, dtype=float)
    normal = np.cross(iop[:3], iop[3:])
    return [float(np.dot(np.array(f.PlanePositionSequence[0].ImagePositionPatient, dtype=float), normal))
            for f in ds.PerFrameFunctionalGroupsSequence]


def chest_wall_side(pixels):
    """Image edge the breast is attached to: the vertical edge strip that is mostly tissue."""
    a = pixels.astype(np.float64)
    low = np.percentile(a, 5)
    tissue = a > low + 0.1 * (a.max() - low)
    strip = max(1, a.shape[1] // 20)
    left, right = tissue[:, :strip].mean(), tissue[:, -strip:].mean()
    if right > left + 0.3:
        return "right"
    if left > right + 0.3:
        return "left"
    raise AssertionError("chest wall edge not decidable from pixels (left %.3f right %.3f)" % (left, right))


def voi(values, center, width, fn):
    """PS3.3 C.11.2.1.2 VOI LUT functions to 0..255."""
    x = values.astype(np.float64)
    if fn == "SIGMOID":
        return 255.0 / (1.0 + np.exp(-4.0 * (x - center) / width))
    if fn == "LINEAR_EXACT":
        return np.clip((x - center) / width + 0.5, 0, 1) * 255.0
    return np.clip((x - (center - 0.5)) / (width - 1) + 0.5, 0, 1) * 255.0


def displayed(pixels, spec):
    out = pixels
    if spec["orientation"]["flipH"]:
        out = out[:, ::-1]
    if spec["orientation"]["flipV"]:
        out = out[::-1, :]
    return out


CMMD_VIEWS = ["cmmd-d2-0140-1", "cmmd-d2-0140-2", "cmmd-d2-0140-3", "cmmd-d2-0140-4"]
DBT_OBJECTS = ["ea1141-3227336-185841", "ea1141-3227336-148695", "ea1141-3227336-310042", "ea1141-3227336-319808"]
VIEW_MEANING = {"cranio-caudal": "CC", "medio-lateral oblique": "MLO"}


def header_view(ds):
    return VIEW_MEANING[str(ds.ViewCodeSequence[0].CodeMeaning)]


def header_laterality(ds):
    if "ImageLaterality" in ds:
        return str(ds.ImageLaterality)
    return str(ds.SharedFunctionalGroupsSequence[0].FrameAnatomySequence[0].FrameLaterality)


def study_of(sample_ids, role, institution="H1"):
    items = [dicom_json(dataset(s)) for s in sample_ids]
    return {"uid": tag(items[0], "0020000D"), "role": role, "institution": institution, "instances": items}


class MammographyDicomContractTest(unittest.TestCase):
    maxDiff = None

    def test_mg01_real_objects_are_classified_by_standard_attributes(self):
        calls = [["classify", dicom_json(dataset(s))] for s in CMMD_VIEWS + DBT_OBJECTS]
        results = run_model(*calls)
        for sample_id, result in zip(CMMD_VIEWS, results[:4]):
            ds = dataset(sample_id)
            self.assertEqual(list(ds.ImageType), ["DERIVED", "PRIMARY"], sample_id)
            self.assertEqual(result["kind"], "conventional", "MG01: CMMD DERIVED\\PRIMARY is a 2D exposure, not synthetic 2D: " + sample_id)
            self.assertEqual(result["status"], "verified")
            self.assertTrue(result["standard"], sample_id)
            self.assertEqual((result["laterality"], result["view"]), (header_laterality(ds), header_view(ds)), sample_id)
        for sample_id, result in zip(DBT_OBJECTS, results[4:]):
            ds = dataset(sample_id)
            techniques = {str(f.XRay3DFrameTypeSequence[0].VolumeBasedCalculationTechnique) for f in ds.PerFrameFunctionalGroupsSequence}
            self.assertEqual(techniques, {"MAX_IP"}, sample_id)
            self.assertEqual(result["kind"], "dbt", sample_id)
            self.assertEqual(result["sliceKind"], "mip-slab", "MG01: the stored 10 mm MIP slabs are not reported as thin slices: " + sample_id)
            self.assertEqual(result["sliceThickness"], float(ds.SharedFunctionalGroupsSequence[0].PixelMeasuresSequence[0].SliceThickness))
            self.assertEqual((result["laterality"], result["view"]), (header_laterality(ds), header_view(ds)), sample_id)
            self.assertTrue(result["standard"], sample_id)

    def test_mg01_description_derivation_or_secondary_capture_never_confirms_a_kind(self):
        victre, processing, specimen = (dicom_json(dataset(s)) for s in ("victre-208084664-1", "ea1141-8036458-1", "breastdx-01-0021-1"))
        relabelled = dicom_json(dataset("cmmd-d2-0140-1"))
        relabelled["0008103E"] = {"vr": "LO", "Value": ["R CC C-View"]}
        tomo_text = dicom_json(dataset("cmmd-d2-0140-1"))
        tomo_text["0008103E"] = {"vr": "LO", "Value": ["MAMMOGRAPHY WITH TOMOSYNTHESIS"]}
        r_victre, r_processing, r_specimen, r_relabelled, r_tomo = run_model(
            ["classify", victre], ["classify", processing], ["classify", specimen], ["classify", relabelled], ["classify", tomo_text])
        self.assertEqual(tag(victre, "00080016"), "1.2.840.10008.5.1.4.1.1.7")
        self.assertNotIn(r_victre["kind"], ("dbt", "generated2d"), "MG01: a secondary-capture phantom named 'DBT slices' is no device image")
        self.assertFalse(r_victre["standard"])
        self.assertEqual(r_processing["presentation"], "processing")
        self.assertFalse(r_processing["standard"], "MG01: For Processing is not offered as For Presentation")
        self.assertEqual((r_specimen["view"], r_specimen["modifiers"]), ("SPECIMEN", ["Magnification"]))
        self.assertFalse(r_specimen["standard"])
        self.assertNotEqual(r_relabelled["kind"], "generated2d", "MG01: a description alone never makes a synthetic view")
        self.assertFalse(r_relabelled["standard"])
        self.assertEqual(r_tomo["kind"], "conventional")

    def test_mg02_real_dbt_frames_are_indexed_first_to_last_with_exact_identity(self):
        total = 0
        for sample_id in DBT_OBJECTS:
            ds = dataset(sample_id)
            index, coverage = run_model(["frameIndex", dicom_json(ds)], ["coverage", dicom_json(ds)])
            frames = int(ds.NumberOfFrames)
            total += frames
            self.assertEqual(index["total"], frames, sample_id)
            self.assertEqual(sorted(e["frame"] for e in index["entries"]), list(range(1, frames + 1)), "MG02: every stored frame " + sample_id)
            self.assertTrue(all(e["sop"] == str(ds.SOPInstanceUID) for e in index["entries"]))
            self.assertTrue(index["complete"], sample_id)
            projection = per_frame_projection(ds)
            steps = np.diff(projection)
            self.assertTrue(np.all(steps > 0) or np.all(steps < 0), "stored order of this sample is a walk through the volume")
            self.assertEqual([e["frame"] for e in index["entries"]], list(range(1, frames + 1)), "monotonic storage keeps stored order")
            for e in index["entries"]:
                self.assertAlmostEqual(e["position"]["offset"], abs(projection[e["frame"] - 1] - projection[0]), places=6)
            self.assertAlmostEqual(index["spacing"], float(np.mean(np.abs(steps))), places=6)
            self.assertEqual(coverage, {"total": frames, "seen": frames, "complete": True})
        self.assertEqual(total, 68)

    def test_mg02_damaged_copies_of_a_real_dbt_never_report_complete(self):
        ds = dataset("ea1141-3227336-310042")
        base = dicom_json(ds)
        frames = int(ds.NumberOfFrames)
        dropped = copy.deepcopy(base)
        dropped["52009230"]["Value"].pop()
        duplicated = copy.deepcopy(base)
        duplicated["52009230"]["Value"][1]["00209113"] = copy.deepcopy(base["52009230"]["Value"][0]["00209113"])
        overcounted = copy.deepcopy(base)
        overcounted["00280008"]["Value"] = [frames + 1]
        shuffled = copy.deepcopy(base)
        order = [3, 0, 7, 1, 5, 2, 6, 4] + list(range(8, frames))
        shuffled["52009230"]["Value"] = [base["52009230"]["Value"][k] for k in order]
        r_dropped, r_dup, r_over, r_shuffled = run_model(["frameIndex", dropped], ["frameIndex", duplicated], ["frameIndex", overcounted], ["frameIndex", shuffled])
        self.assertFalse(r_dropped["complete"], "MG02: a missing per-frame item is not complete")
        self.assertEqual(sorted(e["frame"] for e in r_dropped["entries"]), list(range(1, frames + 1)))
        self.assertFalse(r_dup["complete"], "MG02: a duplicated position is not complete")
        self.assertFalse(r_over["complete"], "MG02: a wrong total is not complete")
        self.assertTrue(r_shuffled["complete"])
        projection = per_frame_projection(ds)
        for e in r_shuffled["entries"]:
            stored_original = order[e["frame"] - 1]
            self.assertAlmostEqual(e["position"]["projection"], projection[stored_original], places=6,
                                   msg="a sorted entry names the stored frame that lies at its position")

    def test_mg04_real_four_view_series_is_split_per_object(self):
        current = study_of(CMMD_VIEWS, "current")
        self.assertEqual(len({tag(i, "0020000E") for i in current["instances"]}), 1, "all four views share one series")
        self.assertNotIn("00200060", current["instances"][0], "no series laterality to lean on")
        (plan,) = run_model(["plan", {"institution": "H1", "studies": [current]}])
        self.assertEqual(plan["status"], "ok")
        for sample_id in CMMD_VIEWS:
            ds = dataset(sample_id)
            key = "|".join(["current", header_laterality(ds), header_view(ds), "conventional"])
            self.assertEqual(plan["slots"][key]["status"], "ready", key)
            self.assertEqual(plan["slots"][key]["object"]["sop"], str(ds.SOPInstanceUID), key)
        for side in "RL":
            for view in ("CC", "MLO"):
                self.assertEqual(plan["slots"]["prior|%s|%s|conventional" % (side, view)]["status"], "missing")
                self.assertEqual(plan["slots"]["current|%s|%s|generated2d" % (side, view)]["status"], "missing")
        (dbt_plan,) = run_model(["plan", {"institution": "H1", "studies": [study_of(DBT_OBJECTS, "current")]}])
        for sample_id in DBT_OBJECTS:
            ds = dataset(sample_id)
            key = "|".join(["current", header_laterality(ds), header_view(ds), "dbt"])
            self.assertEqual(dbt_plan["slots"][key]["object"]["sop"], str(ds.SOPInstanceUID), key)
        self.assertTrue(all(dbt_plan["slots"]["current|%s|%s|generated2d" % (s, v)]["status"] == "missing" for s in "RL" for v in ("CC", "MLO")),
                        "no synthetic 2D is made from DBT")

    def test_mg04_other_patients_are_never_a_prior_and_duplicates_are_not_picked(self):
        current = study_of(CMMD_VIEWS, "current")
        same_day = study_of(["cmmd-d1-0860-1"], "prior")
        later = study_of(["cmmd-d1-0577-1"], "prior")
        self.assertEqual(tag(current["instances"][0], "00080020"), tag(same_day["instances"][0], "00080020"), "same study date, other patient")
        duplicate = copy.deepcopy(current)
        extra = copy.deepcopy(duplicate["instances"][0])
        extra["00080018"] = {"vr": "UI", "Value": ["1.2.826.0.1.3680043.10.99.1"]}
        duplicate["instances"].append(extra)
        p_same, p_later, p_dup = run_model(["plan", {"institution": "H1", "studies": [current, same_day]}],
                                           ["plan", {"institution": "H1", "studies": [current, later]}],
                                           ["plan", {"institution": "H1", "studies": [duplicate]}])
        for p in (p_same, p_later):
            self.assertEqual(p["prior"]["status"], "refused", "MG04: another patient's study is no prior, whatever its date")
            self.assertTrue(all(p["slots"]["prior|%s|%s|conventional" % (s, v)]["status"] == "refused" for s in "RL" for v in ("CC", "MLO")))
        key = "current|%s|%s|conventional" % (header_laterality(dataset(CMMD_VIEWS[0])), header_view(dataset(CMMD_VIEWS[0])))
        self.assertEqual(p_dup["slots"][key]["status"], "ambiguous", "MG04: a duplicate view is not resolved silently")
        self.assertEqual(len(p_dup["slots"][key]["candidates"]), 2)

    def test_mg05_real_pixels_keep_their_orientation_and_grayscale(self):
        for sample_id in CMMD_VIEWS + DBT_OBJECTS:
            ds = dataset(sample_id, pixels=True)
            pixels = ds.pixel_array
            frame = 1
            if pixels.ndim == 3:
                frame = pixels.shape[0] // 2 + 1
                pixels = pixels[frame - 1]
            (spec,) = run_model(["displaySpec", dicom_json(dataset(sample_id)), frame])
            self.assertEqual(spec["orientation"]["status"], "verified", sample_id)
            stored_side = chest_wall_side(pixels)
            shown_side = chest_wall_side(displayed(pixels, spec))
            laterality = header_laterality(ds)
            self.assertEqual(shown_side, "right" if laterality == "R" else "left",
                             "MG05: right breast chest wall at screen right, left at screen left: " + sample_id)
            self.assertEqual(stored_side, shown_side, "MG05: an image already in standard orientation is not flipped: " + sample_id)
            self.assertEqual((spec["rows"], spec["columns"]), pixels.shape)
            self.assertFalse(spec["invert"], sample_id)
            shown = voi(pixels.astype(np.float64) * spec["modality"]["slope"] + spec["modality"]["intercept"],
                        spec["voi"]["center"], spec["voi"]["width"], spec["voi"]["fn"])
            background = pixels <= np.percentile(pixels, 5)
            low = np.percentile(pixels, 5)
            tissue = pixels > low + 0.1 * (pixels.max() - low)
            self.assertLess(shown[background].mean(), 0.25 * 255, "MG05: air stays dark with the stored VOI: " + sample_id)
            self.assertGreater(shown[tissue].mean() - shown[background].mean(), 20, "MG05: tissue is brighter than air: " + sample_id)
            # Fit: the whole stored matrix inside a portrait cell, touching one side.
            (scale,) = run_model(["fitScale", {"width": 400, "height": 480}, {"rows": spec["rows"], "columns": spec["columns"]}])
            self.assertLessEqual(spec["columns"] * scale, 400 + 1e-6, "MG05: Fit shows the whole width")
            self.assertLessEqual(spec["rows"] * scale, 480 + 1e-6, "MG05: Fit shows the whole height")
            self.assertTrue(abs(spec["columns"] * scale - 400) < 1e-6 or abs(spec["rows"] * scale - 480) < 1e-6)

    def test_mg05_mirrored_unlabelled_and_monochrome1_copies_are_handled_from_their_tags(self):
        pixels = dataset("cmmd-d2-0140-1", pixels=True).pixel_array
        mirrored = dicom_json(dataset("cmmd-d2-0140-1"))
        mirrored["00200020"] = {"vr": "CS", "Value": ["A", "L"]}
        unlabelled = dicom_json(dataset("cmmd-d2-0140-1"))
        del unlabelled["00200020"]
        processing = dataset("ea1141-8036458-1")
        self.assertEqual(str(processing.PhotometricInterpretation), "MONOCHROME1")
        s_mirror, s_unlabelled, s_processing = run_model(["displaySpec", mirrored, 1], ["displaySpec", unlabelled, 1], ["displaySpec", dicom_json(processing), 1])
        self.assertTrue(s_mirror["orientation"]["flipH"], "a copy stored mirrored is turned back from its Patient Orientation")
        self.assertEqual(chest_wall_side(displayed(pixels[:, ::-1], s_mirror)), "right", "MG05: the mirrored copy shows the chest wall at the right")
        self.assertEqual(s_unlabelled["orientation"]["status"], "unverified")
        self.assertFalse(s_unlabelled["orientation"]["flipH"] or s_unlabelled["orientation"]["flipV"], "MG05: no orientation, no guessed flip")
        self.assertTrue(s_processing["invert"], "MONOCHROME1 is shown inverted, once")
        self.assertNotIn("presentation-lut-conflict", s_processing["issues"])


if __name__ == "__main__":
    unittest.main()
