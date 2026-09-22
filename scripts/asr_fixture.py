#!/usr/bin/env python3
"""S3-ASR-U3 fixture canonicalizer: pinned generator output -> KIN dictation wire WAV.

Reads a generated (synthetic, non-clinical) PCM16 mono WAV, band-limits and resamples it
to exactly 16000 Hz, and writes the canonical `fmt 16` + `data` layout that
`api/src/dictation-audio.ts` accepts: RIFF/WAVE, PCM, 1 channel, 16000 Hz, 32000 byteRate,
blockAlign 2, 16 bits, one non-empty even `data` chunk and nothing after it.

The resampler lives here, in the repository, on purpose: an apt/pip audio tool would pin
to a package version that drifts between runs, while this file's SHA-256 is recorded with
every fixture. Nothing here touches the network, a microphone, a model or an engine.

Not a general-purpose audio converter. Anything outside the accepted source subset fails
loudly rather than being coerced.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

# Mirrors api/src/dictation-audio.ts. Kept as literals so a drift shows up as a
# fixture failure instead of a silently re-shaped wire format.
TARGET_SAMPLE_RATE = 16000
TARGET_CHANNELS = 1
TARGET_BITS = 16
WAV_MAX_BYTES = 1_048_576
CANONICAL_HEADER_BYTES = 44

# Windowed-sinc parameters. `ZERO_CROSSINGS` is the half-width of the kernel measured in
# periods of the lower of the two rates; 24 gives a stopband deep enough that the
# anti-aliasing check in tests/asr_fixture_test.py holds with a wide margin.
ZERO_CROSSINGS = 24
WINDOW = "blackman"

WAVE_FORMAT_PCM = 0x0001
WAVE_FORMAT_EXTENSIBLE = 0xFFFE


class FixtureError(Exception):
    """A named, fatal reason the fixture cannot be produced. Never recovered from."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_source_wav(data: bytes) -> dict:
    """Lenient reader for the generator's own output: any chunk order, extra chunks.

    Strict about what actually matters — PCM, 16-bit, one channel — because a silent
    downmix or bit-depth guess would make the fixture unattributable.
    """
    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise FixtureError("source is not a RIFF/WAVE file")
    fmt = None
    payload = None
    chunks = []
    offset = 12
    while offset + 8 <= len(data):
        chunk_id = data[offset:offset + 4]
        (size,) = struct.unpack_from("<I", data, offset + 4)
        body = data[offset + 8:offset + 8 + size]
        if len(body) != size:
            raise FixtureError(
                "source chunk {!r} is truncated: declared {} bytes, {} present".format(
                    chunk_id.decode("latin-1"), size, len(body)))
        chunks.append({"id": chunk_id.decode("latin-1"), "bytes": size})
        if chunk_id == b"fmt " and fmt is None:
            if size < 16:
                raise FixtureError("source fmt chunk is shorter than 16 bytes")
            audio_format, channels, rate, byte_rate, block_align, bits = struct.unpack_from(
                "<HHIIHH", body, 0)
            if audio_format == WAVE_FORMAT_EXTENSIBLE:
                if size < 40:
                    raise FixtureError("source WAVE_FORMAT_EXTENSIBLE fmt chunk is too short")
                (sub_format,) = struct.unpack_from("<H", body, 24)
                if sub_format != WAVE_FORMAT_PCM:
                    raise FixtureError(
                        "source extensible sub-format {} is not PCM".format(sub_format))
            elif audio_format != WAVE_FORMAT_PCM:
                raise FixtureError("source audio format {} is not PCM".format(audio_format))
            fmt = {"channels": channels, "sample_rate": rate, "byte_rate": byte_rate,
                   "block_align": block_align, "bits_per_sample": bits,
                   "format_tag": audio_format, "fmt_bytes": size}
        elif chunk_id == b"data" and payload is None:
            payload = body
        offset += 8 + size + (size & 1)
    if fmt is None:
        raise FixtureError("source has no fmt chunk")
    if payload is None:
        raise FixtureError("source has no data chunk")
    if fmt["channels"] != 1:
        raise FixtureError(
            "source has {} channels; the fixture path never downmixes".format(fmt["channels"]))
    if fmt["bits_per_sample"] != 16:
        raise FixtureError(
            "source is {}-bit; only 16-bit PCM is accepted".format(fmt["bits_per_sample"]))
    if not 4000 <= fmt["sample_rate"] <= 192000:
        raise FixtureError("source sample rate {} is outside 4000..192000".format(fmt["sample_rate"]))
    if len(payload) == 0 or len(payload) % 2 != 0:
        raise FixtureError("source data chunk is empty or not a whole number of 16-bit frames")
    samples = list(struct.unpack("<{}h".format(len(payload) // 2), payload))
    return {"format": fmt, "chunks": chunks, "samples": samples,
            "data_bytes": len(payload), "frames": len(samples)}


def sinc(x: float) -> float:
    if x == 0.0:
        return 1.0
    t = math.pi * x
    return math.sin(t) / t


def blackman(t: float) -> float:
    """Blackman window on t in [-1, 1]; zero outside."""
    if t <= -1.0 or t >= 1.0:
        return 0.0
    return 0.42 + 0.5 * math.cos(math.pi * t) + 0.08 * math.cos(2.0 * math.pi * t)


def build_phase_table(in_rate: int, out_rate: int) -> dict:
    """Polyphase windowed-sinc kernels, one per distinct output phase.

    in_rate/out_rate is rational, so only `up = out_rate/gcd` phases exist. Each phase is
    normalized to unit sum: DC gain is then exact regardless of window or cutoff choice,
    which is what keeps a constant input constant.
    """
    divisor = math.gcd(in_rate, out_rate)
    up = out_rate // divisor
    down = in_rate // divisor
    bandwidth = min(1.0, out_rate / in_rate)
    half_width = ZERO_CROSSINGS / bandwidth
    taps = int(math.ceil(half_width)) + 1
    table = []
    for phase in range(up):
        offset = phase / up
        kernel = []
        for k in range(-taps, taps + 1):
            u = k - offset
            kernel.append(sinc(bandwidth * u) * blackman(u / half_width))
        total = math.fsum(kernel)
        if total == 0.0:
            raise FixtureError("degenerate resampling kernel for phase {}".format(phase))
        table.append([value / total for value in kernel])
    return {"table": table, "up": up, "down": down, "taps": taps,
            "bandwidth": bandwidth, "half_width": half_width}


def resample(samples: list, in_rate: int, out_rate: int) -> dict:
    if in_rate == out_rate:
        return {"samples": list(samples), "clipped": 0, "algorithm": {
            "kind": "passthrough", "in_rate": in_rate, "out_rate": out_rate}}
    phases = build_phase_table(in_rate, out_rate)
    table = phases["table"]
    up = phases["up"]
    down = phases["down"]
    taps = phases["taps"]
    source_length = len(samples)
    if source_length < 2:
        raise FixtureError("source is too short to resample")
    count = ((source_length - 1) * up) // down + 1
    out = []
    clipped = 0
    for index in range(count):
        position = index * down
        centre, phase = divmod(position, up)
        kernel = table[phase]
        base = centre - taps
        low = max(0, base)
        high = min(source_length - 1, centre + taps)
        total = 0.0
        for source_index in range(low, high + 1):
            total += samples[source_index] * kernel[source_index - base]
        value = math.floor(total + 0.5)
        if value > 32767:
            value = 32767
            clipped += 1
        elif value < -32768:
            value = -32768
            clipped += 1
        out.append(value)
    return {"samples": out, "clipped": clipped, "algorithm": {
        "kind": "polyphase-windowed-sinc", "window": WINDOW,
        "zero_crossings": ZERO_CROSSINGS, "in_rate": in_rate, "out_rate": out_rate,
        "up": up, "down": down, "taps_per_side": taps,
        "bandwidth": phases["bandwidth"], "half_width_input_samples": phases["half_width"],
        "phase_normalization": "unit-sum", "rounding": "floor(x + 0.5), clamped to int16"}}


def canonical_wav(samples: list, max_bytes: int = WAV_MAX_BYTES) -> bytes:
    """Exactly the layout inspectDictationWav accepts; no ancillary or trailing chunks."""
    if not samples:
        raise FixtureError("refusing to write an empty data chunk")
    data = struct.pack("<{}h".format(len(samples)), *samples)
    total = CANONICAL_HEADER_BYTES + len(data)
    if total > max_bytes:
        raise FixtureError(
            "canonical WAV would be {} bytes, above the {} byte dictation ceiling; "
            "shorten the generated utterance".format(total, max_bytes))
    header = b"RIFF" + struct.pack("<I", total - 8) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, WAVE_FORMAT_PCM, TARGET_CHANNELS, TARGET_SAMPLE_RATE,
        TARGET_SAMPLE_RATE * TARGET_CHANNELS * (TARGET_BITS // 8),
        TARGET_CHANNELS * (TARGET_BITS // 8), TARGET_BITS)
    return header + b"data" + struct.pack("<I", len(data)) + data


def build_fixture(source_bytes: bytes, max_bytes: int = WAV_MAX_BYTES) -> dict:
    source = read_source_wav(source_bytes)
    converted = resample(source["samples"], source["format"]["sample_rate"], TARGET_SAMPLE_RATE)
    wav = canonical_wav(converted["samples"], max_bytes)
    frames = len(converted["samples"])
    return {
        "generated_at_utc": utc_now(),
        "source": {"bytes": len(source_bytes), "sha256": sha256_bytes(source_bytes),
                   "format": source["format"], "chunks": source["chunks"],
                   "data_bytes": source["data_bytes"], "frames": source["frames"],
                   "seconds": source["frames"] / source["format"]["sample_rate"]},
        "resampler": {"source_file": "scripts/asr_fixture.py",
                      "sha256": sha256_bytes(Path(__file__).read_bytes()),
                      "clipped_samples": converted["clipped"], **converted["algorithm"]},
        "fixture": {"bytes": len(wav), "sha256": sha256_bytes(wav),
                    "sample_rate": TARGET_SAMPLE_RATE, "channels": TARGET_CHANNELS,
                    "bits_per_sample": TARGET_BITS, "frames": frames,
                    "data_bytes": frames * 2, "seconds": frames / TARGET_SAMPLE_RATE,
                    "header_bytes": CANONICAL_HEADER_BYTES, "max_bytes": max_bytes},
        "claims": ["synthetic non-clinical text-to-speech only",
                   "no recognition, accuracy, latency or clinical suitability is implied"],
        "wav": wav,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Generated PCM16 mono WAV")
    parser.add_argument("--output", required=True, help="Canonical dictation WAV to write")
    parser.add_argument("--report", required=True, help="Provenance JSON to write")
    parser.add_argument("--max-bytes", type=int, default=WAV_MAX_BYTES)
    parser.add_argument("--generator", default=None,
                        help="Optional generator provenance JSON to embed verbatim")
    args = parser.parse_args(argv)
    try:
        result = build_fixture(Path(args.input).read_bytes(), args.max_bytes)
    except FixtureError as error:
        print("asr_fixture: {}".format(error), file=sys.stderr)
        return 2
    except OSError as error:
        print("asr_fixture: cannot read source: {}".format(error), file=sys.stderr)
        return 2
    wav = result.pop("wav")
    if args.generator:
        try:
            result["generator"] = json.loads(Path(args.generator).read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            print("asr_fixture: cannot read generator provenance: {}".format(error),
                  file=sys.stderr)
            return 2
    result["output_path"] = str(Path(args.output).resolve())
    Path(args.output).write_bytes(wav)
    with Path(args.report).open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(result, stream, ensure_ascii=True, indent=2, sort_keys=True)
        stream.write("\n")
    print("fixture sha256={} bytes={} frames={} seconds={:.6f}".format(
        result["fixture"]["sha256"], result["fixture"]["bytes"],
        result["fixture"]["frames"], result["fixture"]["seconds"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
