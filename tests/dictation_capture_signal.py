# coding: utf-8
"""S3-ASR-U4b produced-byte oracles, standard library only.

Three things live here so the browser suite and its pure controls judge bytes with the same code:

* the synthetic fixture the fake microphone plays: two tones, 700 Hz and 1900 Hz, each 8192
  (0.25 FS), 16000 Hz mono, written through the shipped `scripts/asr_fixture.canonical_wav`;
* U2, a PRODUCER-LAYOUT MIRROR of the 44-byte header `dictation-capture.js:11-19` writes. It is
  stricter than the shipped validator, which also accepts fmt 18 with cbSize 0
  (`api/src/dictation-audio.ts:36,43`). It is not validator parity; the compiled validator's
  verdict belongs to S3-ASR-U4L G-LIVE-PATH;
* U3/U4, a spectral oracle on the produced samples. The requested `sampleRate` proves nothing;
  where the two tones land, and where they do not, is the 16 kHz / mono / PCM16 evidence.

No speech, recognition, engine, model, device or network is involved.
"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
import struct
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from asr_fixture import canonical_wav  # noqa: E402  (shared fixture writer, read-only reuse)

FS = 16000
TONES = (700, 1900)
AMPLITUDE = 8192
# 700/16000 = 7/160 and 1900/16000 = 19/160, so the sum repeats every 160 samples.
PERIOD = 160
FIXTURE_FRAMES = 96000               # 6.000 s = 600 periods: the fake device loops it seamlessly
FIXTURE_BYTES = 44 + 2 * FIXTURE_FRAMES
# Pinned from a local pure run of fixture_wav(); SIG-01 and CAP-00 regenerate and compare.
FIXTURE_SHA256 = "323ce208a50097e7da5cf0c0513b7248960800acd7048002bdc3a16b2ee248f4"
# Every value must sit this far from a .5 rounding edge, so a libm ULP difference cannot flip a sample.
ROUNDING_MARGIN = 1e-6

FULL_SCALE = 32768
MAX_BYTES = 1048576
HEADER_BYTES = 44
WINDOW = 8000                        # 0.5 s: both tones complete whole cycles (350 and 950)
SKIP_START = 4800                    # 0.30 s: device/graph start-up is not judged
SKIP_END = 1600                      # 0.10 s: nor is the stop edge
RMS_MIN = 0.05
TONE_SUM_MIN = 0.80
TONE_EACH_MIN = 0.25
DECOY_MAX = 0.01
# Where the two tones land for each way the produced bytes can be mislabelled as 16 kHz mono.
DECOYS = (
    ("48k", 700 * 16000 / 48000, 1900 * 16000 / 48000),   # captured at 48 kHz: 233.3 / 633.3
    ("44k1", 700 * 16000 / 44100, 1900 * 16000 / 44100),  # captured at 44.1 kHz: 254.0 / 689.3
    ("stereo", 350.0, 950.0),                              # two interleaved channels read as one
    ("8k", 1400.0, 3800.0),                                # captured at 8 kHz
)


class SignalError(Exception):
    """The fixture cannot be produced exactly; never recovered from."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def period_values():
    """The 160 real values of one period, before rounding."""
    return [AMPLITUDE * math.sin(2 * math.pi * TONES[0] * n / FS) +
            AMPLITUDE * math.sin(2 * math.pi * TONES[1] * n / FS) for n in range(PERIOD)]


def rounding_margin(values=None) -> float:
    return min(abs((v - math.floor(v)) - 0.5) for v in (values or period_values()))


def fixture_period():
    values = period_values()
    margin = rounding_margin(values)
    if not margin > ROUNDING_MARGIN:
        raise SignalError("a fixture value is within %g of a rounding edge (%r)" % (ROUNDING_MARGIN, margin))
    return [math.floor(v + 0.5) for v in values]


def fixture_samples():
    return fixture_period() * (FIXTURE_FRAMES // PERIOD)


def fixture_wav() -> bytes:
    return canonical_wav(fixture_samples())


def producer_layout(data: bytes, max_bytes: int = MAX_BYTES) -> dict:
    """U2. The exact header `dictation-capture.js:11-19` writes, and nothing else.

    Field problems are collected; a problem that moves every later offset (magic, fmt size,
    data id) stops the walk, because nothing after it can be read in place.
    """
    reasons = []
    length = len(data)
    result = {"length": length, "max_bytes": max_bytes, "frames": None, "data_bytes": None}
    if length < HEADER_BYTES:
        return dict(result, ok=False, reasons=["too-short"])
    if length > max_bytes:
        reasons.append("too-large")
    riff_size, = struct.unpack_from("<I", data, 4)
    fmt_size, tag, channels, rate, byte_rate, block_align, bits = struct.unpack_from("<IHHIIHH", data, 16)
    data_size, = struct.unpack_from("<I", data, 40)
    if data[0:4] != b"RIFF":
        return dict(result, ok=False, reasons=reasons + ["riff-magic"])
    if riff_size != length - 8:
        reasons.append("riff-size")
    if data[8:12] != b"WAVE":
        return dict(result, ok=False, reasons=reasons + ["wave-magic"])
    if data[12:16] != b"fmt ":
        return dict(result, ok=False, reasons=reasons + ["fmt-id"])
    if fmt_size != 16:
        # fmt 18 + cbSize 0 is valid for the server validator; the producer never writes it.
        return dict(result, ok=False, reasons=reasons + ["fmt-size"])
    for name, value, expected in (("format-tag", tag, 1), ("channels", channels, 1), ("sample-rate", rate, 16000),
                                  ("byte-rate", byte_rate, 32000), ("block-align", block_align, 2),
                                  ("bits", bits, 16)):
        if value != expected:
            reasons.append(name)
    if data[36:40] != b"data":
        return dict(result, ok=False, reasons=reasons + ["data-id"])
    available = length - HEADER_BYTES
    if data_size > available:
        reasons.append("data-size")
    elif data_size < available:
        reasons.append("trailing-bytes")
    if data_size % 2:
        reasons.append("data-odd")
    if data_size == 0:
        reasons.append("data-empty")
    result.update(data_bytes=data_size, frames=data_size // 2 if data_size <= available else None)
    return dict(result, ok=not reasons, reasons=reasons)


def samples_of(data: bytes):
    """The data region as little-endian int16, read as the header claims: 16 kHz mono."""
    body = data[HEADER_BYTES:]
    body = body[:len(body) - len(body) % 2]
    return list(struct.unpack("<%dh" % (len(body) // 2), body))


def tone_energy(window, frequency: float) -> float:
    """Goertzel: the energy one real sinusoid at `frequency` carries in `window` (Parseval units)."""
    coefficient = 2.0 * math.cos(2.0 * math.pi * frequency / FS)
    s1 = s2 = 0.0
    for value in window:
        s1, s2 = value + coefficient * s1 - s2, s1
    power = s1 * s1 + s2 * s2 - coefficient * s1 * s2
    return 2.0 * power / len(window)


def window_starts(frames: int):
    start, starts = SKIP_START, []
    while start + WINDOW <= frames - SKIP_END:
        starts.append(start)
        start += WINDOW
    return starts


def spectral(samples) -> dict:
    """U3 per 0.5 s window, plus U4 (the data region is not all zero)."""
    frames = len(samples)
    reasons, windows = [], []
    all_zero = not any(samples)
    starts = window_starts(frames)
    if not starts:
        reasons.append("no-window")
    for start in starts:
        raw = samples[start:start + WINDOW]
        mean = math.fsum(raw) / WINDOW
        x = [v - mean for v in raw]
        total = math.fsum(v * v for v in x)
        rms = math.sqrt(total / WINDOW) / FULL_SCALE
        row = {"start_s": start / FS, "rms_fs": round(rms, 6)}
        found = []
        if rms < RMS_MIN or total <= 0.0:
            found.append("rms-low")
        else:
            low, high = (tone_energy(x, f) / total for f in TONES)
            row.update(tone_700=round(low, 6), tone_1900=round(high, 6), tone_sum=round(low + high, 6))
            if low + high < TONE_SUM_MIN:
                found.append("tone-fraction")
            if low < TONE_EACH_MIN:
                found.append("tone-700-low")
            if high < TONE_EACH_MIN:
                found.append("tone-1900-low")
            decoys = {}
            for name, first, second in DECOYS:
                worst = max(tone_energy(x, first), tone_energy(x, second)) / total
                decoys[name] = round(worst, 6)
                if worst > DECOY_MAX:
                    found.append("decoy-" + name)
            row["decoys"] = decoys
        row["reasons"] = found
        windows.append(row)
        for reason in found:
            if reason not in reasons:
                reasons.append(reason)
    if all_zero:
        reasons.append("all-zero")
    return {"ok": not reasons, "reasons": reasons, "frames": frames, "seconds": frames / FS,
            "all_zero": all_zero, "windows": windows}


def judge(data: bytes, max_bytes: int = MAX_BYTES) -> dict:
    """U2 + U3 + U4 on one produced WAV, as the browser suite applies them to wire bytes."""
    layout = producer_layout(data, max_bytes)
    signal = spectral(samples_of(data)) if len(data) > HEADER_BYTES else {
        "ok": False, "reasons": ["no-window"], "frames": 0, "seconds": 0.0, "all_zero": True, "windows": []}
    return {"ok": layout["ok"] and signal["ok"], "sha256": sha256(data), "layout": layout, "signal": signal}


if __name__ == "__main__":
    wav = fixture_wav()
    print("fixture sha256=%s bytes=%d margin=%r" % (sha256(wav), len(wav), rounding_margin()))
