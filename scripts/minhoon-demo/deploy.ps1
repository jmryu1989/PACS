param(
  # Exact main SHA to deploy. Default: the current github main head.
  [string]$Sha,
  # Run name (single-use, also the vm-run name). Default: minhoon-demo-<sha7>-<utc>.
  [string]$Name,
  # How long the stack may stay up (vm-run hang timeout). teardown.ps1 stops it earlier.
  [int]$HoldMinutes = 480,
  # Queue for the VM heavy lock this long when another run holds it.
  [int]$WaitLockMin = 60,
  # Foreground watch budget per call (headless callers keep it under their 10-minute tool limit; re-run with -Watch).
  [int]$WaitMin = 9,
  [switch]$Watch,
  [switch]$SkipXa,
  [switch]$SkipVerify,
  [string]$PublicIp = '210.109.80.52',
  [int]$OrthancPort = 18042,
  [string]$Samples = 'C:\Users\norne\PACS\tmp\dicom-samples',
  [string]$EvidenceRoot = 'C:\Users\norne\PACS\tmp\astra-control\evidence\minhoon-demo-runs',
  # vm-run priority lane (D1858): only when the commander designates the demo as the critical path.
  [switch]$Priority,
  # Only fill the VM's public-sample cache (no stack, no VM lock); later deploys then ship nothing.
  [switch]$PrefillSamples,
  [switch]$Drive   # internal: the detached driver
)
# Synthetic remote demo for Minhoon (D1872): deploy one main SHA as the synthetic stack on the rehearsal VM through
# vm-run.ps1, load public samples, create synthetic accounts, expose HTTPS on 443 (self-signed). Synthetic data only.
# The driver runs detached and records every step in <evidence>\deploy-state.json; this call only watches it.
#   deploy.ps1                       start a new deployment of github main, watch up to -WaitMin
#   deploy.ps1 -Name <run> -Watch    keep watching a running deployment
# Exit: 0 = ready (and verified unless -SkipVerify), 10 = still running (re-run with -Watch), 1 = failed.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = (Resolve-Path "$here\..\..").Path
$vmRun = 'C:\Users\norne\PACS\tmp\astra-control\fable-tools\scratch-bc12ddf5\vm-run.ps1'
$vmEvidence = 'C:\Users\norne\PACS\tmp\astra-control\evidence\vm-runs'
$kh = 'C:\Users\norne\PACS\tmp\astra-control\evidence\interim-release-prep-20261012\rehearsal-known_hosts'
$vmHost = 'ubuntu@210.109.80.52'
$sshOpts = @('-i', 'C:\Users\norne\PACS\kin-key.pem', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-o', "UserKnownHostsFile=$kh")
$origin = "https://$PublicIp"

function VmSsh([string]$c) { $o = & ssh @sshOpts $vmHost $c; $script:lastSsh = $LASTEXITCODE; return ($o -join "`n") }
function Utc { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
function StatePath([string]$n) { Join-Path (Join-Path $EvidenceRoot $n) 'deploy-state.json' }
function ReadState([string]$n) { Get-Content -Raw -Encoding utf8 (StatePath $n) | ConvertFrom-Json }
function WriteState($s) { [IO.File]::WriteAllText((StatePath $s.name), ($s | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false)) }
function Step($s, [string]$step, [string]$status, [string]$detail) {
  $s.steps += [pscustomobject]@{ step = $step; status = $status; at = (Utc); detail = $detail }
  $s.phase = "$step`:$status"; WriteState $s
  Add-Content -Encoding utf8 (Join-Path (Join-Path $EvidenceRoot $s.name) 'driver.log') "$(Utc) $step $status $detail"
}
function Py([string]$log, [string[]]$a) {
  # cmd's redirection keeps Python's UTF-8 bytes (PowerShell 5.1 would re-encode them and turn stderr into errors).
  $env:PYTHONIOENCODING = 'utf-8'
  $line = 'python -B ' + (($a | ForEach-Object { '"' + $_ + '"' }) -join ' ') + " > `"$log`" 2>&1"
  & cmd /c $line
  return $LASTEXITCODE
}
function LastLine([string]$f) { ((Get-Content -Raw -Encoding utf8 $f).Trim() -split "`n")[-1] }
$cache = '/srv/kin-heavy/demo-samples'
function ShipSamples([string]$dir, [string]$inv) {
  # Ship the originals the VM cache lacks (path + size; the VM loader re-hashes every file). scp -r per series folder:
  # piping a tar stream or a tunnel through Windows OpenSSH measured ~2 MB/s on 2026-10-26, scp ~9.5 MB/s.
  $listing = VmSsh "mkdir -p $cache && cd $cache && find . -type f -printf '%P\t%s\n'"
  if ($lastSsh) { throw 'cache listing failed' }
  [IO.File]::WriteAllText("$dir\cache-listing.tsv", "$listing`n", (New-Object Text.UTF8Encoding $false))
  $code = Py "$dir\stage.log" @("$here\demo_setup.py", 'stage', '--inventory', $inv, '--listing', "$dir\cache-listing.tsv",
    '--need', "$dir\ship-list.txt", '--output', "$dir\inventory-vm.json")
  if ($code) { throw "stage exit=$code" }
  $folders = @(Get-Content "$dir\ship-list.txt" | Where-Object { $_ } | ForEach-Object { $_ -replace '/[^/]+$', '' } | Sort-Object -Unique)
  foreach ($rel in $folders) {
    $parent = $rel -replace '/[^/]+$', ''
    $null = VmSsh "mkdir -p $cache/$parent"
    & scp @sshOpts -q -r (Join-Path $Samples ($rel -replace '/', '\')) "${vmHost}:$cache/$parent/"
    if ($LASTEXITCODE) { throw "scp $rel failed ($LASTEXITCODE)" }
    Add-Content -Encoding utf8 "$dir\ship-samples.log" "$(Utc) shipped $rel"
  }
  return "$(LastLine "$dir\stage.log") folders_shipped=$($folders.Count)"
}

# ------------------------------------------------------------------------------------------------ driver
if ($Drive) {
  $s = ReadState $Name
  $dir = Join-Path $EvidenceRoot $Name
  $launched = $false
  try {
    # 1. secrets + realm (passwords only in credentials.json) and the VM inbox
    $stage = Join-Path $env:TEMP "kin-minhoon-demo\$Name"
    $realmSrc = Join-Path $stage 'realm-source.json'
    New-Item -ItemType Directory -Force (Split-Path $stage) | Out-Null
    & git -C $root fetch -q origin $s.sha; if ($LASTEXITCODE) { throw "git fetch $($s.sha) failed" }
    $null = New-Item -ItemType Directory $stage
    & cmd /c "git -C `"$root`" show $($s.sha):keycloak/kin-realm.json > `"$realmSrc`""; if ($LASTEXITCODE) { throw 'git show realm failed' }
    $stageVm = Join-Path $stage 'vm'
    $code = Py "$dir\prepare.log" @("$here\demo_setup.py", 'prepare', '--evidence', $dir, '--stage', $stageVm, '--origin', $origin,
      '--realm-source', $realmSrc, '--name', $Name, '--sha', $s.sha)
    if ($code) { throw "prepare exit=$code" }
    foreach ($f in 'compose.demo.yml', 'ctl.sh') {
      [IO.File]::WriteAllText((Join-Path $stageVm $f), ([IO.File]::ReadAllText("$here\vm\$f") -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
    }
    [IO.File]::WriteAllText((Join-Path $stageVm 'params'), "PUBLIC_IP=$PublicIp`nDEMO_ORTHANC_PORT=$OrthancPort`nREADY_TIMEOUT_SEC=1800`n", (New-Object Text.UTF8Encoding $false))
    Step $s 'prepare' 'ok' "credentials=$dir\credentials.json"

    # 2. disk: the MG DBT originals alone are 6.5 GB in Orthanc. Housekeep (finished run dirs >6 h, old images) if short.
    $df = VmSsh "df -BG --output=avail / | tail -1; cat /var/tmp/kin-heavy.holder 2>/dev/null | head -2"
    $avail = [int](($df -split "`n")[0] -replace '[^0-9]', '')
    $hk = 'not needed'
    if ($avail -lt 14) {
      $hkScript = 'C:\Users\norne\PACS\tmp\astra-control\fable-tools\scratch-bc12ddf5\vm-housekeep.sh'
      $hk = (([IO.File]::ReadAllText($hkScript) -replace "`r`n", "`n") | & ssh @sshOpts $vmHost 'bash -s') -join ' | '
      $df = VmSsh "df -BG --output=avail / | tail -1"; $avail = [int]($df -replace '[^0-9]', '')
    }
    Step $s 'disk' 'ok' "avail_gib=$avail housekeep=$hk"
    if ($avail -lt 11) { throw "VM free disk ${avail}G is below the measured need (6.5 GB samples + images + margin)" }

    $inbox = "/srv/kin-heavy/in/minhoon-demo-$Name"
    $null = VmSsh "mkdir -m 700 $inbox"; if ($lastSsh) { throw "cannot create $inbox" }
    $files = @(Get-ChildItem -File $stageVm | ForEach-Object { $_.FullName })
    & scp @sshOpts -q @files "${vmHost}:$inbox/"; if ($LASTEXITCODE) { throw 'scp inbox failed' }
    Remove-Item -Recurse -Force $stage   # the realm copy held the test passwords; credentials.json is the only copy left
    Step $s 'ship' 'ok' $inbox

    # 3. vm-run launch (detached on the VM). The vm-run poller is stopped once launched; teardown.ps1 re-attaches to pull.
    $runLog = Join-Path $dir 'vm-run-launch.log'
    $vmArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $vmRun, '-Sha', $s.sha, '-Name', $Name, '-CmdFile', "$here\vm\demo-vm.sh",
      '-TimeoutMin', $HoldMinutes, '-WaitLockMin', $WaitLockMin, '-Collect', 'none-collected')
    if ($Priority) { $vmArgs += '-Priority' }
    $p = Start-Process powershell -WindowStyle Hidden -PassThru -RedirectStandardOutput $runLog -RedirectStandardError "$runLog.err" -ArgumentList $vmArgs
    $laptopLog = Join-Path (Join-Path $vmEvidence $Name) 'laptop.log'
    $deadline = (Get-Date).AddMinutes(10)
    while (-not ((Test-Path $laptopLog) -and (Select-String -Quiet -Path $laptopLog -Pattern '^launch exit='))) {
      if ($p.HasExited -or (Get-Date) -gt $deadline) { throw "vm-run launch did not report (see $runLog)" }
      Start-Sleep 3
    }
    $launch = (Select-String -Path $laptopLog -Pattern '^launch exit=' | Select-Object -First 1).Line
    Start-Sleep 2; if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
    if ($launch -notmatch '^launch exit=0') { throw "vm-run launch failed: $launch" }
    $launched = $true
    Step $s 'launch' 'ok' $launch

    # 4. wait for the stack (lock wait + build + readiness)
    $deadline = (Get-Date).AddMinutes($WaitLockMin + 45); $last = ''
    while ($true) {
      $ph = VmSsh "echo state=`$(cat /srv/kin-heavy/runs/$Name/state 2>/dev/null) phase=`$(cat /srv/kin-heavy/runs/$Name/demo/phase 2>/dev/null)"
      if ($ph -ne $last) { Step $s 'vm' 'progress' $ph; $last = $ph }
      if ($ph -match 'phase=ready') { break }
      if ($ph -match 'phase=failed|state=(done|refused|aborted)') { throw "VM stack did not come up: $ph" }
      if ((Get-Date) -gt $deadline) { throw "VM stack not ready in time: $ph" }
      Start-Sleep 15
    }
    Step $s 'ready' 'ok' $origin

    # 5. public originals: fill the VM sample cache, load them with the checkout's mgxa_acceptance.py on the VM
    #    (next to the loopback Orthanc), bind to kin-center, provision synthetic signing keys
    $inv = Join-Path $dir 'inventory.json'
    $invArgs = @("$here\demo_setup.py", 'inventory', '--samples', $Samples, '--output', $inv)
    if ($SkipXa) { $invArgs += '--skip-xa' }
    $code = Py "$dir\inventory.log" $invArgs; if ($code) { throw "inventory exit=$code" }
    Step $s 'ship-samples' 'running' 'checking the VM sample cache'
    Step $s 'ship-samples' 'ok' (ShipSamples $dir $inv)
    $demo = "/srv/kin-heavy/runs/$Name/demo"
    & scp @sshOpts -q "$dir\inventory-vm.json" "${vmHost}:$demo/inventory.json"; if ($LASTEXITCODE) { throw 'scp inventory failed' }
    Step $s 'load' 'running' 'mgxa_acceptance.py load on the VM (empty-Orthanc check, SHA-256 before and after upload)'
    $studies = (& python -c "import json,sys;print(' '.join(json.load(open(sys.argv[1],encoding='utf-8'))['demo']['studies']))" $inv).Trim()
    $loadOut = VmSsh "bash $demo/ctl.sh $Name load $studies"; $loadExit = $lastSsh
    [IO.File]::WriteAllText("$dir\load.log", "$loadOut`nexit=$loadExit`n", (New-Object Text.UTF8Encoding $false))
    & scp @sshOpts -q "${vmHost}:$demo/load.json" "$dir\load.json"
    if ($loadExit) { throw "VM load exit=$loadExit (see load.log, load.json)" }
    $code = Py "$dir\bind.log" @("$here\demo_setup.py", 'bind', '--name', $Name, '--inventory', $inv, '--load-result', "$dir\load.json",
      '--output', "$dir\bind-provision.json")
    if ($code) { throw "bind/provision exit=$code (see bind.log)" }
    Step $s 'load' 'ok' (LastLine "$dir\bind.log")

    # 6. synthetic prior reports (approved by the seeding reader) for Related Report and the clinician view
    $code = Py "$dir\seed.log" @("$here\demo_setup.py", 'seed', '--credentials', "$dir\credentials.json", '--inventory', $inv,
      '--timeout', 120, '--output', "$dir\seed.json")
    if ($code) { throw "seed exit=$code (see seed.log, seed.json)" }
    Step $s 'seed' 'ok' (LastLine "$dir\seed.log")

    # 7. public-URL verification from the laptop
    if (-not $SkipVerify) {
      $code = Py "$dir\verify.log" @("$here\demo_verify.py", '--credentials', "$dir\credentials.json", '--inventory', $inv,
        '--output', "$dir\verify")
      Step $s 'verify' $(if ($code) { 'fail' } else { 'ok' }) "exit=$code see $dir\verify\verify.json"
      if ($code) { $s.result = 'ready-verify-failed'; WriteState $s; exit 1 }
    }
    $s.result = 'ready'; WriteState $s
    exit 0
  } catch {
    $ErrorActionPreference = 'Continue'
    Step $s 'driver' 'fail' "$_"
    # A half-built stack would hold the VM heavy lock for -HoldMinutes: stop it and pull its logs for inspection.
    if ($launched) {
      Step $s 'auto-teardown' 'running' 'stack stopped after the failure; logs are pulled to the vm-run evidence'
      & powershell -NoProfile -ExecutionPolicy Bypass -File "$here\teardown.ps1" -Name $Name -EvidenceRoot $EvidenceRoot *> "$dir\auto-teardown.log"
      Step $s 'auto-teardown' $(if ($LASTEXITCODE) { 'fail' } else { 'ok' }) "exit=$LASTEXITCODE"
    }
    $s.result = 'failed'; WriteState $s
    exit 1
  }
}

# ------------------------------------------------------------------------------------------------ prefill only
if ($PrefillSamples) {
  # Fill the VM sample cache ahead of a deploy (no stack, no lock); a deploy then ships nothing.
  $dir = Join-Path $EvidenceRoot ('prefill-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
  New-Item -ItemType Directory -Force $dir | Out-Null
  $inv = Join-Path $dir 'inventory.json'
  $invArgs = @("$here\demo_setup.py", 'inventory', '--samples', $Samples, '--output', $inv)
  if ($SkipXa) { $invArgs += '--skip-xa' }
  $code = Py "$dir\inventory.log" $invArgs; if ($code) { throw "inventory exit=$code" }
  $r = ShipSamples $dir $inv
  "prefill done: $r evidence=$dir"
  exit 0
}

# ------------------------------------------------------------------------------------------------ start / watch
if (-not $Watch) {
  if (-not $Sha) {
    $line = (& git -C $root ls-remote origin refs/heads/main) -split "`t"
    $Sha = $line[0]
  }
  if ($Sha -notmatch '^[0-9a-f]{40}$') { throw "need a full 40-hex SHA (got '$Sha')" }
  if (-not $Name) { $Name = 'minhoon-demo-{0}-{1}' -f $Sha.Substring(0, 7), (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmZ') }
  if ($Name -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw "bad -Name '$Name'" }
  $dir = Join-Path $EvidenceRoot $Name
  if (Test-Path $dir) { throw "evidence dir exists: $dir (run names are single-use)" }
  New-Item -ItemType Directory -Force $dir | Out-Null
  $s = [pscustomobject]@{ name = $Name; sha = $Sha; origin = $origin; started = (Utc); hold_minutes = $HoldMinutes;
    vm_evidence = (Join-Path $vmEvidence $Name); phase = 'starting'; result = $null; steps = @() }
  WriteState $s
  $drv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Drive', '-Name', $Name, '-HoldMinutes', $HoldMinutes,
    '-WaitLockMin', $WaitLockMin, '-PublicIp', $PublicIp, '-OrthancPort', $OrthancPort, '-Samples', $Samples, '-EvidenceRoot', $EvidenceRoot)
  if ($SkipXa) { $drv += '-SkipXa' }; if ($SkipVerify) { $drv += '-SkipVerify' }; if ($Priority) { $drv += '-Priority' }
  Start-Process powershell -WindowStyle Hidden -ArgumentList $drv -RedirectStandardOutput "$dir\driver.out" -RedirectStandardError "$dir\driver.err" | Out-Null
  "deploy name=$Name sha=$Sha origin=$origin evidence=$dir"
}
if (-not $Name) { throw '-Name is required with -Watch' }
$until = (Get-Date).AddMinutes($WaitMin); $last = ''
while ($true) {
  $s = ReadState $Name
  if ($s.phase -ne $last) { "$(Utc) $($s.phase)"; $last = $s.phase }
  if ($s.result -eq 'ready') { "READY $($s.origin) name=$Name sha=$($s.sha) credentials=$(Join-Path (Join-Path $EvidenceRoot $Name) 'credentials.json')"; exit 0 }
  if ($s.result) { "FAILED result=$($s.result) phase=$($s.phase) evidence=$(Join-Path $EvidenceRoot $Name)"; exit 1 }
  if ((Get-Date) -gt $until) { "STILL RUNNING phase=$($s.phase); re-run: deploy.ps1 -Name $Name -Watch"; exit 10 }
  Start-Sleep 10
}
