#!/usr/bin/env python3
"""Concatenate the current OHIF sources; --check reports a forgotten rebuild.

REQ-S9-U0e-BEHAVIOUR-PRESERVED -> RISK-SOURCE-ORDER -> TEST-S9-U0E-BUILD.
This is one classic script, with no separators, wrappers or runtime imports.
Historical extraction evidence belongs to source-map.json and the run record;
subsequent source edits do not need a baseline hash approval.
"""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def assemble(root=ROOT):
    directory = root / "config/ohif"
    sources = json.loads((directory / "source-order.json").read_bytes())["sources"]
    if not isinstance(sources, list) or not sources or not all(isinstance(s, str) for s in sources):
        raise ValueError("source-order.json must list source filenames")
    if len(sources) != len(set(sources)):
        raise ValueError("source-order.json lists a source more than once")
    available = {path.name for path in directory.glob("*.js")}
    listed = set(sources)
    if listed != available:
        raise ValueError("source-order.json differs from source files: "
                         f"unlisted={sorted(available - listed)}, missing={sorted(listed - available)}")
    return b"".join((directory / name).read_bytes() for name in sources)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="compare without writing")
    args = parser.parse_args()
    try:
        generated = assemble()
        output = ROOT / "config/ohif.js"
        if args.check:
            if not output.is_file() or output.read_bytes() != generated:
                print("OHIF config is stale; run python scripts/build-ohif-config.py", file=sys.stderr)
                return 1
            print("OHIF config matches current ordered sources")
        else:
            output.write_bytes(generated)
            print(f"Built config/ohif.js ({len(generated)} bytes)")
    except (OSError, ValueError, KeyError) as error:
        print(f"Cannot build OHIF config: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
