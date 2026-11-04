#!/usr/bin/env python3
"""Pure tests for the Korean/clinical dictation measurement tool (scripts/asr_measure.py).

Entirely synthetic: the sentences are written here, the audio is arithmetic (a tone), and the
"engine" is a localhost stub that answers the whisper.cpp /inference form. No recording, model,
container or dataset is involved. The real pinned engine and the AI Hub 208 baseline run on the
rehearsal VM and are reported in evidence, not here.
"""

from __future__ import annotations

import contextlib
import email.parser
import email.policy
import hashlib
import http.server
import io
import json
import math
from pathlib import Path
import struct
import sys
import tempfile
import threading
import unittest
from unittest import mock
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import asr_measure as measure  # noqa: E402

ENGINE_COMMIT = "1" * 40
MODEL_BYTES = b"synthetic model bytes, not a model"
MODEL_SHA = hashlib.sha256(MODEL_BYTES).hexdigest()
TERMS = ["고혈압", "혈압", "통증", "흉통"]


def tone_wav(rate=48000, seconds=0.5, frequency=440):
    frames = [int(8000 * math.sin(2 * math.pi * frequency * n / rate)) for n in range(int(rate * seconds))]
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(struct.pack("<{}h".format(len(frames)), *frames))
    return buffer.getvalue()


class Engine:
    """whisper.cpp /inference stand-in: records each form and answers from a script."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.forms = []
        engine = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                message = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
                    b"Content-Type: " + self.headers["Content-Type"].encode("latin-1") + b"\r\n\r\n" + body)
                form = {part.get_param("name", header="content-disposition"): part.get_payload(decode=True)
                        for part in message.iter_parts()}
                engine.forms.append({"path": self.path,
                                     "fields": sorted(form),
                                     "file": form.get("file"),
                                     "response_format": (form.get("response_format") or b"").decode(),
                                     "language": (form.get("language") or b"").decode()})
                status, body = engine.answers.pop(0)
                payload = json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:{}/inference".format(self.server.server_address[1])
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Workspace:
    """A synthetic utterance set on disk with the engine provenance and model it is pinned to."""

    def __init__(self, directory: Path, items, declaration=True):
        self.dir = directory
        self.root = directory / "data"
        (self.root / "audio").mkdir(parents=True)
        (self.root / "labels").mkdir()
        rows = []
        for item in items:
            audio = self.root / "audio" / (item["id"] + ".wav")
            audio.write_bytes(tone_wav())
            label = self.root / "labels" / (item["id"] + ".json")
            label.write_text(json.dumps({"전사정보": {"LabelText": item["reference"]}}, ensure_ascii=False),
                             encoding="utf-8-sig")
            rows.append({"id": item["id"], "group": item["group"], "speaker": "S1",
                         "audio": "audio/" + audio.name, "audio_sha256": measure.sha256_bytes(audio.read_bytes()),
                         "label": "labels/" + label.name, "label_sha256": measure.sha256_bytes(label.read_bytes())})
        self.manifest = {
            "schema": measure.SET_SCHEMA,
            "set_id": "synthetic-test",
            "language": "ko",
            "label_reference_field": ["전사정보", "LabelText"],
            "interpretation_limits": ["합성 시험 세트이며 어떤 성능도 보여 주지 않는다."],
            "items": rows,
        }
        if declaration:
            self.manifest["patient_information"] = {
                "declaration": "none", "declared_by": "test author",
                "basis": "sentences written for this test; tone audio"}
        self.scoring = directory / "scoring.json"
        self.scoring.write_text(json.dumps({"terms": TERMS}, ensure_ascii=False), encoding="utf-8")
        self.model = directory / "model.bin"
        self.model.write_bytes(MODEL_BYTES)
        self.provenance = directory / "provenance.json"
        self.provenance.write_text(json.dumps({"name": "whisper.cpp", "source": {"commit": ENGINE_COMMIT}}))
        self.output = directory / "out" / "result.json"
        self.write()

    def write(self):
        self.set_path = self.dir / "set.json"
        self.set_path.write_text(json.dumps(self.manifest, ensure_ascii=False), encoding="utf-8")

    def argv(self, url):
        return ["--set", str(self.set_path), "--root", str(self.root), "--scoring", str(self.scoring),
                "--engine-url", url, "--engine-provenance", str(self.provenance),
                "--engine-command", json.dumps(["whisper-server", "--threads", "4"]),
                "--engine-image-id", "sha256:" + "2" * 64,
                "--model", str(self.model), "--output", str(self.output)]


PINNED = mock.patch.dict(measure.PINS, {"engine_commit": ENGINE_COMMIT, "model_sha256": MODEL_SHA})


def run_main(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = measure.main(argv)
    return code, out.getvalue(), err.getvalue()


class ScoringTests(unittest.TestCase):
    """The frozen 2026-10-29 scoring rules (scoring-spec.json), on sentences written here."""

    def test_normalization_is_nfc_lowercase_letter_number_runs(self):
        decomposed = "한"  # 한 as conjoining jamo
        self.assertEqual(measure.tokens("Hello, " + decomposed + "국어!  CT-2번"),
                         ["hello", "한국어", "ct", "2번"])
        self.assertEqual(measure.tokens("snake_case"), ["snake", "case"])

    def test_levenshtein_on_characters_and_tokens(self):
        self.assertEqual(measure.distance("kitten", "sitting"), 3)
        self.assertEqual(measure.distance(["가", "나"], ["가", "다", "라"]), 2)
        self.assertEqual(measure.distance("", "abc"), 3)

    def test_cer_ignores_spaces_and_wer_counts_eojeol(self):
        row = measure.score_utterance("고혈압 약을 드시나요?", "고 혈압 약을 드시나요", TERMS)
        # Characters: 고혈압약을드시나요 both sides -> CER 0; eojeol: 3 reference vs 4 hypothesis tokens.
        self.assertEqual(row["character_edits"], 0)
        self.assertEqual(row["reference_characters"], 9)
        self.assertEqual(row["CER"], 0)
        self.assertEqual(row["word_edits"], 2)
        self.assertEqual(row["reference_words"], 3)
        self.assertAlmostEqual(row["WER"], 2 / 3)

    def test_terms_match_longest_first_without_overlap(self):
        # 고혈압 contains 혈압; the longer term wins, so 혈압 is not also credited.
        row = measure.score_utterance("고혈압이 있어요", "고요압이 있어요", TERMS)
        self.assertEqual(row["terms"], [{"term": "고혈압", "reference_count": 1, "hypothesis_count": 0, "hits": 0}])
        row = measure.score_utterance("고혈압이 있어요", "혈압이 있어요", TERMS)
        self.assertEqual(row["terms"], [{"term": "고혈압", "reference_count": 1, "hypothesis_count": 0, "hits": 0}])

    def test_term_hits_are_min_of_reference_and_hypothesis_occurrences(self):
        row = measure.score_utterance("통증 통증 흉통", "통증 통증 통증 통증", TERMS)
        by_term = {t["term"]: t for t in row["terms"]}
        self.assertEqual(by_term["통증"], {"term": "통증", "reference_count": 2, "hypothesis_count": 4, "hits": 2})
        self.assertEqual(by_term["흉통"], {"term": "흉통", "reference_count": 1, "hypothesis_count": 0, "hits": 0})
        self.assertEqual(row["medical_term_hits"], 2)
        self.assertEqual(row["medical_term_reference_occurrences"], 3)

    def test_empty_lexicon_scores_no_terms(self):
        row = measure.score_utterance("혈압", "혈압", [])
        self.assertEqual(row["terms"], [])
        self.assertEqual(row["medical_term_reference_occurrences"], 0)

    def test_summary_is_micro_averaged_and_never_counts_a_failure_as_correct(self):
        rows = [
            {"id": "a", "group": "x", "completed": True, "score": measure.score_utterance("가나다라", "가나다마", TERMS)},
            {"id": "b", "group": "x", "completed": True, "score": measure.score_utterance("통증 있어요", "통증 있어요", TERMS)},
            {"id": "c", "group": "y", "completed": False, "score": None},
        ]
        total = measure.summarize(rows)
        self.assertEqual((total["selected"], total["successful"], total["failed_or_not_run"]), (3, 2, 1))
        self.assertEqual(total["character_edits"], 1)
        self.assertEqual(total["reference_characters"], 4 + 5)
        self.assertAlmostEqual(total["CER"], 1 / 9)
        self.assertEqual((total["word_edits"], total["reference_words"]), (1, 3))
        self.assertEqual((total["medical_term_hits"], total["medical_term_reference_occurrences"]), (1, 1))
        self.assertEqual(total["medical_term_recall"], 1.0)
        nothing = measure.summarize([rows[2]])
        self.assertIsNone(nothing["CER"])
        self.assertIsNone(nothing["WER"])
        self.assertIsNone(nothing["medical_term_recall"])

    def test_term_errors_list_every_missed_reference_term(self):
        rows = [{"id": "a", "group": "clinician", "completed": True, "reference": "흉통과 통증",
                 "hypothesis": "통통과 통증",
                 "score": measure.score_utterance("흉통과 통증", "통통과 통증", TERMS)}]
        self.assertEqual(measure.term_errors(rows), [{
            "id": "a", "group": "clinician", "term": "흉통", "reference_count": 1, "hypothesis_count": 0,
            "missed": 1, "reference": "흉통과 통증", "hypothesis": "통통과 통증"}])

    def test_literal_ascii_rate_is_undefined_for_korean_references(self):
        literal = measure.literal_ascii([{"completed": True, "reference": "혈압", "hypothesis": "blood"}])
        self.assertEqual(literal["reference_ascii_word_count"], 0)
        self.assertEqual(literal["hypothesis_ascii_word_count"], 1)
        self.assertIsNone(literal["rate"])


class PatientDeclarationTests(unittest.TestCase):
    """Order CD-15 acceptance 3: no "no patient information" declaration, no run."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Workspace(Path(self.tmp.name), [{"id": "u1", "group": "clinician", "reference": "통증 있어요"}])
        self.engine = Engine([])
        self.addCleanup(self.engine.close)

    def refused(self):
        with PINNED:
            code, out, err = run_main(self.work.argv(self.engine.url))
        self.assertEqual(code, 2, err)
        self.assertEqual(self.engine.forms, [], "refusal must come before any audio reaches the engine")
        self.assertFalse(self.work.output.exists())
        return err

    def test_missing_declaration_is_refused(self):
        self.work.manifest.pop("patient_information")
        self.work.write()
        self.assertIn("patient_information", self.refused())

    def test_declaration_other_than_none_is_refused(self):
        for value in ["present", "None", "", None, "unknown"]:
            with self.subTest(value=value):
                self.work.manifest["patient_information"]["declaration"] = value
                self.work.write()
                self.refused()

    def test_declaration_without_declarer_or_basis_is_refused(self):
        for field in ["declared_by", "basis"]:
            for value in [None, "", "   "]:
                with self.subTest(field=field, value=value):
                    self.work.manifest["patient_information"] = {
                        "declaration": "none", "declared_by": "x", "basis": "y", field: value}
                    self.work.write()
                    self.refused()

    def test_declaration_must_be_an_object(self):
        self.work.manifest["patient_information"] = "none"
        self.work.write()
        self.refused()

    def test_audio_that_does_not_match_its_listed_hash_is_refused(self):
        (self.work.root / "audio" / "u1.wav").write_bytes(tone_wav(frequency=300))
        self.assertIn("audio_sha256", self.refused())

    def test_shipped_aihub_set_declares_no_patient_information_and_carries_no_transcript(self):
        manifest = json.loads((ROOT / "scripts" / "asr_measure_aihub208.json").read_text(encoding="utf-8"))
        self.assertEqual(measure.declaration_problems(manifest), [])
        self.assertEqual(measure.set_problems(manifest), [])
        self.assertEqual(len(manifest["items"]), 80)
        for item in manifest["items"]:
            self.assertNotIn("reference", item)
            self.assertFalse(item["audio"].startswith(("/", "\\")) or ".." in item["audio"].split("/"))


class EngineRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Workspace(Path(self.tmp.name), [
            {"id": "u1", "group": "clinician", "reference": "흉통이 심한가요?"},
            {"id": "u2", "group": "patient", "reference": "고혈압 약을 먹어요."},
        ])

    def run_engine(self, answers):
        engine = Engine(answers)
        self.addCleanup(engine.close)
        with PINNED:
            code, out, err = run_main(self.work.argv(engine.url))
        return engine, code, out, err

    def test_measures_through_the_engine_and_pins_the_run(self):
        engine, code, out, err = self.run_engine([(200, {"text": " 통통이 심한가요?"}),
                                                  (200, {"text": " 고혈압 약을 먹어요."})])
        self.assertEqual(code, 0, err)
        # The same form AsrService sends, with 16 kHz mono PCM16 converted by the pinned resampler.
        for form in engine.forms:
            self.assertEqual(form["path"], "/inference")
            self.assertEqual(form["fields"], ["file", "language", "response_format"])
            self.assertEqual((form["response_format"], form["language"]), ("json", "ko"))
            with wave.open(io.BytesIO(form["file"])) as sent:
                self.assertEqual((sent.getframerate(), sent.getnchannels(), sent.getsampwidth()), (16000, 1, 2))
        result = json.loads(self.work.output.read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "MEASURED")
        self.assertEqual(result["engine"]["commit"], ENGINE_COMMIT)
        self.assertEqual(result["engine"]["image_id"], "sha256:" + "2" * 64)
        self.assertEqual(result["engine"]["server_command"], ["whisper-server", "--threads", "4"])
        self.assertEqual(result["engine"]["request"], {"fields": ["file", "response_format", "language"],
                                                       "response_format": "json", "language": "ko"})
        self.assertEqual(result["model"]["sha256"], MODEL_SHA)
        self.assertEqual(result["model"]["bytes"], len(MODEL_BYTES))
        self.assertEqual(result["inputs"]["set_sha256"], measure.sha256_bytes(self.work.set_path.read_bytes()))
        self.assertEqual(result["inputs"]["scoring_sha256"], measure.sha256_bytes(self.work.scoring.read_bytes()))
        self.assertEqual(result["tool"]["sha256"],
                         measure.sha256_bytes((ROOT / "scripts" / "asr_measure.py").read_bytes()))
        self.assertEqual(result["audio_conversion"]["resampler"]["kind"], "polyphase-windowed-sinc")
        self.assertEqual(result["patient_information"]["declaration"], "none")
        self.assertIsNone(result["acceptance"]["threshold"])
        self.assertEqual(result["interpretation_limits"], self.work.manifest["interpretation_limits"])
        clinician = result["summary"]["by_group"]["clinician"]
        self.assertEqual((clinician["character_edits"], clinician["reference_characters"]), (1, 7))
        self.assertEqual(result["summary"]["all"]["successful"], 2)
        self.assertEqual(result["term_errors"], [{
            "id": "u1", "group": "clinician", "term": "흉통", "reference_count": 1, "hypothesis_count": 0,
            "missed": 1, "reference": "흉통이 심한가요?", "hypothesis": " 통통이 심한가요?"}])
        self.assertEqual(result["per_term"]["고혈압"], {"reference_occurrences": 1, "hits": 1, "recall": 1.0})
        self.assertNotIn("흉통", out, "stdout carries rates only, never transcripts")

    def test_engine_failure_is_reported_and_not_scored(self):
        engine, code, out, err = self.run_engine([(500, {"error": "x"}), (200, {"text": "고혈압 약을 먹어요"})])
        self.assertEqual(code, 1)
        result = json.loads(self.work.output.read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "MEASUREMENT_INCOMPLETE")
        self.assertEqual(result["summary"]["all"]["failed_or_not_run"], 1)
        self.assertEqual(result["summary"]["by_group"]["clinician"]["successful"], 0)
        self.assertIsNone(result["summary"]["by_group"]["clinician"]["CER"])
        self.assertEqual([u["id"] for u in result["utterances"] if not u["completed"]], ["u1"])

    def test_unpinned_engine_or_model_is_refused_before_any_audio_is_sent(self):
        engine = Engine([])
        self.addCleanup(engine.close)
        for pins in [{"engine_commit": "3" * 40, "model_sha256": MODEL_SHA},
                     {"engine_commit": ENGINE_COMMIT, "model_sha256": "4" * 64}]:
            with self.subTest(pins=pins), mock.patch.dict(measure.PINS, pins):
                code, out, err = run_main(self.work.argv(engine.url))
            self.assertEqual(code, 3, err)
        self.assertEqual(engine.forms, [])
        self.assertFalse(self.work.output.exists())


if __name__ == "__main__":
    unittest.main()
