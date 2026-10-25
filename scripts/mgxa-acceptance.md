# Public MG/XA viewer preparation

Run from the candidate checkout. This is local technical observation, with doctor
acceptance recorded separately. No patient data, new download, DICOM rewriting or
product changes are involved. The source corpus must contain collector
`manifest.json` files and their accepted `studies/` or `repositories/` originals.
Keep the manifests' citations and restrictions with the observations.

Use Python with the existing `tests/e2e/requirements.txt`, pydicom 2.4.4 and
requests (local observations used 2.32.3; CI installs the existing 2.32.5 gateway pin),
Playwright Chromium, Docker, and Node on PATH. Obtain the host's exclusive heavy
slot and record free RAM once before setup/browser execution. Do not run against
another stack, original DB, original account or original volume. Retain failed
runs; use a new project/directory for another import. No automatic deletion occurs.

The commands below use PowerShell. Supply a corpus path, a fresh `mgxa-` project
name, and two free loopback ports. The example ports are selections, not required
product ports. The setup derives the API image and VCS_REF from this checkout's
HEAD; every artifact also records dirty state and executed script SHA-256.
Credentials, the generated realm and BFF storage state remain under local `tmp/`;
never copy them to evidence or Git.

```powershell
$samples = 'C:\path\to\public-dicom-corpus'
$project = 'mgxa-local-review'
$run = "tmp/$project"
$httpsPort = 19443
$orthancPort = 18042
New-Item -ItemType Directory -Path $run -ErrorAction Stop | Out-Null
python -B scripts/mgxa_acceptance.py inventory --root $samples `
  --set tcia-ea1141-dbt-20261009 --set xa-cine-20261024 --output "$run/inventory.json"
if ($LASTEXITCODE) { throw 'inventory failed' }
python -B scripts/mgxa_fixture.py setup --directory "$run/fixture" --project $project `
  --https-port $httpsPort --orthanc-port $orthancPort --timeout 2100 --request-timeout 180
if ($LASTEXITCODE) { throw 'setup failed; retain fixture for inspection' }

# This exercised selection covers both EA1141 dates (all DBT and generated 2D
# originals), and the GDCM 12-frame XA. Review inventory paths,
# source/licence and hashes before loading. No private selection file is needed.
$inventory = Get-Content -Raw "$run/inventory.json" | ConvertFrom-Json
$selected = @($inventory.files | Where-Object {
  ($_.collection -eq 'EA1141' -and $_.patient -eq 'EA1141-4339969') -or
  ($_.source -eq 'GDCMData' -and $_.sop -eq '999.999.1.19941016.083000.5.104')
})
if (!$selected.Count) { throw 'No selected public samples in this inventory' }
$selectionArgs = @()
$selected.study | Sort-Object -Unique | ForEach-Object { $selectionArgs += @('--study', $_) }
$selected.sop | Sort-Object -Unique | ForEach-Object { $selectionArgs += @('--sop', $_) }
python -B scripts/mgxa_fixture.py load-login --directory "$run/fixture" `
  --inventory "$run/inventory.json" @selectionArgs --timeout 180 --browser-timeout 60 `
  --output "$run/load.json"
if ($LASTEXITCODE) { throw 'load/bind/login failed; retain partial receipt' }
python -B scripts/mgxa_viewer_check.py --load-result "$run/load.json" `
  --origin "https://localhost:$httpsPort" --storage-state "$run/fixture/storage-state.json" `
  --timeout 60 --output "$run/viewer"
# Exit 1 means FAIL, PARTIAL or BLOCKED; inspect observations.json. Never relabel it PASS.
docker compose --env-file "$run/fixture/stack.env" -p $project -f "$run/fixture/compose.yml" stop
```

Record each invocation with `scripts/record-run.py --run-dir <new-log-directory>
--file <executed-script> -- <command>` under an outer hang timeout. The existing
local run measured a runtime close to 20 minutes: its outer timeout is 2100s,
large-original HTTP timeout 180s, browser action timeout 60s. Re-measure on a
different host. The timeout is a hang cutoff, not a clinical performance limit.

This is the scoped inventory/setup/load-login/viewer sequence exercised in fix
round 1, with fresh path/project placeholders above. Run costs and the interrupted
full-corpus inventory are retained in that round's `runs/*/run.json` manifests.
Do not substitute an unscoped inventory: it scans unrelated CT/MR originals too.
The earlier CMMD D2-0140 conventional-MG branch was not loaded or viewed; real
conventional-MG display acceptance remains **NOT_RUN**. Adding it requires its
collector set in the inventory and an explicit sample selection; it is not part
of the exercised commands above.

`load-login` calls the original-byte loader, binds exactly the read-back study
UIDs to the generated doctor's fixture institution in its own PostgreSQL, then
uses the normal HTTPS/BFF login. Setup refuses pre-existing project resources.
The loader requires empty Orthanc, compares original SHA-256 after upload and
retains partial receipts. This is fixture provisioning, not admin UI acceptance.

The viewer records every same-origin response, including `/api` failures. It
compares MG rendered spacing with the original per-frame/shared PixelMeasures
(DICOM row/column becomes renderer x/y), and the rendered window with stored
FrameVOILUT or top-level windows. Every mismatch is `FAIL/PRODUCT_OBSERVATION`.
It also records the real `imagePlaneModule` row/column cosines and position, plus
the rendered camera normal and focal point. Plane orientation must match the
requested frame's original PlaneOrientation. The camera focal point and available
plane position are projected onto that original normal: the unique nearest stored
PlanePosition must be the requested frame. An ambiguous nearest frame, missing
source geometry/window or missing orientation observation is `NOT_RUN`, never
calibration PASS. This nearest-frame check is not an absolute position-accuracy
claim (a single-plane object has no competing frame). There is no invented
tolerance. Camera movement alone cannot prove mm calibration.
Current/prior pairing independently checks original side, view and representation
kind. Zoom/Fit must preserve viewport, study, series, SOP and frame, and Fit must
restore the default scale. Both selected cine rates check a complete ordered loop
and Stop for one loop's duration; achieved FPS is separate from requested FPS.

`--case` selects a fresh subset run. It records available/selected/omitted cases,
merges no earlier artifacts and returns PARTIAL (or FAIL when a failure exists).
Whole-run status does not claim doctor acceptance. Local-only manifest scope or
licence applies to originals, screenshots and traces; the tool records and
consumes this restriction. Keep EA1141 and the GDCM sample local for this unit.

Known observations to carry into review:

- A prior L CC DBT pane in the two-date EA1141 comparison has been observed with
  pixel-unit geometry, default VOI and fallback orientation/position. The observed
  trigger is the default case order: open `mg-magnification-*` first (including
  study ending 084466), then `mg-real-prior-0` in the same browser context and
  Orthanc fixture. Frame 1 of SOP ending 054178 arrived ahead of the other frames.
  A cold direct comparison is not a reliable reproduction. The same SOP opened
  cold as a single study had calibrated spacing/VOI. Keep the finding open even
  if a subsequent run does not reproduce the timing condition.
- EA1141 enhanced single-frame GENERATED_2D panes have been observed with spacing
  1 instead of stored 0.064867 mm, W1023/L511.5 instead of stored W800/L512, and
  fallback plane orientation/position.
- DBT panes displaying frame 1 have used the last frame's plane position despite
  correct spacing/VOI. The geometry check treats these as open product failures.
- All three observations share a measured served-OHIF mechanism: `storeInstances`
  in `extensions/default/src/DicomWebDataSource` registers frame-1 image IDs without
  `frameNumber`; `platform/core/src/classes/MetadataProvider.ts` `_getInstance`
  therefore returns the unflattened instance, while
  `platform/core/src/utils/combineFrameInstance.ts` mutates that same instance with
  another frame's functional groups. These are embedded webpack module paths in
  the pinned Orthanc OHIF plugin, not KIN file:line pointers. Evidence is served
  bundle code plus run measurements; the review did not run a live metadata query.
  A display-only VOI/spacing override does not restore measurement calibration.
- The unchanged GDCM XA has a leading-zero UID component (`083000`) and invalid
  DA `1994.10.16`. Its viewer-jobs, viewer-items and findings calls return 400.
  It can support local decoding/cine observations, but cannot validate a complete
  worklist/report/save/reopen workflow. Do not rewrite the public original to hide this.
- Patient-ID prior search has returned 403. Capture it with the other refusals.

Still required outside this tool: doctor/equipment/date/version feedback,
grayscale/physical 1:1, tissue coverage, full DBT traversal and pane independence,
range/reverse/retry/reopening, report saving, source-timeline integration, and
first-site long-acquisition timing. Never infer diagnostic or doctor acceptance
from canvas pixels, screenshots, HTTP 200 or these technical checks.
