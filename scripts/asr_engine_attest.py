#!/usr/bin/env python3
"""Record the ASR engine, model and fixture used by the acceptance run.

Engine provenance is diagnostic metadata. Audio format and fixture identity are checked
here; the real-engine acceptance suite checks language, quality, latency and failure.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

# Accepted S3-ASR-U0b experiment references (engine-pin-card.json), retained for attribution.
PINS = {
    "engine_name": "whisper.cpp",
    "engine_tag": "v1.9.4",
    "engine_tag_object": "7d75b14994ae7f59623e2471445e2355fe506ed2",
    "engine_commit": "927cfce34f31707e17f2bff35c349632fb9e2c3a",
    "engine_api": "POST /inference",
    "model_repo": "ggerganov/whisper.cpp",
    "model_revision": "5359861c739e955e79d9a303bcbc70fb988958b1",
    "model_file": "ggml-small.bin",
    "model_bytes": 487601967,
    "model_sha256": "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    "generator_name": "espeak-ng",
    "generator_tag": "1.52.0",
    "generator_sentence": "The blue square is next to the green circle.",
}

HEX64 = re.compile(r"^[0-9a-f]{64}$")
HF_RESOLVE = re.compile(r"^https://huggingface\.co/(?P<repo>[^/]+/[^/]+)/resolve/"
                        r"(?P<revision>[^/]+)/(?P<file>[^/?#]+)$")

IMAGES_NOTE = ("built-image IDs from `docker image inspect` (plus any RepoDigests, empty for a "
               "local build); base-image digests are NOT recorded")
MODEL_REVISION_NOTE = ("repo, revision and file are parsed from the --model-source-url the "
                       "workflow declares it fetched; this is not a revision observed from Hugging "
                       "Face. Model size and SHA-256 are observations, not an executable certification gate")


def model_source(url: str) -> dict:
    """What the declared fetch URL names. Unparseable URLs name nothing, which then fails."""
    match = HF_RESOLVE.match(url or "")
    if not match:
        return {"repo": None, "revision": None, "file": None}
    return match.groupdict()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run(command: list) -> str:
    result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, shell=False, timeout=300)
    if result.returncode != 0:
        raise RuntimeError("{} failed ({}): {}".format(
            " ".join(command), result.returncode, result.stderr.decode("utf-8", "replace").strip()))
    return result.stdout.decode("utf-8", "replace")


def image_identity(reference: str) -> dict:
    """Actual local image identity. A locally built image has no RepoDigest; record that."""
    entries = json.loads(run(["docker", "image", "inspect", reference]))
    if not entries:
        raise RuntimeError("no image inspect output for {}".format(reference))
    entry = entries[0]
    return {"reference": reference, "id": entry.get("Id"),
            "repo_digests": entry.get("RepoDigests") or [],
            "repo_tags": entry.get("RepoTags") or [],
            "created": entry.get("Created"),
            "labels": (entry.get("Config") or {}).get("Labels") or {}}


def baked_provenance(reference: str, path: str = "/kin-provenance.json") -> dict:
    """Read the build-time record baked into an image. `cat` only; no engine is started."""
    text = run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "cat",
                reference, path])
    return json.loads(text)


def evaluate(record: dict) -> list:
    """Pure check of an assembled record. Returns the list of named problems."""
    problems = []
    pins = record.get("pins") or {}

    fixture = record.get("fixture") or {}
    validator = record.get("validator") or {}
    if not HEX64.match(str(fixture.get("sha256", ""))):
        problems.append("fixture SHA-256 is missing or malformed")
    if fixture.get("sha256") != validator.get("sha256"):
        problems.append("validated bytes {!r} are not the fixture {!r}".format(
            validator.get("sha256"), fixture.get("sha256")))
    fixture_file = record.get("fixture_file") or {}
    if fixture_file.get("sha256") != fixture.get("sha256"):
        problems.append("fixture file on disk {!r} is not the reported fixture {!r}".format(
            fixture_file.get("sha256"), fixture.get("sha256")))
    raw_wav = (record.get("generator") or {}).get("raw_wav") or {}
    if not HEX64.match(str(raw_wav.get("sha256", ""))):
        problems.append("generator raw WAV SHA-256 is missing or malformed")
    elif raw_wav.get("sha256") != (record.get("fixture_source") or {}).get("sha256"):
        problems.append("canonicalized source {!r} is not the generator raw WAV {!r}".format(
            (record.get("fixture_source") or {}).get("sha256"), raw_wav.get("sha256")))
    verdict = validator.get("result") or {}
    if verdict.get("ok") is not True:
        problems.append("shipped validator rejected the fixture: {!r}".format(verdict))
    else:
        if verdict.get("sampleRate") != 16000 or verdict.get("channels") != 1 \
                or verdict.get("bitsPerSample") != 16:
            problems.append("validated format is not 16000/1/16: {!r}".format(verdict))
        if verdict.get("frames") != fixture.get("frames"):
            problems.append("validator frames {!r} != fixture frames {!r}".format(
                verdict.get("frames"), fixture.get("frames")))
    generated = (record.get("generator") or {}).get("command") or []
    if pins.get("generator_sentence") not in generated:
        problems.append("the pinned non-clinical sentence is not in the recorded generator command")

    for name in ("engine", "generator", "api"):
        image = (record.get("images") or {}).get(name) or {}
        if not image.get("id"):
            problems.append("image identity for {} was not recorded".format(name))
    return problems


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine-image", required=True)
    parser.add_argument("--generator-image", required=True)
    parser.add_argument("--api-image", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-source-url", required=True)
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--fixture-report", required=True)
    parser.add_argument("--validator-report", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    try:
        fixture_report = json.loads(Path(args.fixture_report).read_text(encoding="utf-8"))
        validator_report = json.loads(Path(args.validator_report).read_text(encoding="utf-8"))
        model_path = Path(args.model)
        fixture_path = Path(args.fixture)
        source = model_source(args.model_source_url)
        record = {
            "unit": "S3-ASR-U3",
            "generated_at_utc": utc_now(),
            "engine_started": False,
            "note": ("configured ASR_ENGINE_PIN/ASR_MODEL_PIN labels are not attestation; "
                     "this record is the separate runtime evidence"),
            "pins": dict(PINS),
            "images_note": IMAGES_NOTE,
            "images": {
                "engine": image_identity(args.engine_image),
                "generator": image_identity(args.generator_image),
                "api": image_identity(args.api_image),
            },
            "engine_provenance": baked_provenance(args.engine_image),
            "generator_provenance": baked_provenance(args.generator_image),
            "model": {
                "path": str(model_path.resolve()),
                "repo": source["repo"],
                "file": source["file"],
                "revision": source["revision"],
                "revision_note": MODEL_REVISION_NOTE,
                "source_url": args.model_source_url,
                "bytes": model_path.stat().st_size,
                "sha256": sha256_file(model_path),
                "expected_bytes": PINS["model_bytes"],
                "expected_sha256": PINS["model_sha256"],
            },
            "fixture_file": {
                "path": str(fixture_path.resolve()),
                "bytes": fixture_path.stat().st_size,
                "sha256": sha256_file(fixture_path),
            },
            "fixture": fixture_report.get("fixture", {}),
            "fixture_source": fixture_report.get("source", {}),
            "resampler": fixture_report.get("resampler", {}),
            "generator": fixture_report.get("generator", {}),
            "validator": validator_report,
        }
    except (OSError, ValueError, RuntimeError) as error:
        print("asr_engine_attest: cannot assemble attestation: {}".format(error), file=sys.stderr)
        return 2

    problems = evaluate(record)
    record["problems"] = problems
    record["status"] = "ATTESTED" if not problems else "UNRESOLVED"
    with Path(args.output).open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(record, stream, ensure_ascii=True, indent=2, sort_keys=True)
        stream.write("\n")
    if problems:
        for problem in problems:
            print("asr_engine_attest: {}".format(problem), file=sys.stderr)
        print("asr_engine_attest: refusing to start the engine with unresolved pins",
              file=sys.stderr)
        return 3
    print("attested engine={} model={} fixture={}".format(
        record["engine_provenance"]["source"]["commit"], record["model"]["sha256"],
        record["fixture"]["sha256"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
