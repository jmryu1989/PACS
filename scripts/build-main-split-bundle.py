#!/usr/bin/env python3
"""Build the ordered classic script; --check never writes.

REQ-S9-U0a-BYTES -> RISK-BUNDLE-DRIFT/ORDER -> TEST-S9-U0a-BUNDLE.
Byte pins are intentional: this candidate preserves the original single Script
body, including trivia and error/hoisting boundaries (AGENTS 1-B.14). A future
behaviour change must explicitly revise this migration proof, not silently
normalize or re-freeze its baseline. Developers edit the 45 sources.
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
    before = subprocess.check_output(["git", "cat-file", "blob", manifest["base"] + ":" + manifest["page"]], cwd=ROOT)
    original = Scripts(before)
    inline = [t for t in original.tags if "src" not in dict(t["attrs"])]
    assert len(inline) == 1, "Original must have one inline Script"
    body = before[inline[0]["body_start"]:inline[0]["body_end"]]
    sources = manifest["sources"]
    assert len(sources) == 45 and len({s["file"] for s in sources}) == 45, "45 distinct ordered sources"
    output, ranges, boundaries, cursor = bytearray(), [], [], 0
    page_dir = root / Path(manifest["page"]).parent
    for index, source in enumerate(sources):
        start, end = source["original_bytes"]
        assert 0 <= cursor <= start < end <= len(body), "Original slice order"
        gap = body[cursor:start]
        if index:
            output.extend(gap)
            boundaries.append({"original_bytes": [cursor, start], "hex": gap.hex()})
        else:
            prefix = gap
        name = source["file"]
        assert Path(name).name == name and name.endswith(".js"), "Plain source filename required"
        data = (page_dir / name).read_bytes()
        assert b"\r" not in data and not data.startswith(b"\xef\xbb\xbf"), "Sources must be LF without BOM: " + name
        offset = len(output)
        output.extend(data)
        ranges.append({"file": name, "bytes": [offset, len(output)],
                       "lines": [output[:offset].count(b"\n") + 1, output[:len(output) - 1].count(b"\n") + 1],
                       "sha256": sha256(data), "equals_original_slice": data == body[start:end]})
        cursor = end
    suffix = body[cursor:]
    bundle = bytes(output)
    proof = prefix + bundle + suffix == body
    report = {"base": manifest["base"], "bytes": len(bundle), "sha256": sha256(bundle),
              "original_body_sha256": sha256(body), "equals_original_body": proof,
              "prefix_hex": prefix.hex(), "suffix_hex": suffix.hex(), "boundaries": boundaries,
              "range_convention": "bytes zero-based half-open; lines one-based inclusive", "sources": ranges}
    return bundle, report, before, inline[0]


def check(root=ROOT, manifest=None):
    manifest = manifest or json.loads((root / "scripts/main-split-order.json").read_bytes())
    bundle, report, before, inline = assemble(root, manifest)
    artifact = (root / manifest["artifact"]).read_bytes()
    assert artifact == bundle and sha256(artifact) == report["sha256"], "Stale bundle artifact: bytes/SHA-256 differ"
    assert report["equals_original_body"] and all(s["equals_original_slice"] for s in report["sources"]), "Bundle/source differs from original body"
    html = (root / manifest["page"]).read_bytes()
    tags = Scripts(html).tags
    name = Path(manifest["artifact"]).name
    bundled = [t for t in tags if dict(t["attrs"]).get("src") == name]
    source_names = {s["file"] for s in manifest["sources"]}
    direct = [t for t in tags if dict(t["attrs"]).get("src") in source_names]
    assert len(bundled) == 1 and not direct and all("src" in dict(t["attrs"]) for t in tags), "Bundle tag count / direct source / inline"
    tag = bundled[0]
    assert tag["attrs"] == [("src", name)] and html[tag["start"]:tag["end"]] == ('<script src="' + name + '"></script>').encode(), "Ordinary blocking classic bundle tag"
    prior = [t for t in Scripts(before).tags if "src" in dict(t["attrs"])]
    preserved = [t for t in tags if t is not tag]
    assert len(preserved) == len(prior) == 56, "56 existing scripts"
    assert [(t["attrs"], t["raw"]) for t in preserved] == [(t["attrs"], t["raw"]) for t in prior], "Existing script order/attributes"
    expected = before[:inline["start"]] + ('<script src="' + name + '"></script>').encode() + before[inline["end"]:]
    assert html == expected, "Markup and bundle position must be preserved"
    report["main_html"] = {"bundle_tags": 1, "source_tags": 0, "existing_tags": 56}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        report = check()
    else:
        manifest = json.loads(MANIFEST.read_bytes())
        bundle, report, _, _ = assemble()
        (ROOT / manifest["artifact"]).write_bytes(bundle)
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
