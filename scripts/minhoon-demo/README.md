# Minhoon remote demo (D1872) — operator notes

Synthetic stack of one exact main SHA on the rehearsal VM 210.109.80.52, served at `https://210.109.80.52/`
(self-signed, port 443 is the only port the cloud firewall passes). Public samples only; synthetic accounts only.
Tooling only: nothing here changes the product. Doctor-facing guide: [guide-ko.md](guide-ko.md) (no credentials in it).

## Run it
```powershell
# deploy github main (or -Sha <40-hex>); watches up to -WaitMin minutes, exit 10 = still running
powershell -File scripts\minhoon-demo\deploy.ps1 [-Sha <sha>] [-HoldMinutes 480]
powershell -File scripts\minhoon-demo\deploy.ps1 -Name <run> -Watch      # repeat until READY (exit 0) or FAILED (1)
# re-verify the public URL any time (new output dir each time)
python -B scripts\minhoon-demo\demo_verify.py --credentials <evidence>\credentials.json --inventory <evidence>\inventory.json --output <evidence>\verify-2
# stop: closes 443, removes containers/volumes and the demo secrets, pulls the run logs
powershell -File scripts\minhoon-demo\teardown.ps1 -Name <run> [-PurgeSamples]
```
Evidence: `C:\Users\norne\PACS\tmp\astra-control\evidence\minhoon-demo-runs\<run>\` (`deploy-state.json`, step logs,
`load.json` with SHA-256 read-back per original, `seed.json`, `verify\verify.json` + screenshots, `teardown.json`) and
`evidence\vm-runs\<run>\` (vm-run result, container logs). **Test passwords exist only in `<run>\credentials.json`**;
send the two accounts (`reader`, `clinician`) to the doctor separately. `seed` is the internal account that authors the
synthetic prior reports.

## What deploy does
1. Generates secrets, a reduced realm (service account + three `kin-test-*` members of `/kin-center`; redirect URIs for
   the public origin) and ships them to the VM inbox. Housekeeps the VM if free disk < 14 GiB.
2. `vm-run.ps1 -CmdFile vm/demo-vm.sh`: the checkout's `docker-compose.yml` + `vm/compose.demo.yml` (production API image,
   synthetic signing key, self-signed cert for the IP, only 443 public, Orthanc on VM loopback). The run **holds the VM
   heavy lock while the demo is up**; other VM runs queue until teardown. `-HoldMinutes` is the auto-stop.
3. Ships the originals the VM cache `/srv/kin-heavy/demo-samples` lacks (`scp -r` per series folder, ~9.5 MB/s measured;
   `deploy.ps1 -PrefillSamples` fills the cache ahead without a stack, so a deploy normally ships nothing), then runs
   the checkout's `scripts/mgxa_acceptance.py load` on the VM (empty Orthanc, SHA-256 before and after), binds the study
   UIDs to `kin-center` (as `scripts/mgxa_fixture.py` does) and provisions synthetic signing keys
   (`tests/emr/d/provision_synthetic.cjs`, which is why the usernames start with `kin-test-`).
4. Approves synthetic prior reports (CT x2, MG x1) through the real BFF/API, then runs `demo_verify.py`.
A failure after launch tears the stack down automatically (logs kept).

## Samples
CT: TCIA TCGA-KIRC `TCGA-CW-5580` (1992-06-01 / prior 1992-02-25) and `TCGA-B8-A54F` (2006-01-12 / prior 2005-08-03),
CC BY 3.0. MG: TCIA EA1141 `EA1141-4339969` DBT + Intelligent 2D (1945-02-13 / prior 1944-02-21), CC BY 4.0.
XA: GDCMData 12-frame catheter cine (no licence file in the repository). The licence terms are CC BY (attribution
lines are in the guide). The "local test only" / "not uploaded" lines in the collectors' notes record the scope of
those download runs, not a licence condition (user, 2026-10-26). `-SkipXa` drops the XA clip.
