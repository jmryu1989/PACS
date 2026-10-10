#!/usr/bin/env python3
"""Build the ordered classic script; --check never writes.

REQ-S9-U0a-BYTES -> RISK-BUNDLE-DRIFT/ORDER -> TEST-S9-U0a-BUNDLE.
The permanent check compares the artifact with the ordered current sources.
The candidate pin additionally preserves the original single Script body
(AGENTS 1-B.14) while migration_state is pristine. The first approved source
change sets migration_state to modified and rebinds the C1 move spec in that
same change. Developers edit the 45 sources and regenerate the artifact.
"""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "scripts/main-split-order.json"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


class Scripts(HTMLParser):
    def __init__(self, data):
        super().__init__(convert_charrefs=False)
        self.text = data.decode("utf-8")
        self.lines = self.text.splitlines(keepends=True)
        self.tags, self.active = [], None
        self.feed(self.text)
        self.close()
        assert self.active is None, "Unclosed script"

    def byte_offset(self):
        line, column = self.getpos()
        return len(("".join(self.lines[:line - 1]) + self.lines[line - 1][:column]).encode("utf-8"))

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            assert self.active is None
            raw = self.get_starttag_text()
            self.active = {"attrs": attrs, "raw": raw, "start": self.byte_offset(),
                           "body_start": self.byte_offset() + len(raw.encode("utf-8"))}

    def handle_endtag(self, tag):
        if tag == "script":
            assert self.active is not None
            self.active.update(body_end=self.byte_offset(), end=self.byte_offset() + len("</script>"))
            self.tags.append(self.active)
            self.active = None


def assemble(root=ROOT, manifest=None):
    manifest = manifest or json.loads((root / "scripts/main-split-order.json").read_bytes())
    sources = manifest["sources"]
    assert len(sources) == 45 and len({s["file"] for s in sources}) == 45, "45 distinct ordered sources"
    output, ranges = bytearray(), []
    page_dir = root / Path(manifest["page"]).parent
    # The migration's 44 boundaries are empty: every trivia byte belongs to a
    # source. Building current sources must not depend on historical Git objects.
    for source in sources:
        name = source["file"]
        assert Path(name).name == name and name.endswith(".js"), "Plain source filename required"
        data = (page_dir / name).read_bytes()
        assert b"\r" not in data and not data.startswith(b"\xef\xbb\xbf"), "Sources must be LF without BOM: " + name
        offset = len(output)
        output.extend(data)
        ranges.append({"file": name, "bytes": [offset, len(output)],
                       "lines": [output[:offset].count(b"\n") + 1, output[:len(output) - 1].count(b"\n") + 1],
                       "sha256": sha256(data)})
    artifact = bytes(output)
    report = {"bytes": len(artifact), "sha256": sha256(artifact),
              "range_convention": "bytes zero-based half-open; lines one-based inclusive", "sources": ranges}
    return artifact, report


def candidate_pin(root, manifest, artifact, report, html):
    before = subprocess.check_output(["git", "cat-file", "blob", manifest["base"] + ":" + manifest["page"]], cwd=ROOT)
    original = Scripts(before)
    inline = [t for t in original.tags if "src" not in dict(t["attrs"])]
    assert len(inline) == 1, "Original must have one inline Script"
    body = before[inline[0]["body_start"]:inline[0]["body_end"]]
    cursor, boundaries = 0, []
    for index, (source, current) in enumerate(zip(manifest["sources"], report["sources"])):
        start, end = source["original_bytes"]
        assert start == cursor < end <= len(body), "Original slice order / empty boundaries"
        if index:
            boundaries.append({"original_bytes": [cursor, start], "hex": ""})
        current["equals_original_slice"] = artifact[current["bytes"][0]:current["bytes"][1]] == body[start:end]
        cursor = end
    assert cursor == len(body), "Original slices cover the whole body"
    report.update(base=manifest["base"], original_body_sha256=sha256(body), equals_original_body=artifact == body,
                  prefix_hex="", suffix_hex="", boundaries=boundaries)
    assert report["equals_original_body"] and all(s["equals_original_slice"] for s in report["sources"]), "Bundle/source differs from original body"
    name = Path(manifest["artifact"]).name
    expected = before[:inline[0]["start"]] + ('<script src="' + name + '"></script>').encode() + before[inline[0]["end"]:]
    assert html == expected, "Markup, existing script order/attributes and bundle position must be preserved"


def check(root=ROOT, manifest=None, mode="auto"):
    manifest = manifest or json.loads((root / "scripts/main-split-order.json").read_bytes())
    assert manifest.get("migration_state") in ("pristine", "modified"), "Explicit migration_state required"
    assert mode in ("auto", "permanent", "candidate-pin"), "Unknown check mode"
    artifact, report = assemble(root, manifest)
    committed = (root / manifest["artifact"]).read_bytes()
    assert committed == artifact, "Stale bundle artifact: bytes/SHA-256 differ"
    html = (root / manifest["page"]).read_bytes()
    tags = Scripts(html).tags
    name = Path(manifest["artifact"]).name
    bundled = [t for t in tags if dict(t["attrs"]).get("src") == name]
    source_names = {s["file"] for s in manifest["sources"]}
    direct = [t for t in tags if dict(t["attrs"]).get("src") in source_names]
    assert len(bundled) == 1 and not direct and all("src" in dict(t["attrs"]) for t in tags), "Bundle tag count / direct source / inline"
    tag = bundled[0]
    assert tag["attrs"] == [("src", name)] and html[tag["start"]:tag["end"]] == ('<script src="' + name + '"></script>').encode(), "Ordinary blocking classic bundle tag"
    pin = mode == "candidate-pin" or (mode == "auto" and manifest["migration_state"] == "pristine")
    report["checks"] = {"permanent": "PASS", "candidate_pin": "NOT_RUN"}
    if pin:
        candidate_pin(root, manifest, artifact, report, html)
        report["checks"]["candidate_pin"] = "PASS"
    report["migration_state"] = manifest["migration_state"]
    report["main_html"] = {"bundle_tags": 1, "source_tags": 0, "existing_tags": len(tags) - 1}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--mode", choices=("auto", "permanent", "candidate-pin"), default="auto",
                        help="auto always checks current sources and pins C only while pristine")
    args = parser.parse_args()
    if not args.check and args.mode != "auto":
        parser.error("--mode requires --check")
    if args.check:
        report = check(mode=args.mode)
    else:
        manifest = json.loads(MANIFEST.read_bytes())
        bundle, report = assemble()
        (ROOT / manifest["artifact"]).write_bytes(bundle)
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
