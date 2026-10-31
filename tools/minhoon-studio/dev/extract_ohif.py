#!/usr/bin/env python3
"""Extract the pinned OHIF build the product uses (the Orthanc OHIF plugin of orthancteam/orthanc:24.12.0).

The plugin embeds the OHIF dist in libOrthancOHIF.so; the resource paths are plain strings in the binary. This copies
the .so out of the image, lists those paths, serves them from a throwaway container (no volumes, loopback port only)
and downloads each one. Nothing else is started or touched.

  python tools/minhoon-studio/dev/extract_ohif.py --out tmp/minhoon-studio/ohif-dist
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

IMAGE = "orthancteam/orthanc:24.12.0"
NAME = "mstudio-ohif-extract"
PORT = 18042


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    work = tempfile.mkdtemp(prefix="mstudio-ohif-")
    so = os.path.join(work, "libOrthancOHIF.so")
    subprocess.run(["docker", "create", "--name", NAME + "-so", IMAGE], check=True, capture_output=True)
    try:
        subprocess.run(["docker", "cp", f"{NAME}-so:/usr/share/orthanc/plugins-available/libOrthancOHIF.so", so], check=True)
    finally:
        subprocess.run(["docker", "rm", NAME + "-so"], capture_output=True)
    data = open(so, "rb").read()
    pattern = rb"[A-Za-z0-9_./@-]{3,200}\.(?:js|css|wasm|json|png|svg|ico|woff2?|ttf|html|txt|map|webmanifest|xml)(?![A-Za-z0-9])"
    names = sorted({m.group().decode() for m in re.finditer(pattern, data)})
    # The OHIF plugin refuses to start without the DICOMweb plugin (Orthanc then exits and --rm removes it).
    subprocess.run(["docker", "run", "-d", "--rm", "--name", NAME, "-p", f"127.0.0.1:{PORT}:8042",
                    "-e", "OHIF_PLUGIN_ENABLED=true", "-e", "DICOM_WEB_PLUGIN_ENABLED=true",
                    "-e", "ORTHANC__AUTHENTICATION_ENABLED=false", IMAGE], check=True, capture_output=True)
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/ohif/", timeout=2); break
            except Exception:
                time.sleep(1)
        else:
            # Without this every resource below waits out its own connection attempt (hours for ~2000 names).
            raise SystemExit(f"Orthanc OHIF plugin did not answer on port {PORT}")
        ok = total = 0
        index = None
        for name in names:
            name = name.lstrip("/")
            if name.startswith(".") or ".." in name:
                continue
            try:
                body = urllib.request.urlopen(f"http://127.0.0.1:{PORT}/ohif/{name}", timeout=30).read()
            except Exception:
                continue
            path = os.path.join(args.out, name)
            os.makedirs(os.path.dirname(path) or args.out, exist_ok=True)
            open(path, "wb").write(body)
            ok += 1; total += len(body)
            if name == "index.html":
                index = body
        # The plugin answers index.html for unknown paths; drop any string match that was really that fallback.
        if index:
            for name in names:
                path = os.path.join(args.out, name.lstrip("/"))
                if name != "index.html" and os.path.isfile(path) and open(path, "rb").read() == index:
                    os.remove(path); ok -= 1
        print(f"extracted {ok} files, {total} bytes into {args.out}")
    finally:
        subprocess.run(["docker", "rm", "-f", NAME], capture_output=True)


if __name__ == "__main__":
    sys.exit(main())
