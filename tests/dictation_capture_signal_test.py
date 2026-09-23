# coding: utf-8
"""TEST-S3-ASR-U4b-SIGNAL: pure positive and negative controls for the U4b produced-byte oracles.

REQ-S3-ASR-FIRST-PATH -> RISK-S3-ASR-FALSE-CAPTURE / RISK-S3-ASR-FORMAT -> TEST-S3-ASR-U4b-CAPTURE
(this file is its pure half; tests/report_dictation_capture_dom_test.py is the browser half).

SIG-01 fixture pin and rounding margin, SIG-02 the fixture passes U2/U3/U4, SIG-03..SIG-11 each
failure mode is rejected with its named reason: silence, 48 kHz / 44.1 kHz / stereo / byte-swapped
bytes labelled 16 kHz mono, one tone, header mutants, fmt 18 (a producer-layout check, not
validator parity), and the length family (trailing byte, odd data, above maxBytes).

Standard library only: `python3 -B tests/dictation_capture_signal_test.py`.
"""
import math
from pathlib import Path
import struct
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dictation_capture_signal as signal  # noqa: E402
from asr_fixture import read_source_wav  # noqa: E402  (on the path through the module above)


def tones(rate, frames, frequencies=signal.TONES):
    """The fixture's tones as a device running at `rate` would have produced them."""
    return [math.floor(sum(signal.AMPLITUDE * math.sin(2 * math.pi * f * n / rate) for f in frequencies) + 0.5)
            for n in range(frames)]


def wav(samples):
    return signal.canonical_wav(samples)


def patch(data, offset, fmt, value):
    out = bytearray(data)
    struct.pack_into(fmt, out, offset, value)
    return bytes(out)


SHORT = 32000       # 2.0 s at the labelled rate: two analysis windows


class DictationCaptureSignalTest(unittest.TestCase):
    def rejected(self, data, reason, max_bytes=signal.MAX_BYTES):
        verdict = signal.judge(data, max_bytes)
        self.assertFalse(verdict["ok"], verdict)
        found = verdict["layout"]["reasons"] + verdict["signal"]["reasons"]
        self.assertIn(reason, found, verdict)
        return verdict

    def test_sig01_the_fixture_regenerates_to_its_pin_with_a_rounding_margin(self):
        first, second = signal.fixture_wav(), signal.fixture_wav()
        self.assertEqual(first, second)
        self.assertEqual(signal.FIXTURE_SHA256, signal.sha256(first))
        self.assertEqual(signal.FIXTURE_BYTES, len(first))
        self.assertEqual(192044, len(first))
        margin = signal.rounding_margin()
        self.assertGreater(margin, signal.ROUNDING_MARGIN)
        samples = signal.samples_of(first)
        self.assertEqual(signal.FIXTURE_FRAMES, len(samples))
        self.assertEqual(samples[:signal.PERIOD] * (signal.FIXTURE_FRAMES // signal.PERIOD), samples,
                         "600 identical periods: the fake device's loop point is seamless")
        self.assertLessEqual(max(abs(v) for v in samples), 2 * signal.AMPLITUDE, "no clipping")
        # The generator refuses rather than rounds a value sitting on a .5 edge.
        with mock.patch.object(signal, "period_values", return_value=[0.5] * signal.PERIOD):
            with self.assertRaises(signal.SignalError):
                signal.fixture_samples()
        print("SIG-01 sha256=%s margin=%r" % (signal.FIXTURE_SHA256, margin))

    def test_sig02_the_fixture_passes_the_layout_mirror_and_the_spectral_oracle(self):
        verdict = signal.judge(signal.fixture_wav())
        self.assertTrue(verdict["ok"], verdict)
        self.assertEqual([], verdict["layout"]["reasons"])
        self.assertEqual(signal.FIXTURE_FRAMES, verdict["layout"]["frames"])
        windows = verdict["signal"]["windows"]
        self.assertEqual(11, len(windows), "0.30 s .. 5.80 s in whole 0.5 s windows")
        for row in windows:
            self.assertAlmostEqual(0.25, row["rms_fs"], places=3)
            self.assertAlmostEqual(0.5, row["tone_700"], places=3)
            self.assertAlmostEqual(0.5, row["tone_1900"], places=3)
            # The 44.1 kHz decoy sits 5.3 bins from 700 Hz; its leakage is the smallest margin here.
            self.assertLess(max(row["decoys"].values()), signal.DECOY_MAX, row)
        print("SIG-02 worst decoy fraction %.6f" % max(max(r["decoys"].values()) for r in windows))
        self.assertFalse(verdict["signal"]["all_zero"])
        # A read of the producer layout with a generic lenient reader agrees on the format.
        self.assertEqual({"channels": 1, "sample_rate": 16000, "bits_per_sample": 16},
                         {k: read_source_wav(signal.fixture_wav())["format"][k]
                          for k in ("channels", "sample_rate", "bits_per_sample")})

    def test_sig03_silence_is_rejected(self):
        verdict = self.rejected(wav([0] * SHORT), "rms-low")
        self.assertIn("all-zero", verdict["signal"]["reasons"])
        self.assertEqual([], verdict["layout"]["reasons"], "a well-formed header does not rescue silence")

    def test_sig04_tones_captured_at_48k_but_labelled_16k_are_rejected(self):
        self.rejected(wav(tones(48000, SHORT)), "decoy-48k")

    def test_sig05_tones_captured_at_44k1_but_labelled_16k_are_rejected(self):
        self.rejected(wav(tones(44100, SHORT)), "decoy-44k1")

    def test_sig06_stereo_interleaved_but_labelled_mono_is_rejected(self):
        mono = tones(signal.FS, SHORT // 2)
        interleaved = [value for sample in mono for value in (sample, sample)]
        self.rejected(wav(interleaved), "decoy-stereo")

    def test_sig07_byte_swapped_samples_are_rejected(self):
        good = signal.fixture_wav()
        body = bytearray(good[44:])
        body[0::2], body[1::2] = good[45::2], good[44::2]
        swapped = good[:44] + bytes(body)
        self.assertEqual([], signal.producer_layout(swapped)["reasons"])
        self.rejected(swapped, "tone-fraction")

    def test_sig08_one_tone_only_is_rejected(self):
        self.rejected(wav(tones(signal.FS, SHORT, (700,))), "tone-1900-low")

    def test_sig09_header_mutants_are_each_rejected_with_their_own_reason(self):
        good = wav(tones(signal.FS, SHORT))
        self.assertEqual([], signal.producer_layout(good)["reasons"])
        length = len(good)
        for label, data, reasons in (
                ("channels 2", patch(good, 22, "<H", 2), ["channels"]),
                ("rate 48000", patch(good, 24, "<I", 48000), ["sample-rate"]),
                ("byteRate", patch(good, 28, "<I", 96000), ["byte-rate"]),
                ("blockAlign", patch(good, 32, "<H", 4), ["block-align"]),
                ("bits 8", patch(good, 34, "<H", 8), ["bits"]),
                ("format tag 3", patch(good, 20, "<H", 3), ["format-tag"]),
                ("RIFF size +1", patch(good, 4, "<I", length - 7), ["riff-size"]),
                ("RIFF size -1", patch(good, 4, "<I", length - 9), ["riff-size"]),
                ("data size +2", patch(good, 40, "<I", length - 42), ["data-size"]),
                ("RIFF magic", b"RIFX" + good[4:], ["riff-magic"]),
                ("WAVE magic", good[:8] + b"AVI " + good[12:], ["wave-magic"]),
                ("data id", good[:36] + b"LIST" + good[40:], ["data-id"])):
            with self.subTest(label):
                self.assertEqual(reasons, signal.producer_layout(data)["reasons"])
                self.assertFalse(signal.judge(data)["ok"])

    def test_sig10_fmt18_is_refused_as_a_producer_layout_check_not_validator_parity(self):
        pcm = struct.pack("<%dh" % SHORT, *tones(signal.FS, SHORT))
        fmt18 = (b"RIFF" + struct.pack("<I", 4 + 26 + 8 + len(pcm)) + b"WAVEfmt " +
                 struct.pack("<IHHIIHHH", 18, 1, 1, 16000, 32000, 2, 16, 0) + b"data" + struct.pack("<I", len(pcm)) + pcm)
        # Well formed for a lenient reader (and accepted by the shipped validator, dictation-audio.ts:36,43)...
        parsed = read_source_wav(fmt18)
        self.assertEqual((1, 16000, 16, 18), (parsed["format"]["channels"], parsed["format"]["sample_rate"],
                                              parsed["format"]["bits_per_sample"], parsed["format"]["fmt_bytes"]))
        # ...but not what dictation-capture.js:11-19 writes, so the mirror refuses it.
        self.assertEqual(["fmt-size"], signal.producer_layout(fmt18)["reasons"])
        self.assertFalse(signal.judge(fmt18)["ok"])

    def test_sig11_trailing_bytes_odd_data_and_length_above_max_bytes_are_rejected(self):
        good = wav(tones(signal.FS, SHORT))
        length = len(good)
        consistent_trailing = patch(good + b"\x00", 4, "<I", length + 1 - 8)
        self.assertEqual(["trailing-bytes"], signal.producer_layout(consistent_trailing)["reasons"])
        self.assertEqual(["riff-size", "trailing-bytes"], signal.producer_layout(good + b"\x00")["reasons"])
        odd = patch(patch(good + b"\x00", 4, "<I", length + 1 - 8), 40, "<I", length + 1 - 44)
        self.assertEqual(["data-odd"], signal.producer_layout(odd)["reasons"])
        empty = patch(patch(good[:44], 4, "<I", 36), 40, "<I", 0)
        self.assertEqual(["data-empty"], signal.producer_layout(empty)["reasons"])
        self.assertEqual(["too-short"], signal.producer_layout(good[:43])["reasons"])
        for data, reason in ((consistent_trailing, "trailing-bytes"), (odd, "data-odd"), (empty, "data-empty")):
            self.rejected(data, reason)
        # The CAP-03 cap: 16000 frames fill maxBytes 32044 exactly; one more frame is above it.
        capped = wav(tones(signal.FS, 16000))
        self.assertEqual(32044, len(capped))
        self.assertEqual([], signal.producer_layout(capped, 32044)["reasons"])
        self.assertEqual(["too-large"], signal.producer_layout(wav(tones(signal.FS, 16001)), 32044)["reasons"])
        self.rejected(signal.fixture_wav(), "too-large", max_bytes=signal.FIXTURE_BYTES - 2)
        self.assertTrue(signal.judge(signal.fixture_wav(), signal.FIXTURE_BYTES)["ok"])


if __name__ == "__main__":
    program = unittest.main(verbosity=2, exit=False)
    cases = sorted(n for n in dir(DictationCaptureSignalTest) if n.startswith("test_sig"))
    if [c[:10] for c in cases] != ["test_sig%02d" % n for n in range(1, len(cases) + 1)] or len(cases) != 11:
        print("SIG ids must stay dense: SIG-01..SIG-11", file=sys.stderr)
        sys.exit(1)
    sys.exit(0 if program.result.wasSuccessful() else 1)
