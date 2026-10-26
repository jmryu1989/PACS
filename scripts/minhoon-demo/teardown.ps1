param(
  [Parameter(Mandatory)][string]$Name,
  [string]$EvidenceRoot = 'C:\Users\norne\PACS\tmp\astra-control\evidence\minhoon-demo-runs',
  [string]$PublicIp = '210.109.80.52',
  # Also delete the VM's public-sample cache (/srv/kin-heavy/demo-samples, ~6.7 GB) once no further demo is planned.
  [switch]$PurgeSamples
)
# Stop the synthetic demo stack started by deploy.ps1 and close its public port (D1872).
# vm-run -Cancel sends TERM to the run; the VM command stops the compose project (down -v) and deletes the demo secrets,
# then vm-run's own cleanup removes any object the run created. -Attach waits for that and pulls the run's logs.
# Exit 0 = stopped, port 443 closed and cleanup ok; 1 otherwise (teardown.json says what is left).
$ErrorActionPreference = 'Continue'
$vmRun = 'C:\Users\norne\PACS\tmp\astra-control\fable-tools\scratch-bc12ddf5\vm-run.ps1'
$kh = 'C:\Users\norne\PACS\tmp\astra-control\evidence\interim-release-prep-20261012\rehearsal-known_hosts'
$vmHost = 'ubuntu@210.109.80.52'
$sshOpts = @('-i', 'C:\Users\norne\PACS\kin-key.pem', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ConnectTimeout=15', '-o', "UserKnownHostsFile=$kh")
function Utc { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
$dir = Join-Path $EvidenceRoot $Name
$state = Get-Content -Raw -Encoding utf8 (Join-Path $dir 'deploy-state.json') | ConvertFrom-Json
$t = [ordered]@{ name = $Name; sha = $state.sha; started = (Utc) }

$runState = ((& ssh @sshOpts $vmHost "cat /srv/kin-heavy/runs/$Name/state 2>/dev/null || echo missing") -join '').Trim()
$t.state_before = $runState
if ($runState -eq 'running') {
  # Stop the stack and delete the demo secrets explicitly; then end the run's hold loop.
  $t.stop = ((& ssh @sshOpts $vmHost "test -f /srv/kin-heavy/runs/$Name/demo/ctl.sh && bash /srv/kin-heavy/runs/$Name/demo/ctl.sh $Name stop || echo no-demo-dir") -join ' ').Trim()
}
if ($runState -notmatch '^(done|refused:|aborted|missing)') {
  $t.cancel =(& powershell -NoProfile -ExecutionPolicy Bypass -File $vmRun -Sha $state.sha -Name $Name -Cancel) -join ' '
}
if ($runState -ne 'missing') {
  # Polls until the run is final, then pulls result.json, logs and the containers' logs to evidence\vm-runs\<name>.
  $t.attach = (& powershell -NoProfile -ExecutionPolicy Bypass -File $vmRun -Sha $state.sha -Name $Name -Attach -PollSec 10) -join "`n"
  $t.attach_exit = $LASTEXITCODE   # the VM command's exit: 143 = stopped by this teardown
}
# A deploy that failed before the VM command started leaves its inbox (realm with test passwords): remove it.
$t.inbox = ((& ssh @sshOpts $vmHost "d=/srv/kin-heavy/in/minhoon-demo-$Name; if [ -e `$d ]; then rm -rf `$d && echo removed; else echo absent; fi") -join '').Trim()
if ($PurgeSamples) { $t.sample_cache = ((& ssh @sshOpts $vmHost 'rm -rf /srv/kin-heavy/demo-samples && echo purged') -join '').Trim() }
$t.left_on_vm =((& ssh @sshOpts $vmHost "docker ps -a -q --filter label=com.docker.compose.project=kh-$($Name.ToLower().Replace('.', '-')) | wc -l; test -d /srv/kin-heavy/runs/$Name/demo && echo demo-dir-present || echo demo-dir-absent") -join ' ').Trim()

$c = New-Object Net.Sockets.TcpClient
try { $open = $c.ConnectAsync($PublicIp, 443).Wait(5000) } catch { $open = $false } finally { $c.Close() }
$t.port_443_open = $open
$result = Join-Path "C:\Users\norne\PACS\tmp\astra-control\evidence\vm-runs\$Name" 'result.json'
if (Test-Path $result) { $r = Get-Content -Raw $result | ConvertFrom-Json; $t.vm_result = @{ state = $r.state; exit = $r.exit; cleanup_ok = $r.cleanup.ok } }
$t.finished = (Utc)
# A run cancelled or refused while queued for the lock never created anything, so it has no cleanup record.
$neverStarted = $t.vm_result -and ($t.vm_result.state -match '^(aborted:cancelled-waiting|refused:)')
$t.ok = (-not $open) -and ($t.left_on_vm -match '^0 demo-dir-absent') -and ($t.vm_result -and ($t.vm_result.cleanup_ok -or $neverStarted))
[IO.File]::WriteAllText((Join-Path $dir 'teardown.json'), ($t | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
"teardown name=$Name ok=$($t.ok) port443_open=$open left=$($t.left_on_vm) vm_exit=$($t.attach_exit) evidence=$dir\teardown.json"
if ($t.ok) { exit 0 } else { exit 1 }
