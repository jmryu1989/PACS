#!/usr/bin/env python3
"""Pure byte/control tests for the S3-ASR-U3 fixture path and the pre-engine attestation.

Entirely synthetic: the "audio" here is arithmetic (constants and sine tables), never a
recording, never speech, never a file fetched from anywhere. No engine, model, container,
network or audio device is involved, so this file runs anywhere the repository is checked out.

It does NOT prove the hosted path. The shipped compiled validator verdict, the engine build,
the model hash and the transcript all come from the hosted `asr-engine` job.
"""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import asr_fixture as fixture_module
import asr_engine_attest as attest_module


def chunk(identifier: bytes, body: bytes) -> bytes:
    padded = body + (b"\x00" if len(body) % 2 else b"")
    return identifier + struct.pack("<I", len(body)) + padded


def source_wav(samples, rate=22050, channels=1, bits=16, format_tag=1, extra=b"", fmt_body=None):
    if fmt_body is None:
        block_align = channels * (bits // 8)
        fmt_body = struct.pack("<HHIIHH", format_tag, channels, rate,
                               rate * block_align, block_align, bits)
    data = struct.pack("<{}h".format(len(samples)), *samples)
    body = b"WAVE" + chunk(b"fmt ", fmt_body) + extra + chunk(b"data", data)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def sine(frequency, rate, seconds, amplitude=12000):
    count = int(rate * seconds)
    return [int(round(amplitude * math.sin(2 * math.pi * frequency * n / rate)))
            for n in range(count)]


def rms(values):
    if not values:
        return 0.0
    return math.sqrt(sum(float(v) * float(v) for v in values) / len(values))


def middle(values, keep=0.6):
    margin = int(len(values) * (1 - keep) / 2)
    return values[margin:len(values) - margin]


def decode(wav: bytes):
    count = (len(wav) - fixture_module.CANONICAL_HEADER_BYTES) // 2
    return list(struct.unpack_from("<{}h".format(count), wav,
                                   fixture_module.CANONICAL_HEADER_BYTES))


def shipped_wire_check(wav: bytes):
    """Oracle mirroring api/src/dictation-audio.ts. The authoritative run of the real compiled
    validator is tests/asr_fixture_validate.cjs inside kin-api:ci; this only keeps the pure
    tests honest about the layout they claim to produce."""
    problems = []
    if len(wav) < 46:
        problems.append("shorter than 46 bytes")
        return problems
    if wav[0:4] != b"RIFF" or wav[8:12] != b"WAVE" or wav[12:16] != b"fmt ":
        problems.append("not RIFF/WAVE/fmt")
    if struct.unpack_from("<I", wav, 4)[0] != len(wav) - 8:
        problems.append("RIFF size is not total-8")
    format_bytes = struct.unpack_from("<I", wav, 16)[0]
    if format_bytes not in (16, 18):
        problems.append("fmt chunk is {} bytes".format(format_bytes))
        return problems
    tag, channels, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", wav, 20)
    if (tag, channels, rate, byte_rate, align, bits) != (1, 1, 16000, 32000, 2, 16):
        problems.append("format is {}".format((tag, channels, rate, byte_rate, align, bits)))
    data_header = 20 + format_bytes
    if wav[data_header:data_header + 4] != b"data":
        problems.append("no data chunk at {}".format(data_header))
        return problems
    data_bytes = struct.unpack_from("<I", wav, data_header + 4)[0]
    if data_bytes == 0 or data_bytes % 2 or data_bytes != len(wav) - (data_header + 8):
        problems.append("data chunk is empty, odd or not the tail")
    return problems


class FixtureShapeTests(unittest.TestCase):
    def test_01_canonical_output_matches_the_shipped_wire_format(self):
        built = fixture_module.build_fixture(source_wav(sine(1000, 22050, 0.25)))
        self.assertEqual(shipped_wire_check(built["wav"]), [])
        self.assertEqual(built["fixture"]["sample_rate"], 16000)
        self.assertEqual(built["fixture"]["channels"], 1)
        self.assertEqual(built["fixture"]["bits_per_sample"], 16)
        self.assertEqual(built["fixture"]["bytes"], 44 + built["fixture"]["frames"] * 2)
        self.assertEqual(built["fixture"]["seconds"], built["fixture"]["frames"] / 16000)
        self.assertEqual(built["fixture"]["data_bytes"], built["fixture"]["frames"] * 2)

    def test_02_frame_count_follows_the_exact_rational_ratio(self):
        samples = sine(1000, 22050, 0.25)
        built = fixture_module.build_fixture(source_wav(samples))
        # 22050 -> 16000 reduces to 441 -> 320 exactly.
        self.assertEqual(built["resampler"]["up"], 320)
        self.assertEqual(built["resampler"]["down"], 441)
        self.assertEqual(built["fixture"]["frames"], ((len(samples) - 1) * 320) // 441 + 1)

    def test_03_identical_input_produces_identical_bytes(self):
        source = source_wav(sine(440, 22050, 0.2))
        first = fixture_module.build_fixture(source)
        second = fixture_module.build_fixture(source)
        self.assertEqual(first["wav"], second["wav"])
        self.assertEqual(first["fixture"]["sha256"], second["fixture"]["sha256"])
        self.assertEqual(first["source"]["sha256"], second["source"]["sha256"])

    def test_04_provenance_names_the_resampler_and_the_source(self):
        built = fixture_module.build_fixture(source_wav(sine(440, 22050, 0.2)))
        self.assertEqual(built["resampler"]["source_file"], "scripts/asr_fixture.py")
        self.assertEqual(built["resampler"]["kind"], "polyphase-windowed-sinc")
        self.assertEqual(built["resampler"]["window"], "blackman")
        self.assertEqual(built["resampler"]["phase_normalization"], "unit-sum")
        self.assertEqual(len(built["resampler"]["sha256"]), 64)
        self.assertEqual(built["source"]["format"]["sample_rate"], 22050)
        self.assertEqual(built["fixture"]["max_bytes"], 1048576)

    def test_05_already_canonical_rate_passes_samples_through_unchanged(self):
        samples = sine(1000, 16000, 0.1)
        built = fixture_module.build_fixture(source_wav(samples, rate=16000))
        self.assertEqual(built["resampler"]["kind"], "passthrough")
        self.assertEqual(decode(built["wav"]), samples)

    def test_06_extra_and_padded_chunks_in_the_generator_output_are_tolerated(self):
        extra = chunk(b"LIST", b"INFOISFT" + b"espeak-ng") + chunk(b"fact", b"\x01\x02\x03")
        built = fixture_module.build_fixture(source_wav(sine(440, 22050, 0.1), extra=extra))
        self.assertEqual(shipped_wire_check(built["wav"]), [])
        identifiers = [entry["id"] for entry in built["source"]["chunks"]]
        self.assertIn("LIST", identifiers)
        self.assertIn("fact", identifiers)

    def test_07_extensible_pcm_source_is_accepted_and_other_tags_are_not(self):
        body = struct.pack("<HHIIHH", 0xFFFE, 1, 22050, 44100, 2, 16) + struct.pack("<H", 22) \
            + struct.pack("<HI", 16, 3) + struct.pack("<H", 1) + b"\x00" * 14
        built = fixture_module.build_fixture(
            source_wav(sine(440, 22050, 0.05), format_tag=0xFFFE, fmt_body=body))
        self.assertEqual(shipped_wire_check(built["wav"]), [])
        float_body = struct.pack("<HHIIHH", 3, 1, 22050, 88200, 4, 32)
        with self.assertRaises(fixture_module.FixtureError):
            fixture_module.read_source_wav(
                source_wav(sine(440, 22050, 0.05), format_tag=3, fmt_body=float_body))


class FixtureRefusalTests(unittest.TestCase):
    def refuse(self, data, fragment):
        with self.assertRaises(fixture_module.FixtureError) as caught:
            fixture_module.read_source_wav(data)
        self.assertIn(fragment, str(caught.exception))

    def test_08_named_refusals_instead_of_silent_coercion(self):
        samples = sine(440, 22050, 0.05)
        self.refuse(b"not a wave at all", "not a RIFF/WAVE")
        self.refuse(source_wav(samples * 2, channels=2), "channels")
        eight_bit = struct.pack("<HHIIHH", 1, 1, 22050, 22050, 1, 8)
        self.refuse(source_wav(samples, bits=8, fmt_body=eight_bit), "8-bit")
        self.refuse(b"RIFF" + struct.pack("<I", 4) + b"WAVE", "no fmt chunk")
        self.refuse(b"RIFF" + struct.pack("<I", 28) + b"WAVE"
                    + chunk(b"fmt ", struct.pack("<HHIIHH", 1, 1, 22050, 44100, 2, 16)),
                    "no data chunk")
        truncated = source_wav(samples)[:-40]
        self.refuse(truncated, "truncated")
        empty = b"WAVE" + chunk(b"fmt ", struct.pack("<HHIIHH", 1, 1, 22050, 44100, 2, 16)) \
            + chunk(b"data", b"")
        self.refuse(b"RIFF" + struct.pack("<I", len(empty)) + empty, "empty")
        odd_rate = struct.pack("<HHIIHH", 1, 1, 1000, 2000, 2, 16)
        self.refuse(source_wav(samples, rate=1000, fmt_body=odd_rate), "sample rate")

    def test_09_the_dictation_ceiling_is_a_refusal_not_a_truncation(self):
        with self.assertRaises(fixture_module.FixtureError) as caught:
            fixture_module.canonical_wav([1] * 1000, max_bytes=100)
        self.assertIn("above the 100 byte dictation ceiling", str(caught.exception))
        with self.assertRaises(fixture_module.FixtureError):
            fixture_module.canonical_wav([])
        exact = fixture_module.canonical_wav([1] * 28, max_bytes=100)
        self.assertEqual(len(exact), 100)
        self.assertEqual(shipped_wire_check(exact), [])


class ResamplerSignalTests(unittest.TestCase):
    """The resampler is repository-owned, so its behaviour is asserted here rather than taken
    on trust from a package version that could drift between hosted runs."""

    def test_10_constant_input_keeps_its_level(self):
        built = fixture_module.build_fixture(source_wav([5000] * 4000))
        body = middle(decode(built["wav"]))
        self.assertTrue(body)
        self.assertLessEqual(max(abs(value - 5000) for value in body), 2)

    def test_11_a_passband_tone_keeps_its_energy(self):
        samples = sine(1000, 22050, 0.5)
        built = fixture_module.build_fixture(source_wav(samples))
        before = rms(middle(samples))
        after = rms(middle(decode(built["wav"])))
        self.assertGreater(after, before * 0.95)
        self.assertLess(after, before * 1.05)

    def test_12_a_tone_above_the_new_nyquist_is_removed_rather_than_aliased(self):
        samples = sine(10000, 22050, 0.5)
        built = fixture_module.build_fixture(source_wav(samples))
        before = rms(middle(samples))
        after = rms(middle(decode(built["wav"])))
        # Without band-limiting this would fold to 6000 Hz at nearly full amplitude.
        self.assertLess(after, before * 0.05, "10 kHz survived the 8 kHz cutoff")

    def test_13_full_scale_input_is_clamped_and_the_clamping_is_recorded(self):
        samples = sine(200, 22050, 0.2, amplitude=32767)
        built = fixture_module.build_fixture(source_wav(samples))
        body = decode(built["wav"])
        self.assertLessEqual(max(body), 32767)
        self.assertGreaterEqual(min(body), -32768)
        self.assertIn("clipped_samples", built["resampler"])
        self.assertEqual(built["resampler"]["rounding"], "floor(x + 0.5), clamped to int16")


def attested_record():
    return {
        "pins": dict(attest_module.PINS),
        "images": {name: {"id": "sha256:{}".format(name)} for name in ("engine", "generator", "api")},
        "engine_provenance": {
            "source": {"tag": "v1.9.4",
                       "tag_object": attest_module.PINS["engine_tag_object"],
                       "commit": attest_module.PINS["engine_commit"],
                       "files": dict(attest_module.ENGINE_SOURCE_FILES)},
            "binary": {"path": "/src/whisper.cpp/build/bin/whisper-server", "sha256": "b" * 64},
        },
        "generator_provenance": {"source": {"tag": "1.52.0", "commit": "c" * 40}},
        "model": {"bytes": attest_module.PINS["model_bytes"],
                  "sha256": attest_module.PINS["model_sha256"],
                  "expected_bytes": attest_module.PINS["model_bytes"],
                  "expected_sha256": attest_module.PINS["model_sha256"],
                  "revision": attest_module.PINS["model_revision"]},
        "fixture": {"sha256": "d" * 64, "frames": 48000},
        "generator": {"command": ["espeak-ng", "-v", "en-us", "-s", "150", "-w",
                                  "espeak-raw.wav", attest_module.PINS["generator_sentence"]]},
        "validator": {"sha256": "d" * 64,
                      "result": {"ok": True, "sampleRate": 16000, "channels": 1,
                                 "bitsPerSample": 16, "frames": 48000}},
    }


class AttestationTests(unittest.TestCase):
    def test_14_a_complete_consistent_record_has_no_problems(self):
        self.assertEqual(attest_module.evaluate(attested_record()), [])

    def test_15_every_pin_mismatch_is_named_and_blocking(self):
        cases = [
            (["engine_provenance", "source", "commit"], "0" * 40, "engine source commit"),
            (["engine_provenance", "source", "tag_object"], "0" * 40, "annotated tag object"),
            (["engine_provenance", "binary", "sha256"], "not-a-hash", "engine binary SHA-256"),
            (["model", "sha256"], "e" * 64, "model computed SHA-256"),
            (["model", "bytes"], 12345, "model size"),
            (["model", "revision"], "0" * 40, "model revision"),
            (["generator_provenance", "source", "tag"], "1.51", "generator tag"),
            (["generator_provenance", "source", "commit"], None, "generator resolved commit"),
            (["validator", "sha256"], "f" * 64, "are not the fixture"),
            (["validator", "result", "ok"], False, "validator rejected"),
            (["validator", "result", "sampleRate"], 44100, "not 16000/1/16"),
            (["validator", "result", "frames"], 7, "validator frames"),
            (["fixture", "sha256"], "short", "fixture SHA-256 is missing or malformed"),
            (["images", "engine", "id"], None, "image identity for engine"),
            (["generator", "command"], ["espeak-ng", "-w", "x.wav"], "pinned non-clinical sentence"),
        ]
        for path, value, fragment in cases:
            with self.subTest(path=path):
                record = attested_record()
                target = record
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                problems = attest_module.evaluate(record)
                self.assertTrue(any(fragment in problem for problem in problems),
                                "{} did not produce {!r}: {}".format(path, fragment, problems))

    def test_16_missing_sections_do_not_crash_the_check(self):
        problems = attest_module.evaluate({"pins": dict(attest_module.PINS)})
        self.assertTrue(problems)
        self.assertTrue(any("engine source commit" in problem for problem in problems))
        self.assertTrue(any("model computed SHA-256" in problem for problem in problems))

    def test_17_source_file_notes_are_reported_but_never_block(self):
        record = attested_record()
        notes = attest_module.source_file_notes(record)
        self.assertEqual(len(notes), len(attest_module.ENGINE_SOURCE_FILES))
        self.assertTrue(all(note["matches"] for note in notes))
        drifted = copy.deepcopy(record)
        drifted["engine_provenance"]["source"]["files"]["src/whisper.cpp"] = "0" * 64
        notes = attest_module.source_file_notes(drifted)
        self.assertFalse(all(note["matches"] for note in notes))
        # The commit hash already binds the tree, so a snapshot difference is a note only.
        self.assertEqual(attest_module.evaluate(drifted), [])

    def test_18_the_accepted_u0b_pins_are_carried_verbatim(self):
        self.assertEqual(attest_module.PINS["engine_commit"],
                         "927cfce34f31707e17f2bff35c349632fb9e2c3a")
        self.assertEqual(attest_module.PINS["engine_tag"], "v1.9.4")
        self.assertEqual(attest_module.PINS["model_revision"],
                         "5359861c739e955e79d9a303bcbc70fb988958b1")
        self.assertEqual(attest_module.PINS["model_bytes"], 487601967)
        self.assertEqual(attest_module.PINS["model_sha256"],
                         "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b")
        self.assertEqual(attest_module.PINS["generator_tag"], "1.52.0")
        self.assertEqual(attest_module.PINS["generator_sentence"],
                         "The blue square is next to the green circle.")
        self.assertEqual(json.loads(json.dumps(attest_module.PINS)), attest_module.PINS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
