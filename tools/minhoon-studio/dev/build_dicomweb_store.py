#!/usr/bin/env python3
"""Build a STATIC DICOMweb store for the studio mock viewer server.

A throwaway Orthanc (no volumes, loopback port only) ingests a few public CC BY
TCIA sample studies; every response the OHIF client needs is fetched once and
written to disk, so the mock can serve the viewer without any PACS behind it.

  python tools/minhoon-studio/dev/build_dicomweb_store.py

Output (tmp/minhoon-studio/dicomweb-store, recreated on every run):
  files/<sha256-24>   response bodies, deduplicated by content hash
  routes.json         request path -> {file, type (Content-Type verbatim), bytes}
  studies.json        per study: QIDO object, counts, UID maps, source/licence
  ATTRIBUTION.md      collection, DOI, licence and required citation per study
  build-log.json      counts, failures, timings, image id, verification

Isolation: only the container named below is created, queried and removed.
Other stacks on the same Docker host (kin-*, mgxa-*) are never touched.
JSON bodies carry absolute URLs (BulkDataURI, RetrieveURL); the build origin is
replaced with the literal {{ORIGIN}} so the mock can insert the browser origin
at serve time. Binary bodies are stored byte-exact.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = Path(__file__).resolve().parents[3]
SAMPLES = Path(r"C:\Users\norne\PACS\tmp\dicom-samples\tcia-20261004")
OUT = REPO / "tmp" / "minhoon-studio" / "dicomweb-store"

CONTAINER = "mstudio-dicomweb-build"
IMAGE = "orthancteam/orthanc:24.12.0"
ORIGIN = "http://127.0.0.1:18043"
PLACEHOLDER = b"{{ORIGIN}}"
DOCKER_RUN = [
    "docker", "run", "-d", "--rm", "--name", CONTAINER,
    "-p", "127.0.0.1:18043:8042",
    "-e", "DICOM_WEB_PLUGIN_ENABLED=true",
    "-e", "ORTHANC__AUTHENTICATION_ENABLED=false",
    "-e", "ORTHANC__REMOTE_ACCESS_ALLOWED=true",
    IMAGE,
]

ACCEPT_JSON = "application/dicom+json"
# Exactly what the OHIF client sends for frames; Orthanc answers in the stored syntax.
ACCEPT_FRAMES = "multipart/related; type=application/octet-stream; transfer-syntax=*"
ACCEPT_BULK = "application/octet-stream"

FOLDERS = [
    "studies/CMMD/D1-0860/2010-07-18-7152484858",
    "studies/COVID-19-NY-SBU/A872279/1901-01-13-1529437631",
    "studies/COVID-19-NY-SBU/A872279/1901-01-12-8170143690",
    "studies/TCGA-KIRC/TCGA-CW-5580/1992-06-01-5683806674",
    "studies/TCGA-KIRC/TCGA-CW-5580/1992-02-25-9858725517",
    "studies/CMB-MML/MSB-04030/1963-12-12-6136302712",
    "studies/CMB-MML/MSB-04030/1961-01-30-3959095934",
    "studies/COVID-19-NY-SBU/A223238/1901-01-09-3786806786",
    "studies/CMB-CRC/MSB-06489/1959-10-06-4968582907",
]

# The system proxy (Windows registry) must not intercept loopback build traffic.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http(method, path, body=None, accept=None, content_type=None, timeout=300):
    request = urllib.request.Request(ORIGIN + path, data=body, method=method)
    if accept:
        request.add_header("Accept", accept)
    if content_type:
        request.add_header("Content-Type", content_type)
    try:
        with OPENER.open(request, timeout=timeout) as response:
            return response.status, response.headers.get("Content-Type", ""), response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("Content-Type", ""), error.read()
    except (urllib.error.URLError, OSError) as error:
        return 0, "", str(error).encode("utf-8", "replace")


def get_json(path):
    status, _, body = http("GET", path, accept="application/json")
    if status != 200:
        raise RuntimeError(f"GET {path} -> {status}: {body[:200]!r}")
    return json.loads(body)


def docker(*args, check=False):
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check)


def is_json(content_type):
    return "json" in content_type.lower()


def first_value(dataset, tag, default=None):
    values = dataset.get(tag, {}).get("Value") or []
    return values[0] if values else default


def route_path(uri):
    """BulkDataURI -> request path without origin (and without query)."""
    parts = urllib.parse.urlsplit(uri)
    path = parts.path if (parts.scheme or parts.netloc) else uri.split("?", 1)[0]
    if path.startswith("{{ORIGIN}}"):
        path = path[len("{{ORIGIN}}"):]
    return path if path.startswith("/") else "/" + path


def bulk_uris(dataset, top_tag=None, found=None):
    """Every BulkDataURI in a DICOM JSON dataset, nested sequences included.

    Returns (top-level tag, uri) so pixel data can be told apart from other bulk.
    """
    found = [] if found is None else found
    for tag, element in dataset.items():
        if not isinstance(element, dict):
            continue
        owner = top_tag or tag.upper()
        if "BulkDataURI" in element:
            found.append((owner, element["BulkDataURI"]))
        for item in element.get("Value") or []:
            if isinstance(item, dict):
                bulk_uris(item, owner, found)
    return found


def multipart_first_part(content_type, body):
    match = re.search(r'boundary="?([^";]+)"?', content_type, re.I)
    if not match:
        return None, "no boundary in Content-Type"
    delimiter = b"--" + match.group(1).encode()
    start = body.find(delimiter)
    if start < 0:
        return None, "boundary not found in body"
    start += len(delimiter)
    if body[start:start + 2] == b"\r\n":
        start += 2
    header_end = body.find(b"\r\n\r\n", start)
    if header_end < 0:
        return None, "part headers not terminated"
    data_start = header_end + 4
    end = body.find(b"\r\n" + delimiter, data_start)
    if end < 0:
        return None, "closing boundary not found"
    headers = body[start:header_end].decode("latin-1")
    return {"headers": headers, "bytes": end - data_start}, None


class Store:
    def __init__(self, out):
        self.out = out
        self.files_dir = out / "files"
        self.files_dir.mkdir(parents=True)
        self.routes = {}
        self.file_bytes = {}
        self.leftover_origin = []

    def put(self, path, content_type, body):
        if is_json(content_type):
            body = body.replace(ORIGIN.encode(), PLACEHOLDER)
            # Orthanc derives URLs from the Host header; anything still absolute would leak a build host.
            if b"127.0.0.1" in body or b"localhost" in body:
                self.leftover_origin.append(path)
        digest = hashlib.sha256(body).hexdigest()[:24]
        rel = "files/" + digest
        if digest not in self.file_bytes:
            (self.files_dir / digest).write_bytes(body)
            self.file_bytes[digest] = len(body)
        self.routes[path] = {"file": rel, "type": content_type, "bytes": len(body)}
        return digest


class Builder:
    def __init__(self):
        self.started = time.time()
        self.store = None
        self.failures = []
        self.warnings = []
        self.frame_types = {}
        self.uid_mismatches = []
        self.upload_log = []
        self.studies = []
        self.manifest = {}

    def fail(self, path, status, reason, study=None):
        entry = {"path": path, "status": status, "reason": reason}
        if study:
            entry["study"] = study
        self.failures.append(entry)
        print(f"  FAIL {status} {path}: {reason}")

    def warn(self, message):
        self.warnings.append(message)
        print("  WARN " + message)

    # ---- container -------------------------------------------------------
    def start_orthanc(self):
        docker("rm", "-f", CONTAINER)  # only a stale copy of this build's own container
        result = docker(*DOCKER_RUN[1:])
        if result.returncode != 0:
            raise RuntimeError("docker run failed: " + result.stderr.strip())
        deadline = time.time() + 120
        while time.time() < deadline:
            status, _, _ = http("GET", "/system", accept="application/json", timeout=5)
            if status == 200:
                status, _, _ = http("GET", "/dicom-web/studies", accept=ACCEPT_JSON, timeout=10)
                if status == 200:
                    return
            time.sleep(1)
        logs = docker("logs", "--tail", "40", CONTAINER)
        raise RuntimeError("Orthanc did not become ready:\n" + logs.stdout + logs.stderr)

    # ---- upload ----------------------------------------------------------
    def upload_folder(self, folder):
        root = SAMPLES / folder
        study_ids, uploaded, skipped, statuses = [], 0, [], {}
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            for name in sorted(filenames):
                path = Path(dirpath) / name
                data = path.read_bytes()
                if len(data) < 132 or data[128:132] != b"DICM":
                    skipped.append(str(path.relative_to(root)))
                    continue
                status, _, body = http("POST", "/instances", body=data, content_type="application/dicom")
                if status != 200:
                    self.fail("/instances", status, f"upload {path.relative_to(SAMPLES)}: {body[:200]!r}", folder)
                    continue
                answer = json.loads(body)
                statuses[answer.get("Status")] = statuses.get(answer.get("Status"), 0) + 1
                uploaded += 1
                if answer["ParentStudy"] not in study_ids:
                    study_ids.append(answer["ParentStudy"])
        self.upload_log.append({"folder": folder, "uploaded": uploaded, "statuses": statuses,
                                "skipped_non_dicom": skipped, "orthanc_studies": study_ids})
        print(f"  uploaded {uploaded} {statuses}, skipped {len(skipped)} non-DICOM")
        if len(study_ids) != 1:
            self.warn(f"{folder}: {len(study_ids)} Orthanc studies from one folder")
        return study_ids

    # ---- fetch helpers ---------------------------------------------------
    def fetch_store(self, path, accept, study, files):
        status, content_type, body = http("GET", path, accept=accept)
        if status != 200:
            self.fail(path, status, body[:200].decode("utf-8", "replace"), study)
            return None
        files.add(self.store.put(path, content_type, body))
        return status, content_type, body

    # ---- study -----------------------------------------------------------
    def build_study(self, folder, orthanc_study):
        entry = self.manifest[folder]
        info = get_json(f"/studies/{orthanc_study}")
        study_uid = info["MainDicomTags"]["StudyInstanceUID"]
        if study_uid != entry.get("study_uid"):
            self.uid_mismatches.append({"folder": folder, "manifest": entry.get("study_uid"), "orthanc": study_uid})
            self.warn(f"{folder}: Orthanc StudyInstanceUID {study_uid} != manifest {entry.get('study_uid')}")
        files = set()
        st = study_uid

        status, _, body = http("GET", f"/dicom-web/studies?StudyInstanceUID={urllib.parse.quote(st)}&includefield=all",
                               accept=ACCEPT_JSON)
        qido = None
        if status == 200:
            rows = json.loads(body.replace(ORIGIN.encode(), PLACEHOLDER))
            if len(rows) != 1:
                self.warn(f"{st}: QIDO returned {len(rows)} rows")
            qido = rows[0] if rows else None
        else:
            self.fail(f"/dicom-web/studies?StudyInstanceUID={st}", status, body[:200].decode("utf-8", "replace"), st)

        series_to_orthanc, sop_to_orthanc, orthanc_instances = {}, {}, []
        for orthanc_series in info["Series"]:
            series_info = get_json(f"/series/{orthanc_series}")
            series_to_orthanc[series_info["MainDicomTags"]["SeriesInstanceUID"]] = orthanc_series
            for orthanc_instance in series_info["Instances"]:
                instance_info = get_json(f"/instances/{orthanc_instance}")
                sop_to_orthanc[instance_info["MainDicomTags"]["SOPInstanceUID"]] = orthanc_instance
                orthanc_instances.append(orthanc_instance)

        for suffix in ("series", "instances", "metadata"):
            self.fetch_store(f"/dicom-web/studies/{st}/{suffix}", ACCEPT_JSON, st, files)

        modalities, frame_count, expected_frames, bulk_count = set(), 0, 0, 0
        for se in series_to_orthanc:
            base = f"/dicom-web/studies/{st}/series/{se}"
            fetched = self.fetch_store(base + "/metadata", ACCEPT_JSON, st, files)
            self.fetch_store(base + "/instances", ACCEPT_JSON, st, files)
            if not fetched:
                continue
            metadata = json.loads(fetched[2])
            frames_done, bulk = set(), []
            for dataset in metadata:
                sop = first_value(dataset, "00080018")
                modality = first_value(dataset, "00080060")
                if modality:
                    modalities.add(modality)
                if "7FE00010" in dataset or "00280010" in dataset:
                    frames = int(float(str(first_value(dataset, "00280008", 1))))
                    expected_frames += frames
                    stored = 0
                    for n in range(1, frames + 1):
                        result = self.fetch_store(f"{base}/instances/{sop}/frames/{n}", ACCEPT_FRAMES, st, files)
                        if result:
                            stored += 1
                            normal = re.sub(r'boundary=("?)[^;"]+\1', "boundary=<per-response>", result[1], flags=re.I)
                            seen = self.frame_types.setdefault(normal, {"count": 0, "example": result[1]})
                            seen["count"] += 1
                    frame_count += stored
                    if stored == frames:
                        frames_done.add(sop)
                bulk.extend((sop, tag, uri) for tag, uri in bulk_uris(dataset))
            seen_paths = set()
            for sop, tag, uri in bulk:
                path = route_path(uri)
                if path in seen_paths or path in self.store.routes:
                    continue
                seen_paths.add(path)
                if re.search(r"/frames/[^/]*$", path) or (tag == "7FE00010" and sop in frames_done):
                    continue
                status, content_type, body = http("GET", path, accept=ACCEPT_BULK)
                if 400 <= status < 500:
                    status, content_type, body = http("GET", path, accept=ACCEPT_FRAMES)
                if status != 200:
                    self.fail(path, status, f"bulk {tag}: {body[:200].decode('utf-8', 'replace')}", st)
                    continue
                files.add(self.store.put(path, content_type, body))
                bulk_count += 1

        preview_count = 0
        for orthanc_instance in orthanc_instances:
            if self.fetch_store(f"/instances/{orthanc_instance}/preview", "image/png", st, files):
                preview_count += 1

        if expected_frames != frame_count:
            self.warn(f"{st}: stored {frame_count} of {expected_frames} frames")
        study_bytes = sum(self.store.file_bytes[digest] for digest in files)
        citations = [c.get("citation_text_required") for c in entry.get("required_citations") or []]
        self.studies.append({
            "studyUid": st,
            "qido": qido,
            "modalities": sorted(modalities),
            "seriesCount": len(series_to_orthanc),
            "instanceCount": len(sop_to_orthanc),
            "frameCount": frame_count,
            "bytes": study_bytes,
            "sopToOrthanc": sop_to_orthanc,
            "seriesToOrthanc": series_to_orthanc,
            "source": {
                "collection": entry.get("collection"),
                "folder": folder,
                "patient_id_as_published": entry.get("patient_id_as_published"),
                "description": entry.get("description"),
                "licenses": entry.get("licenses"),
                "collection_dois": entry.get("collection_dois"),
                "citation": citations[0] if len(citations) == 1 else citations,
                "study_uid": entry.get("study_uid"),
                "modalities": entry.get("modalities"),
            },
        })
        print(f"  {st}: {sorted(modalities)} series={len(series_to_orthanc)} instances={len(sop_to_orthanc)} "
              f"frames={frame_count} bulk={bulk_count} previews={preview_count} MB={study_bytes / 1e6:.1f}")

    # ---- outputs ---------------------------------------------------------
    def attribution(self):
        lines = [
            "# Attribution",
            "",
            "These are public de-identified TCIA (The Cancer Imaging Archive) sample studies, used unchanged "
            "under their Creative Commons Attribution (CC BY) licences.",
            "",
        ]
        for study in self.studies:
            source = study["source"]
            entry = self.manifest[source["folder"]]
            lines += [f"## {source['collection']} / {source['patient_id_as_published']} / {study['studyUid']}", ""]
            lines.append(f"- Collection: {source['collection']}")
            lines.append(f"- Folder: `{source['folder']}`")
            lines.append(f"- Modalities: {', '.join(study['modalities'])}")
            for doi in source.get("collection_dois") or []:
                lines.append(f"- DOI: {doi}")
            for licence in source.get("licenses") or []:
                lines.append(f"- Licence: {licence.get('name')} ({licence.get('url')})")
            for citation in entry.get("required_citations") or []:
                lines += ["", f"Required citation ({citation.get('doi_url') or citation.get('doi')}):", "",
                          "```text", citation.get("citation_text_required") or "", "```"]
            lines.append("")
        (self.store.out / "ATTRIBUTION.md").write_text("\n".join(lines), encoding="utf-8")

    def verify(self):
        missing, size_mismatch = [], []
        for path, route in self.store.routes.items():
            target = self.store.out / route["file"]
            if not target.is_file():
                missing.append(path)
            elif target.stat().st_size != route["bytes"]:
                size_mismatch.append(path)
        frame_routes = [p for p in self.store.routes if "/frames/" in p]
        frame_missing = [p for p in frame_routes if p in missing]
        per_study = {}
        for study in self.studies:
            prefix = f"/dicom-web/studies/{study['studyUid']}/"
            sample = next((p for p in frame_routes if p.startswith(prefix)), None)
            if not sample:
                per_study[study["studyUid"]] = {"ok": False, "reason": "no frame route"}
                continue
            route = self.store.routes[sample]
            part, error = multipart_first_part(route["type"], (self.store.out / route["file"]).read_bytes())
            per_study[study["studyUid"]] = {"route": sample, "ok": bool(part and part["bytes"] > 0),
                                            "first_part": part, "error": error}
        files_bytes = sum(f.stat().st_size for f in self.store.files_dir.iterdir())
        total_bytes = sum(f.stat().st_size for f in self.store.out.rglob("*") if f.is_file())
        return {
            "routes": len(self.store.routes),
            "frame_routes": len(frame_routes),
            "missing_files": missing,
            "frame_routes_missing": frame_missing,
            "size_mismatch": size_mismatch,
            "multipart_first_part": per_study,
            "files_count": len(self.store.file_bytes),
            "files_bytes": files_bytes,
            "total_bytes_on_disk": total_bytes,
        }

    def run(self):
        manifest = json.loads((SAMPLES / "manifest.json").read_text(encoding="utf-8"))
        by_folder = {s.get("folder"): s for s in manifest["studies"]}
        for folder in FOLDERS:
            if folder not in by_folder:
                raise RuntimeError(f"manifest has no study for {folder}")
            self.manifest[folder] = by_folder[folder]

        if OUT.exists():
            shutil.rmtree(OUT)
        self.store = Store(OUT)

        image_id = docker("image", "inspect", IMAGE, "--format", "{{.Id}}").stdout.strip()
        orthanc = {}
        try:
            print("starting " + CONTAINER)
            self.start_orthanc()
            container_image = docker("inspect", CONTAINER, "--format", "{{.Image}}").stdout.strip()
            system = get_json("/system")
            orthanc = {"version": system.get("Version"), "container_image_id": container_image}
            status, _, body = http("GET", "/plugins/dicom-web", accept="application/json")
            if status == 200:
                orthanc["dicomweb_plugin"] = json.loads(body).get("Version")

            targets = []
            for folder in FOLDERS:
                print("upload " + folder)
                targets += [(folder, study) for study in self.upload_folder(folder)]
            for folder, study in targets:
                print("fetch " + folder)
                self.build_study(folder, study)
        finally:
            removed = docker("rm", "-f", CONTAINER)
            print(f"removed {CONTAINER}: exit {removed.returncode}")

        for path in self.store.leftover_origin:
            self.warn(f"absolute host still present in JSON body of {path}")
        (OUT / "routes.json").write_text(json.dumps(dict(sorted(self.store.routes.items())), indent=1), encoding="utf-8")
        (OUT / "studies.json").write_text(json.dumps(self.studies, indent=1, ensure_ascii=False), encoding="utf-8")
        self.attribution()
        verification = self.verify()
        counts = {
            "studies": len(self.studies),
            "series": sum(s["seriesCount"] for s in self.studies),
            "instances": sum(s["instanceCount"] for s in self.studies),
            "frames": sum(s["frameCount"] for s in self.studies),
            "routes": len(self.store.routes),
            "files": len(self.store.file_bytes),
            "preview_routes": sum(1 for p in self.store.routes if p.endswith("/preview")),
            "bulk_routes": sum(1 for p in self.store.routes if "/bulk/" in p),
        }
        log = {
            "built_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "elapsed_seconds": round(time.time() - self.started, 1),
            "docker": {"image": IMAGE, "image_id": image_id, "container": CONTAINER, "run": DOCKER_RUN},
            "orthanc": orthanc,
            "counts": counts,
            "frame_content_types": self.frame_types,
            "uid_mismatches": self.uid_mismatches,
            "upload": self.upload_log,
            "failures": self.failures,
            "warnings": self.warnings,
            "verification": verification,
        }
        (OUT / "build-log.json").write_text(json.dumps(log, indent=1, ensure_ascii=False), encoding="utf-8")

        print("\nstudy | modalities | series | instances | frames | MB")
        for study in self.studies:
            print(f"{study['source']['folder']} | {','.join(study['modalities'])} | {study['seriesCount']} | "
                  f"{study['instanceCount']} | {study['frameCount']} | {study['bytes'] / 1e6:.1f}")
        print(f"total on disk MB {verification['total_bytes_on_disk'] / 1e6:.1f}; routes {counts['routes']}; "
              f"failures {len(self.failures)}; elapsed {log['elapsed_seconds']}s")
        print("frame content types: " + json.dumps(self.frame_types, indent=1))
        ok = (not verification["missing_files"] and not verification["size_mismatch"]
              and all(v["ok"] for v in verification["multipart_first_part"].values()))
        print("verification " + ("OK" if ok else "FAILED: " + json.dumps(verification)[:2000]))
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(Builder().run())
