#!/usr/bin/env python3
"""Rebuild worklist-v0/hpacs-lite/kin-sof3.wasm from its pinned sources; --check compares instead of writing.

REQ-MG-SOF3-DECODE -> RISK-CODEC-SUPPLY -> TEST-SOF3-WASM-REPRODUCIBLE.
The viewer's JPEG lossless (.70/.57) greyscale decoder is unmodified libjpeg-turbo (the official release tarball
below, verified by sha256) compiled for wasm32-wasi with zig cc, plus the 60-line entry shim scripts/sof3/kin_sof3.c.
Nothing is fetched from npm and no emscripten glue is involved: the JavaScript side (kin-sof3.js) stubs the six WASI
imports the library pulls in. The toolchain comes from PyPI at build time only (ziglang, cmake, ninja, pinned below)
and is not a runtime or CI dependency; CI checks the committed artifact against kin-sof3.wasm.sha256.

Manual rebuild (about 20 s after the toolchain is installed; network for the toolchain and the tarball):
    python scripts/build-sof3-wasm.py --check            # rebuild in tmp/sof3-build, compare with the committed bytes
    python scripts/build-sof3-wasm.py                    # rebuild and replace the artifact and its .sha256
Options: --work DIR (scratch, default tmp/sof3-build), --tarball PATH (an already downloaded release tarball,
still verified), --toolchain VENV (an existing venv that already has the pinned packages).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import venv

ROOT = Path(__file__).resolve().parents[1]
LIBJPEG_TURBO = {
    "version": "3.2.1",
    "url": "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.2.1/libjpeg-turbo-3.2.1.tar.gz",
    "sha256": "c27ad72a68da151177929aa969ae773a2da5ac2af9ce946079314fdac8cece7f",
}
TOOLCHAIN = {"ziglang": "0.16.0", "cmake": "4.4.4", "ninja": "1.13.2"}
SHIM = ROOT / "scripts/sof3/kin_sof3.c"
CMAKE_TOOLCHAIN = ROOT / "scripts/sof3/zig-wasi.cmake"
ARTIFACT = ROOT / "worklist-v0/hpacs-lite/kin-sof3.wasm"
RECORDED = ARTIFACT.with_name(ARTIFACT.name + ".sha256")
# The library needs no SIMD (wasm32 has none here), no arithmetic coding (not a DICOM syntax we route), no TurboJPEG
# API and no programs. 32 MB initial memory: one 3328x2560 16-bit frame is 17 MB of output plus a 2-3 MB codestream,
# so the first decode does not pay for a dozen memory.grow steps (measured 650 ms with the 1 MB default). Growth stays on.
CMAKE_OPTIONS = ["-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_C_FLAGS_RELEASE=-O3", "-DWITH_SIMD=0", "-DENABLE_SHARED=0",
                 "-DENABLE_STATIC=1", "-DWITH_TURBOJPEG=0", "-DWITH_JAVA=0", "-DWITH_ARITH_DEC=0", "-DWITH_ARITH_ENC=0",
                 "-DWITH_JPEG8=0", "-DWITH_JPEG7=0", "-DWITH_FUZZ=0"]
LINK_FLAGS = ["-target", "wasm32-wasi", "-O3", "-mexec-model=reactor", "-Wl,--strip-debug", "-Wl,--initial-memory=33554432"]


def run(command, env):
    print("$", " ".join(str(part) for part in command), flush=True)
    completed = subprocess.run([str(part) for part in command], env=env)
    if completed.returncode:
        raise SystemExit(f"exit {completed.returncode}: {command[0]}")


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def toolchain(work, given):
    # A venv keeps the pinned toolchain away from the caller's interpreter.
    root = Path(given) if given else work / "venv"
    scripts = root / ("Scripts" if os.name == "nt" else "bin")
    python = scripts / ("python.exe" if os.name == "nt" else "python")
    if not given and not python.exists():
        venv.create(root, with_pip=True)
        run([python, "-m", "pip", "install", "--disable-pip-version-check"] +
            [f"{name}=={version}" for name, version in TOOLCHAIN.items()], dict(os.environ))
    # The installed distributions are the pin; the Kitware ninja wheel's own --version carries a build suffix.
    probe = ("import importlib.metadata as m, json, os, ziglang; print(json.dumps([os.path.dirname(ziglang.__file__), "
             "{n: m.version(n) for n in " + repr(sorted(TOOLCHAIN)) + "}]))")
    site, versions = json.loads(subprocess.run([str(python), "-c", probe], capture_output=True, text=True, check=True).stdout)
    zig = Path(site) / ("zig.exe" if os.name == "nt" else "zig")
    exe = ".exe" if os.name == "nt" else ""
    tools = {"zig": zig, "cmake": scripts / f"cmake{exe}", "ninja": scripts / f"ninja{exe}"}
    if versions != TOOLCHAIN:
        raise SystemExit(f"toolchain differs from the pinned versions: {versions} != {TOOLCHAIN}")
    print("toolchain", versions, flush=True)
    return tools


def source(work, tarball):
    archive = Path(tarball) if tarball else work / Path(LIBJPEG_TURBO["url"]).name
    if not archive.exists():
        print("download", LIBJPEG_TURBO["url"], flush=True)
        with urllib.request.urlopen(LIBJPEG_TURBO["url"], timeout=120) as response, archive.open("wb") as out:
            shutil.copyfileobj(response, out)
    digest = sha256(archive)
    if digest != LIBJPEG_TURBO["sha256"]:
        raise SystemExit(f"{archive} sha256 {digest} is not the pinned release {LIBJPEG_TURBO['sha256']}")
    target = work / "src"
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)
    with tarfile.open(archive) as bundle:
        top = f"libjpeg-turbo-{LIBJPEG_TURBO['version']}/"
        members = [m for m in bundle.getmembers()
                   if (m.name + "/").startswith(top) and ".." not in Path(m.name).parts]
        if len(members) != len(bundle.getmembers()):
            raise SystemExit("release tarball has members outside its top directory")
        bundle.extractall(target, members=members, filter="data")
    print("libjpeg-turbo", LIBJPEG_TURBO["version"], "sha256", digest, flush=True)
    return target / top.rstrip("/")


def build(work, tarball, given_toolchain):
    work.mkdir(parents=True, exist_ok=True)
    tools = toolchain(work, given_toolchain)
    src = source(work, tarball)
    cache = work / "zig-cache"
    env = {**os.environ, "KIN_ZIG_EXE": str(tools["zig"]), "ZIG_GLOBAL_CACHE_DIR": str(cache), "ZIG_LOCAL_CACHE_DIR": str(cache)}
    run([tools["zig"], "version"], env)
    objects = work / "build-libjpeg"
    shutil.rmtree(objects, ignore_errors=True)
    run([tools["cmake"], "-S", src, "-B", objects, "-G", "Ninja", f"-DCMAKE_MAKE_PROGRAM={tools['ninja']}",
         f"-DCMAKE_TOOLCHAIN_FILE={CMAKE_TOOLCHAIN}"] + CMAKE_OPTIONS, env)
    run([tools["cmake"], "--build", objects, "--target", "jpeg-static", "--parallel", "8"], env)
    library = objects / "libjpeg.a"
    output = work / "kin-sof3.wasm"
    # libjpeg-turbo 3.x keeps jpeglib.h under src/; jconfig.h and jconfigint.h are generated into the build directory.
    run([tools["zig"], "cc"] + LINK_FLAGS + ["-I", src / "src", "-I", objects, SHIM, library, "-o", output], env)
    print("built", output, output.stat().st_size, "bytes sha256", sha256(output), flush=True)
    return output


def recorded():
    return RECORDED.read_text(encoding="ascii").split()[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="rebuild and compare with the committed artifact")
    parser.add_argument("--work", default=str(ROOT / "tmp/sof3-build"))
    parser.add_argument("--tarball")
    parser.add_argument("--toolchain")
    args = parser.parse_args()
    output = build(Path(args.work).resolve(), args.tarball, args.toolchain)
    digest = sha256(output)
    if args.check:
        same = digest == recorded() and output.read_bytes() == ARTIFACT.read_bytes()
        print("rebuild", digest, "committed", recorded(), "identical" if same else "DIFFERENT")
        return 0 if same else 1
    shutil.copyfile(output, ARTIFACT)
    RECORDED.write_text(f"{digest}  {ARTIFACT.name}\n", encoding="ascii", newline="\n")
    print("wrote", ARTIFACT.relative_to(ROOT), "and", RECORDED.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
