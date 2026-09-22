#!/usr/bin/env python3
"""S3-ASR-U3 runtime attestation, recorded and checked BEFORE the engine is started.

`ASR_ENGINE_PIN` / `ASR_MODEL_PIN` in api/src/asr.service.ts are configured attribution
labels. They are not evidence that a particular engine build or model file did the work.
This script produces the separate evidence: the actual image identities, the engine source
commit that was really checked out and built, the generator identity, the model file's
expected and computed SHA-256 and size, and the fixture's provenance and validator verdict.

It exits non-zero on any mismatch, so the workflow never reaches `docker run` for the
engine with an unresolved pin. No engine process is started here: the only container use is
`cat` of a provenance file baked into an image at build time.
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

# Accepted S3-ASR-U0b pins (engine-pin-card.json). Literals, so drift fails loudly.
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

# Cross-check only. `git rev-parse HEAD == engine_commit` already binds the whole tree, so a
# difference here is reported as a note for review rather than as a gate: these are the SHA-256
# values of the official text snapshots recorded in astra-source-pins.json.
ENGINE_SOURCE_FILES = {
    "examples/server/server.cpp":
        "903bf6a6904301a698e0db79c0a72f25bca5bc7c3953b493eb09a68683e53356",
    "examples/server/README.md":
        "d6a953253065ce2b3252c18286ef2a2f14be8f09804564c25c6d9fb3bb8acb4b",
    "examples/common-whisper.cpp":
        "852fbc77d2461322a82b9c571cf4703bac3c78c5c51d3a90e80792ce0c04e313",
    "src/whisper.cpp":
        "c48686fbc2cba1b0ac0f9c8e964188c691e67fff5906f2629f3223ff64f92d16",
}

HEX64 = re.compile(r"^[0-9a-f]{64}$")


def source_file_notes(record: dict) -> list:
    """Compare the built tree's files with the cached official snapshots. Never blocking."""
    actual = (((record.get("engine_provenance") or {}).get("source") or {}).get("files") or {})
    notes = []
    for name, expected in sorted(ENGINE_SOURCE_FILES.items()):
        notes.append({"file": name, "expected_sha256": expected,
                      "actual_sha256": actual.get(name),
                      "matches": actual.get(name) == expected})
    return notes


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

    engine = (record.get("engine_provenance") or {})
    engine_source = engine.get("source") or {}
    if engine_source.get("commit") != pins.get("engine_commit"):
        problems.append("engine source commit {!r} != pinned {!r}".format(
            engine_source.get("commit"), pins.get("engine_commit")))
    if engine_source.get("tag") != pins.get("engine_tag"):
        problems.append("engine source tag {!r} != pinned {!r}".format(
            engine_source.get("tag"), pins.get("engine_tag")))
    if engine_source.get("tag_object") != pins.get("engine_tag_object"):
        problems.append("engine annotated tag object {!r} != pinned {!r}".format(
            engine_source.get("tag_object"), pins.get("engine_tag_object")))
    binary = engine.get("binary") or {}
    if not HEX64.match(str(binary.get("sha256", ""))):
        problems.append("engine binary SHA-256 is missing or malformed")
    if not binary.get("path"):
        problems.append("engine binary path was not recorded")

    generator = (record.get("generator_provenance") or {})
    generator_source = generator.get("source") or {}
    if generator_source.get("tag") != pins.get("generator_tag"):
        problems.append("generator tag {!r} != pinned {!r}".format(
            generator_source.get("tag"), pins.get("generator_tag")))
    if not generator_source.get("commit"):
        problems.append("generator resolved commit was not recorded")

    model = record.get("model") or {}
    if model.get("bytes") != pins.get("model_bytes"):
        problems.append("model size {!r} != pinned {!r}".format(
            model.get("bytes"), pins.get("model_bytes")))
    if model.get("sha256") != pins.get("model_sha256"):
        problems.append("model computed SHA-256 {!r} != pinned {!r}".format(
            model.get("sha256"), pins.get("model_sha256")))
    if model.get("revision") != pins.get("model_revision"):
        problems.append("model revision {!r} != pinned {!r}".format(
            model.get("revision"), pins.get("model_revision")))

    fixture = record.get("fixture") or {}
    validator = record.get("validator") or {}
    if not HEX64.match(str(fixture.get("sha256", ""))):
        problems.append("fixture SHA-256 is missing or malformed")
    if fixture.get("sha256") != validator.get("sha256"):
        problems.append("validated bytes {!r} are not the fixture {!r}".format(
            validator.get("sha256"), fixture.get("sha256")))
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
        record = {
            "unit": "S3-ASR-U3",
            "generated_at_utc": utc_now(),
            "engine_started": False,
            "note": ("configured ASR_ENGINE_PIN/ASR_MODEL_PIN labels are not attestation; "
                     "this record is the separate runtime evidence"),
            "pins": dict(PINS),
            "images": {
                "engine": image_identity(args.engine_image),
                "generator": image_identity(args.generator_image),
                "api": image_identity(args.api_image),
            },
            "engine_provenance": baked_provenance(args.engine_image),
            "generator_provenance": baked_provenance(args.generator_image),
            "model": {
                "path": str(model_path.resolve()),
                "file": PINS["model_file"],
                "revision": PINS["model_revision"],
                "source_url": args.model_source_url,
                "bytes": model_path.stat().st_size,
                "sha256": sha256_file(model_path),
                "expected_bytes": PINS["model_bytes"],
                "expected_sha256": PINS["model_sha256"],
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

    record["source_file_notes"] = source_file_notes(record)
    problems = evaluate(record)
    record["problems"] = problems
    for note in record["source_file_notes"]:
        if not note["matches"]:
            print("asr_engine_attest: NOTE {} is {} not the cached snapshot {}".format(
                note["file"], note["actual_sha256"], note["expected_sha256"]), file=sys.stderr)
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
