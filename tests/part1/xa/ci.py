"""XA public sample cache plan and fetch; every restored or downloaded file is hash-verified."""
import hashlib, json, os, shutil, sys, tempfile, zipfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from archive_download import download

def plan():
    manifest = json.loads(Path(__file__).with_name("samples.json").read_text(encoding="utf-8"))
    rows = manifest["public"]
    if os.environ.get("GITHUB_OUTPUT"):
        hashes = "\n".join(sorted(row["sha256"] for row in rows))
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write("cache-key=xa-public-v1-" + hashlib.sha256(hashes.encode("ascii")).hexdigest() + "\n")
            # Match MG: cache only manifest-named public files, not an entire sample root.
            output.write("cache-paths<<XA_CACHE_PATHS\n")
            output.write("\n".join(str(Path(os.environ[manifest["root_env"]]) / row["relpath"])
                                   for row in rows) + "\nXA_CACHE_PATHS\n")
    print("public samples in cache plan:", len(rows))

def fetch():
    manifest = json.loads(Path(__file__).with_name("samples.json").read_text(encoding="utf-8"))
    rows = manifest["public"]
    def digest(path):
        h = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(block)
        return h.hexdigest()
    groups = {}
    for row in rows:
        relative = Path(row["relpath"])
        key = manifest["root_env"]
        target = Path(os.environ[key]) / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_file():
            if digest(target) != row["sha256"]:
                raise RuntimeError("cached sample hash mismatch: " + row["id"])
            print("verified", row["id"], row["sha256"], flush=True)
            continue
        groups.setdefault(relative.parent.name, []).append((row, target))
    for series, requested in groups.items():
        # The collection downloads used this public NBIA endpoint. Match archive members
        # by the pinned FILE digest, never by a server-side ordering or a rewritten header.
        url = "https://services.cancerimagingarchive.net/nbia-api/services/v1/getImage?SeriesInstanceUID=" + series
        print("fetch", url, flush=True)
        with tempfile.TemporaryFile() as archive:
            download(url, archive)
            pending = {row["sha256"]: (row, target) for row, target in requested}
            with zipfile.ZipFile(archive) as zipped:
                for member in zipped.infolist():
                    if member.is_dir() or member.file_size not in {r["bytes"] for r, _ in pending.values()}:
                        continue
                    h = hashlib.sha256()
                    with zipped.open(member) as stream:
                        for block in iter(lambda: stream.read(1024 * 1024), b""):
                            h.update(block)
                    match = pending.pop(h.hexdigest(), None)
                    if match:
                        row, target = match
                        # Only a manifest-named destination is written, no archive extraction paths.
                        with zipped.open(member) as source, target.open("xb") as output:
                            shutil.copyfileobj(source, output, 1024 * 1024)
                        if digest(target) != row["sha256"]:
                            raise RuntimeError("downloaded sample hash mismatch: " + row["id"])
                        print("verified", row["id"], row["sha256"], flush=True)
                    if not pending:
                        break
            if pending:
                raise RuntimeError("NOT RUN: public source lacks pinned samples " + ", ".join(r["id"] for r, _ in pending.values()))
    print("all public samples verified:", len(rows))


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "fetch"
    if action == "plan":
        plan()
    elif action == "fetch":
        fetch()
    else:
        raise SystemExit("unknown XA CI action: " + action)
