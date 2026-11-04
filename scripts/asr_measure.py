#!/usr/bin/env python3
"""Korean/clinical dictation measurement: utterance set -> pinned whisper.cpp -> CER, WER, term misses.

Moved from the 2026-10-29 internal measurement (score.py) into the product repository for order
CD-15. The scoring rules are the frozen ones of that run (scoring-spec.json, kept here as
scripts/asr_measure_aihub208_scoring.json); nothing here adds a new rule or a pass threshold.

What this measures: the pinned engine and model on the given audio, sent in the same form
AsrService sends (16 kHz mono PCM16 WAV, response_format=json, language). It does not run the
browser capture path, the KIN API, a real microphone or a physician's acceptance.

Refusals, before any audio is read for transcription or reaches the engine:
  exit 2  the set has no "no patient information" declaration, is malformed, or its files do not
          match their listed hashes;
  exit 3  the engine commit or the model SHA-256 is not the pinned one.
Exit 1 means some utterance did not complete; it is reported, never scored as correct.

Audio and reference transcripts stay outside the repository (dataset terms); the set lists paths
and hashes, and --root says where the files are on the measuring host.
"""

from __future__ import annotations

import argparse
import collections
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import secrets
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
import asr_fixture  # noqa: E402  (the repository's pinned resampler and wire WAV writer)
from asr_engine_attest import PINS as ATTESTED_PINS  # noqa: E402

SET_SCHEMA = "kin-asr-measure-set/1"
# The fixed engine and model of this tool are the attested product pins; a run on anything else
# is refused rather than reported under the wrong identity.
PINS = {"engine_commit": ATTESTED_PINS["engine_commit"], "model_sha256": ATTESTED_PINS["model_sha256"]}
# Mirrors api/src/asr.service.ts: the response cap and the form fields, in its order.
RESPONSE_CAP = 131072
REQUEST_FIELDS = ["file", "response_format", "language"]
ACCEPTANCE = {"threshold": None, "status": "NOT_SET",
              "note": "합격 기준값은 정해지지 않았다(정모·민훈 결정 전까지 비움). 이 결과는 합격·불합격 판정이 아니다."}


class Refusal(Exception):
    def __init__(self, code: int, problems: list):
        super().__init__("; ".join(problems))
        self.code = code
        self.problems = problems


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def text_given(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


# ------------------------------------------------------------------------------- set contract

def declaration_problems(manifest) -> list:
    """The set must state, in its own field, that its audio holds no patient information."""
    declared = manifest.get("patient_information") if isinstance(manifest, dict) else None
    if not isinstance(declared, dict):
        return ["patient_information declaration is missing: the set must declare "
                "{\"declaration\": \"none\", \"declared_by\": ..., \"basis\": ...}"]
    problems = []
    if declared.get("declaration") != "none":
        problems.append("patient_information.declaration is {!r}, not \"none\"".format(declared.get("declaration")))
    for field in ("declared_by", "basis"):
        if not text_given(declared.get(field)):
            problems.append("patient_information.{} is empty".format(field))
    return problems


def safe_relative(path) -> bool:
    if not text_given(path) or "\\" in path or ":" in path:
        return False
    pure = PurePosixPath(path)
    return not pure.is_absolute() and ".." not in pure.parts


def set_problems(manifest) -> list:
    if not isinstance(manifest, dict):
        return ["set is not a JSON object"]
    problems = []
    if manifest.get("schema") != SET_SCHEMA:
        problems.append("schema is {!r}, not {!r}".format(manifest.get("schema"), SET_SCHEMA))
    if not text_given(manifest.get("set_id")):
        problems.append("set_id is empty")
    if not re.fullmatch(r"[a-z]{2,3}", str(manifest.get("language", ""))):
        problems.append("language must be a fixed two- or three-letter code, not auto-detection")
    limits = manifest.get("interpretation_limits")
    if not isinstance(limits, list) or not limits or not all(text_given(x) for x in limits):
        problems.append("interpretation_limits must list what the set cannot show")
    field = manifest.get("label_reference_field")
    items = manifest.get("items")
    if not isinstance(items, list) or not items:
        return problems + ["items is empty"]
    seen = set()
    for index, item in enumerate(items):
        where = "items[{}]".format(index)
        if not isinstance(item, dict) or not text_given(item.get("id")):
            problems.append(where + ".id is empty")
            continue
        if item["id"] in seen:
            problems.append(where + ".id {!r} is repeated".format(item["id"]))
        seen.add(item["id"])
        if not text_given(item.get("group")):
            problems.append(where + ".group is empty")
        if not safe_relative(item.get("audio")):
            problems.append(where + ".audio is not a relative path inside --root")
        if not re.fullmatch(r"[0-9a-f]{64}", str(item.get("audio_sha256", ""))):
            problems.append(where + ".audio_sha256 is missing")
        if "reference" in item:
            if not text_given(item["reference"]):
                problems.append(where + ".reference is empty")
        elif not safe_relative(item.get("label")) or not re.fullmatch(r"[0-9a-f]{64}", str(item.get("label_sha256", ""))):
            problems.append(where + " has neither a reference nor a hashed label path")
        elif not isinstance(field, list) or not field or not all(text_given(x) for x in field):
            problems.append("label_reference_field is required when items reference label files")
    return problems


def load_set(path: Path) -> dict:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise Refusal(2, ["cannot read the set: {}".format(error)])
    # The declaration is checked first and on its own: without it nothing else of the set is used.
    problems = declaration_problems(manifest)
    if problems:
        raise Refusal(2, problems)
    problems = set_problems(manifest)
    if problems:
        raise Refusal(2, problems)
    return manifest


def resolve_inputs(manifest: dict, root: Path) -> list:
    """Read every listed file once, check its hash, and take the reference text. All or nothing."""
    resolved, problems = [], []
    for item in manifest["items"]:
        audio_path = root.joinpath(*PurePosixPath(item["audio"]).parts)
        try:
            audio = audio_path.read_bytes()
        except OSError as error:
            problems.append("{}: cannot read audio: {}".format(item["id"], error))
            continue
        if sha256_bytes(audio) != item["audio_sha256"]:
            problems.append("{}: audio_sha256 does not match {}".format(item["id"], item["audio"]))
            continue
        reference = item.get("reference")
        if reference is None:
            label_path = root.joinpath(*PurePosixPath(item["label"]).parts)
            try:
                label = label_path.read_bytes()
            except OSError as error:
                problems.append("{}: cannot read label: {}".format(item["id"], error))
                continue
            if sha256_bytes(label) != item["label_sha256"]:
                problems.append("{}: label_sha256 does not match {}".format(item["id"], item["label"]))
                continue
            try:
                value = json.loads(label.decode("utf-8-sig"))
            except ValueError as error:
                problems.append("{}: label is not JSON: {}".format(item["id"], error))
                continue
            for key in manifest["label_reference_field"]:
                value = value.get(key) if isinstance(value, dict) else None
            if not text_given(value):
                problems.append("{}: label has no reference text at {}".format(
                    item["id"], "/".join(manifest["label_reference_field"])))
                continue
            reference = value
        resolved.append({"item": item, "audio": audio, "reference": reference})
    if problems:
        raise Refusal(2, problems)
    return resolved


# ----------------------------------------------------------------------- frozen scoring rules

def tokens(text: str) -> list:
    """NFC, lowercase, Unicode letter/number runs; punctuation and '_' separate words."""
    return re.findall(r"[^\W_]+", unicodedata.normalize("NFC", text).lower(), flags=re.UNICODE)


def distance(a, b) -> int:
    old = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        new = [i]
        for j, y in enumerate(b, 1):
            new.append(min(new[-1] + 1, old[j] + 1, old[j - 1] + (x != y)))
        old = new
    return old[-1]


def ratio(a, b):
    return a / b if a is not None and b else None


def term_matcher(terms: list):
    if not terms:
        return None
    return re.compile("|".join(re.escape(t) for t in sorted(terms, key=lambda t: (-len(t), t))))


def score_utterance(reference: str, hypothesis: str, terms: list, matcher=None) -> dict:
    ref, hyp = tokens(reference), tokens(hypothesis)
    ref_text, hyp_text = "".join(ref), "".join(hyp)
    matcher = matcher if matcher is not None else term_matcher(terms)
    ref_terms = collections.Counter(matcher.findall(ref_text)) if matcher else collections.Counter()
    hyp_terms = collections.Counter(matcher.findall(hyp_text)) if matcher else collections.Counter()
    found = [{"term": term, "reference_count": ref_terms[term], "hypothesis_count": hyp_terms[term],
              "hits": min(ref_terms[term], hyp_terms[term])} for term in terms if ref_terms[term]]
    character_edits, word_edits = distance(ref_text, hyp_text), distance(ref, hyp)
    return {"normalised_reference": " ".join(ref), "normalised_hypothesis": " ".join(hyp),
            "character_edits": character_edits, "reference_characters": len(ref_text),
            "CER": ratio(character_edits, len(ref_text)),
            "word_edits": word_edits, "reference_words": len(ref), "WER": ratio(word_edits, len(ref)),
            "terms": found,
            "medical_term_hits": sum(t["hits"] for t in found),
            "medical_term_reference_occurrences": sum(t["reference_count"] for t in found)}


def summarize(rows: list) -> dict:
    """Micro-averaged over completed utterances; failures are counted apart, never as correct."""
    ok = [r["score"] for r in rows if r["completed"]]
    total = {key: sum(s[key] for s in ok) for key in (
        "character_edits", "reference_characters", "word_edits", "reference_words",
        "medical_term_hits", "medical_term_reference_occurrences")}
    return {"selected": len(rows), "successful": len(ok), "failed_or_not_run": len(rows) - len(ok), **total,
            "CER": ratio(total["character_edits"], total["reference_characters"]),
            "WER": ratio(total["word_edits"], total["reference_words"]),
            "medical_term_recall": ratio(total["medical_term_hits"], total["medical_term_reference_occurrences"])}


def per_term(rows: list, terms: list) -> dict:
    result = {}
    for term in terms:
        found = [t for r in rows if r["completed"] for t in r["score"]["terms"] if t["term"] == term]
        occurrences = sum(t["reference_count"] for t in found)
        hits = sum(t["hits"] for t in found)
        result[term] = {"reference_occurrences": occurrences, "hits": hits, "recall": ratio(hits, occurrences)}
    return result


def term_errors(rows: list) -> list:
    """The clinical-term error list: every reference term occurrence the hypothesis did not carry."""
    return [{"id": r["id"], "group": r["group"], "term": t["term"], "reference_count": t["reference_count"],
             "hypothesis_count": t["hypothesis_count"], "missed": t["reference_count"] - t["hits"],
             "reference": r["reference"], "hypothesis": r["hypothesis"]}
            for r in rows if r["completed"] for t in r["score"]["terms"] if t["hits"] < t["reference_count"]]


def literal_ascii(rows: list) -> dict:
    """The former [a-z]+ normalisation, reported as the spec asks; undefined, not zero, with no words."""
    ok = [r for r in rows if r["completed"]]
    ref = [re.findall(r"[a-z]+", r["reference"].lower()) for r in ok]
    hyp = [re.findall(r"[a-z]+", r["hypothesis"].lower()) for r in ok]
    count = sum(len(x) for x in ref)
    return {"reference_ascii_word_count": count, "hypothesis_ascii_word_count": sum(len(x) for x in hyp),
            "rate": ratio(sum(distance(a, b) for a, b in zip(ref, hyp)), count),
            "note": "[a-z]+ leaves no Korean word; the rate is undefined when the reference count is zero"}


# ---------------------------------------------------------------------------------- the engine

def multipart(fields: list) -> tuple:
    boundary = "kin-asr-measure-" + secrets.token_hex(16)
    body = bytearray()
    for name, value, filename, content_type in fields:
        body += "--{}\r\n".format(boundary).encode()
        disposition = 'form-data; name="{}"'.format(name)
        if filename:
            disposition += '; filename="{}"'.format(filename)
        body += "Content-Disposition: {}\r\n".format(disposition).encode()
        if content_type:
            body += "Content-Type: {}\r\n".format(content_type).encode()
        body += b"\r\n" + value + b"\r\n"
    body += "--{}--\r\n".format(boundary).encode()
    return bytes(body), "multipart/form-data; boundary=" + boundary


def transcribe(url: str, wav: bytes, language: str, timeout: float) -> dict:
    """One /inference request; accepted on the same conditions AsrService accepts an answer."""
    body, content_type = multipart([("file", wav, "dictation.wav", "audio/wav"),
                                    ("response_format", b"json", None, None),
                                    ("language", language.encode(), None, None)])
    request = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": content_type})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, raw = response.status, response.read(RESPONSE_CAP + 1)
    except urllib.error.HTTPError as error:
        return {"status": error.code, "error": "engine HTTP {}".format(error.code),
                "seconds": time.monotonic() - started}
    except (OSError, urllib.error.URLError) as error:
        return {"status": None, "error": "{}: {}".format(type(error).__name__, error),
                "seconds": time.monotonic() - started}
    seconds = time.monotonic() - started
    if len(raw) > RESPONSE_CAP:
        return {"status": status, "error": "response above {} bytes".format(RESPONSE_CAP), "seconds": seconds}
    try:
        text = json.loads(raw.decode("utf-8")).get("text")
    except (ValueError, AttributeError):
        text = None
    if status != 200 or not isinstance(text, str) or not text.strip():
        return {"status": status, "error": "no transcript text in the engine answer", "seconds": seconds}
    return {"status": status, "text": text, "seconds": seconds}


def pin_problems(provenance: dict, model: dict) -> list:
    problems = []
    commit = ((provenance or {}).get("source") or {}).get("commit")
    if commit != PINS["engine_commit"]:
        problems.append("engine commit {!r} is not the pinned {}".format(commit, PINS["engine_commit"]))
    if model.get("sha256") != PINS["model_sha256"]:
        problems.append("model SHA-256 {!r} is not the pinned {}".format(model.get("sha256"), PINS["model_sha256"]))
    return problems


def checkout_identity() -> dict:
    """The product commit the tool ran from, when it runs inside a git checkout."""
    root = Path(__file__).resolve().parents[1]
    try:
        head = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True,
                              timeout=30, stdin=subprocess.DEVNULL)
        dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"],
                               capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as error:
        return {"commit": None, "error": str(error)}
    if head.returncode:
        return {"commit": None, "error": head.stderr.strip()}
    return {"commit": head.stdout.strip(), "tracked_changes": dirty.stdout.splitlines() if not dirty.returncode else None}


# ------------------------------------------------------------------------------------- the run

def measure(manifest: dict, inputs: list, terms: list, engine_url: str, timeout: float) -> list:
    matcher = term_matcher(terms)
    rows = []
    for entry in inputs:
        item = entry["item"]
        row = {"id": item["id"], "group": item["group"], "speaker": item.get("speaker"),
               "audio": item["audio"], "audio_sha256": item["audio_sha256"], "reference": entry["reference"]}
        try:
            converted = asr_fixture.build_fixture(entry["audio"])
        except asr_fixture.FixtureError as error:
            row.update(completed=False, error="audio conversion: {}".format(error), hypothesis=None, score=None)
            rows.append(row)
            continue
        wav = converted["wav"]
        row["source_audio"] = {"seconds": converted["source"]["seconds"], "format": converted["source"]["format"]}
        row["wire_audio"] = {"sha256": sha256_bytes(wav), "seconds": converted["fixture"]["seconds"],
                             "clipped_samples": converted["resampler"]["clipped_samples"]}
        answer = transcribe(engine_url, wav, manifest["language"], timeout)
        row["engine_status"] = answer["status"]
        row["request_seconds"] = answer["seconds"]
        if "text" in answer:
            row.update(completed=True, hypothesis=answer["text"],
                       score=score_utterance(entry["reference"], answer["text"], terms, matcher))
        else:
            row.update(completed=False, error=answer["error"], hypothesis=None, score=None)
        rows.append(row)
        print("asr_measure: {}/{} {} {}".format(len(rows), len(inputs), item["id"],
                                                "ok" if row["completed"] else "FAILED"), flush=True)
    return rows


def resampler_record(rows: list) -> dict:
    """Conversion settings without the per-file rates; the first converted row stands for all."""
    record = {"source_file": "scripts/asr_fixture.py",
              "sha256": sha256_bytes(Path(asr_fixture.__file__).read_bytes()),
              "target": {"sample_rate": asr_fixture.TARGET_SAMPLE_RATE, "channels": asr_fixture.TARGET_CHANNELS,
                         "bits_per_sample": asr_fixture.TARGET_BITS}}
    rates = sorted({r["source_audio"]["format"]["sample_rate"] for r in rows if "source_audio" in r})
    record["source_sample_rates"] = rates
    if rates:
        record["resampler"] = asr_fixture.resample([0, 0], rates[0], asr_fixture.TARGET_SAMPLE_RATE)["algorithm"]
    return record


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--set", required=True, help="utterance set JSON (paths, hashes, declaration)")
    parser.add_argument("--root", required=True, help="directory the set's relative paths resolve against")
    parser.add_argument("--scoring", required=True, help="frozen scoring spec JSON (its 'terms' list)")
    parser.add_argument("--engine-url", required=True, help="whisper.cpp POST /inference URL")
    parser.add_argument("--engine-provenance", required=True, help="the engine image's baked /kin-provenance.json")
    parser.add_argument("--engine-command", required=True, help="JSON array: the engine server argv as started")
    parser.add_argument("--engine-image-id", default=None, help="docker image ID of the running engine")
    parser.add_argument("--model", required=True, help="the model file the engine was started with")
    parser.add_argument("--output", required=True, help="result JSON to write")
    parser.add_argument("--timeout", type=float, default=120.0, help="per-request seconds (AsrService default)")
    args = parser.parse_args(argv)
    started = utc_now()
    try:
        set_path = Path(args.set)
        manifest = load_set(set_path)
        try:
            scoring_bytes = Path(args.scoring).read_bytes()
            scoring = json.loads(scoring_bytes.decode("utf-8"))
            terms = scoring["terms"]
            command = json.loads(args.engine_command)
            provenance = json.loads(Path(args.engine_provenance).read_text(encoding="utf-8"))
            model_path = Path(args.model)
            model = {"path": str(model_path.resolve()), "bytes": model_path.stat().st_size,
                     "sha256": sha256_file(model_path)}
        except (OSError, ValueError, KeyError) as error:
            raise Refusal(2, ["cannot read run inputs: {}".format(error)])
        if not isinstance(terms, list) or not all(text_given(t) for t in terms):
            raise Refusal(2, ["scoring terms must be a list of non-empty strings"])
        if not isinstance(command, list) or not all(isinstance(x, str) for x in command):
            raise Refusal(2, ["--engine-command must be a JSON array of strings"])
        problems = pin_problems(provenance, model)
        if problems:
            raise Refusal(3, problems)
        inputs = resolve_inputs(manifest, Path(args.root))
    except Refusal as refusal:
        for problem in refusal.problems:
            print("asr_measure: {}".format(problem), file=sys.stderr)
        print("asr_measure: refusing to run", file=sys.stderr)
        return refusal.code

    rows = measure(manifest, inputs, terms, args.engine_url, args.timeout)
    groups = sorted({r["group"] for r in rows})
    summary = {"all": summarize(rows), "by_group": {g: summarize([r for r in rows if r["group"] == g]) for g in groups}}
    failures = [{"id": r["id"], "error": r["error"]} for r in rows if not r["completed"]]
    result = {
        "status": "MEASURED" if not failures else "MEASUREMENT_INCOMPLETE",
        "started_utc": started, "finished_utc": utc_now(),
        "set_id": manifest["set_id"],
        "patient_information": manifest["patient_information"],
        "interpretation_limits": manifest["interpretation_limits"],
        "acceptance": dict(ACCEPTANCE),
        "tool": {"file": "scripts/asr_measure.py", "sha256": sha256_bytes(Path(__file__).read_bytes()),
                 "checkout": checkout_identity(), "python": platform.python_version(),
                 "host": {"system": platform.system(), "machine": platform.machine(), "cpu_count": os.cpu_count()}},
        "inputs": {"set": str(set_path), "set_sha256": sha256_bytes(set_path.read_bytes()),
                   "scoring": args.scoring, "scoring_sha256": sha256_bytes(scoring_bytes),
                   "root": str(Path(args.root).resolve()), "source": manifest.get("source")},
        "engine": {"commit": provenance["source"]["commit"], "provenance": provenance,
                   "image_id": args.engine_image_id, "server_command": command, "url": args.engine_url,
                   "request": {"fields": list(REQUEST_FIELDS), "response_format": "json",
                               "language": manifest["language"]},
                   "timeout_seconds": args.timeout},
        "model": {**model, "pinned_sha256": PINS["model_sha256"]},
        "audio_conversion": resampler_record(rows),
        "scoring": {"rules": {k: v for k, v in scoring.items() if k != "terms"}, "terms": terms,
                    "averaging": "micro-averaged over completed utterances; failures are listed and never scored"},
        "summary": summary,
        "per_term": per_term(rows, terms),
        "term_errors": term_errors(rows),
        "literal_ascii": literal_ascii(rows),
        "failures": failures,
        "utterances": rows,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")

    def pct(value):
        return "N/A" if value is None else "{:.2f}%".format(100 * value)
    for name, group in [("all", summary["all"]), *summary["by_group"].items()]:
        print("asr_measure: {} {}/{} CER {} WER {} terms {}/{} recall {}".format(
            name, group["successful"], group["selected"], pct(group["CER"]), pct(group["WER"]),
            group["medical_term_hits"], group["medical_term_reference_occurrences"],
            pct(group["medical_term_recall"])))
    print("asr_measure: engine {} model {} status {} -> {}".format(
        result["engine"]["commit"], model["sha256"], result["status"], output))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
