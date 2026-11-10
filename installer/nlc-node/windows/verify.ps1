param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [switch]$ExpectTools,
  [switch]$RequireTrust
)

$ErrorActionPreference = "Stop"

function Wait-NlcProcess {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$Operation,
    [int]$TimeoutMilliseconds = 60000
  )

  if (-not $Process.WaitForExit($TimeoutMilliseconds)) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    throw "NLC Node $Operation timed out."
  }
  if ($Process.ExitCode -ne 0) { throw "NLC Node $Operation failed with exit code $($Process.ExitCode)." }
}

function Wait-NlcPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Operation,
    [int]$TimeoutMilliseconds = 30000
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    if (Test-Path $Path) { return }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "NLC Node $Operation timed out."
}

if (-not (Test-Path $InstallerPath)) { throw "NLC Node installer is missing: $InstallerPath" }
if ($RequireTrust) {
  $signature = Get-AuthenticodeSignature -FilePath $InstallerPath
  if ($signature.Status -ne "Valid") { throw "NLC Node installer signature is not valid: $($signature.Status)" }
  & signtool.exe verify /pa /all /v $InstallerPath
  if ($LASTEXITCODE -ne 0) { throw "NLC Node signature verification failed." }
}

# The setup zip from a customer's NLC carries origin.txt beside the setup program; the installer must keep it.
$sidecar = Join-Path (Split-Path -Parent $InstallerPath) "origin.txt"
[System.IO.File]::WriteAllText($sidecar, "https://verify.example.test`n")
$installProcess = Start-Process -FilePath $InstallerPath -ArgumentList "/S" -PassThru
Wait-NlcProcess -Process $installProcess -Operation "silent install"
$launcher = Join-Path $env:LOCALAPPDATA "Programs\NLC Node\NLC Node.exe"
$hostPath = Join-Path $env:LOCALAPPDATA "Programs\NLC Node\NLC Node Host.exe"
$installMarker = Join-Path $env:LOCALAPPDATA "Programs\NLC Node\install.complete"
$diagnosticsShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\NLC Node\NLC Node Diagnostics.lnk"
Wait-NlcPath -Path $installMarker -Operation "silent install completion"
if (-not (Test-Path $launcher)) { throw "NLC Node launcher was not installed." }
if (-not (Test-Path $hostPath)) { throw "NLC Node host was not installed." }
if (-not (Test-Path $diagnosticsShortcut)) { throw "NLC Node Diagnostics shortcut was not installed." }
$keptOrigin = Join-Path $env:LOCALAPPDATA "NLC Node\origin.txt"
if (-not (Test-Path $keptOrigin) -or ((Get-Content -Raw $keptOrigin).Trim() -ne "https://verify.example.test")) { throw "The installer did not keep origin.txt from beside the setup program." }
Write-Host "origin.txt sidecar kept by the installer: OK"
if ($ExpectTools) {
  $installDir = Split-Path -Parent $launcher
  $ff = Join-Path $installDir "ffmpeg\win32-x64\ffmpeg.exe"
  $wh = Join-Path $installDir "whisper\win32-x64\whisper-cli.exe"
  foreach ($p in @($ff, (Join-Path $installDir "ffmpeg\win32-x64\ffprobe.exe"), $wh, (Join-Path $installDir "NOTICE-ffmpeg.txt"), (Join-Path $installDir "NOTICE-whisper.txt"))) { if (-not (Test-Path $p)) { throw "The installer did not install $p" } }
  $v = (& $ff -version | Select-Object -First 1); if ($LASTEXITCODE -ne 0) { throw "The installed ffmpeg does not run." }
  Write-Host "installed ffmpeg runs: $v"
  $w = (& $wh -h 2>&1 | Select-Object -First 1); Write-Host "installed whisper-cli answers: $w"
}

# I01: per-user install, no administrator rights, Start-menu entry, launch at login.
$startMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\NLC Node\NLC Node.lnk"
if (-not (Test-Path $startMenuShortcut)) { throw "NLC Node Start-menu entry was not installed." }
if (-not $launcher.StartsWith($env:LOCALAPPDATA, [StringComparison]::OrdinalIgnoreCase)) { throw "NLC Node was not installed under the current user's profile." }
$installerBytes = [System.Text.Encoding]::GetEncoding(28591).GetString([System.IO.File]::ReadAllBytes($InstallerPath))
if ($installerBytes -notmatch 'level="asInvoker"') { throw "NLC Node installer does not run as the current user (it would ask for administrator rights)." }
if (Test-Path "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NLC Node") { throw "NLC Node wrote a machine-wide uninstall entry." }
$runKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValue = (Get-ItemProperty -Path $runKeyPath -Name "NLC Node" -ErrorAction Stop)."NLC Node"
if ($runValue -notmatch [regex]::Escape($launcher)) { throw "NLC Node launch-at-login entry does not point at the installed launcher." }
if ($runValue -notmatch '--background') { throw "NLC Node launch-at-login entry must start quietly (--background)." }
if (-not (Test-Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NLC Node")) { throw "NLC Node Apps entry was not installed for the current user." }
if ($RequireTrust) {
  foreach ($component in @($launcher, $hostPath)) {
    $componentSignature = Get-AuthenticodeSignature -FilePath $component
    if ($componentSignature.Status -ne "Valid") { throw "NLC Node installed component signature is not valid: $component" }
    & signtool.exe verify /pa /all /v $component
    if ($LASTEXITCODE -ne 0) { throw "NLC Node installed component signature verification failed: $component" }
  }
}
$launcherProcess = Start-Process -FilePath $launcher -ArgumentList "--verify" -PassThru
Wait-NlcProcess -Process $launcherProcess -Operation "launcher verification"
$ready = Join-Path $env:LOCALAPPDATA "NLC Node\ready.json"
if (-not (Test-Path $ready)) { throw "NLC Node did not create its generic ready state." }
$firstHealth = & node (Join-Path $PSScriptRoot "..\..\..\scripts\nlc-node\loopback-health.cjs") --state-dir (Join-Path $env:LOCALAPPDATA "NLC Node") --timeout-ms 30000
if ($LASTEXITCODE -ne 0) { throw "NLC Node did not answer ready on its loopback address after install." }
Remove-Item -Force -Path $installMarker
$upgradeProcess = Start-Process -FilePath $InstallerPath -ArgumentList "/S" -PassThru
Wait-NlcProcess -Process $upgradeProcess -Operation "in-place update"
Wait-NlcPath -Path $installMarker -Operation "in-place update completion"
$stoppedReadyState = Get-Content -Raw -Path $ready | ConvertFrom-Json
if ($stoppedReadyState.state -ne "stopped") { throw "NLC Node in-place update did not stop the prior host safely." }
$updatedLauncherProcess = Start-Process -FilePath $launcher -ArgumentList "--verify" -PassThru
Wait-NlcProcess -Process $updatedLauncherProcess -Operation "updated launcher verification"
$updatedReadyState = Get-Content -Raw -Path $ready | ConvertFrom-Json
if ($updatedReadyState.state -ne "ready") { throw "NLC Node did not return to ready after the in-place update." }
Set-Clipboard -Value ""
$diagnosticsProcess = Start-Process -FilePath $launcher -ArgumentList @("--diagnose", "--verify-clipboard") -PassThru
Wait-NlcProcess -Process $diagnosticsProcess -Operation "diagnostics"
$diagnosticsReport = Join-Path $env:LOCALAPPDATA "NLC Node\NLC-Node-Diagnostics.json"
if (-not (Test-Path $diagnosticsReport)) { throw "NLC Node diagnostics did not create a proof report." }
$diagnosticsText = Get-Content -Raw -Path $diagnosticsReport
$clipboardText = Get-Clipboard -Raw
if ([string]::IsNullOrWhiteSpace($clipboardText)) { throw "NLC Node diagnostics did not copy the proof report to the clipboard." }
$normalizedDiagnosticsText = $diagnosticsText.Replace("`r`n", "`n").TrimEnd([char[]]@("`r", "`n"))
$normalizedClipboardText = $clipboardText.Replace("`r`n", "`n").TrimEnd([char[]]@("`r", "`n"))
if (-not [string]::Equals($normalizedDiagnosticsText, $normalizedClipboardText, [System.StringComparison]::Ordinal)) {
  throw "NLC Node diagnostics clipboard proof does not match the saved report."
}
$diagnostics = $diagnosticsText | ConvertFrom-Json
if ($diagnostics.schemaVersion -ne "nlc-node.diagnostics/v1") { throw "NLC Node diagnostic report schema is invalid." }
if ($diagnostics.result -ne "pass") { throw "NLC Node diagnostic report did not pass." }
if ($diagnostics.contentSha256 -notmatch "^[a-f0-9]{64}$") { throw "NLC Node diagnostic report content hash is invalid." }
if ($diagnostics.privacy.remoteAccessUsed -ne $false -or $diagnostics.privacy.credentialsIncluded -ne $false -or $diagnostics.privacy.localPathsIncluded -ne $false) {
  throw "NLC Node diagnostic report privacy claims are invalid."
}
$requiredCheckIds = @(
  "identity",
  "module-contract",
  "module-health",
  "loopback-binding",
  "unauthenticated-rejection",
  "authenticated-identity",
  "authenticated-modules",
  "installed-artifacts",
  "controlled-shutdown"
)
$checksById = @{}
foreach ($check in @($diagnostics.checks)) { $checksById[$check.id] = $check.status }
foreach ($checkId in $requiredCheckIds) {
  if ($checksById[$checkId] -ne "pass") { throw "NLC Node diagnostic check did not pass: $checkId" }
}
if (@($diagnostics.checks).Count -ne $requiredCheckIds.Count) { throw "NLC Node diagnostic report contains an unexpected check set." }
$artifactsByRole = @{}
foreach ($artifact in @($diagnostics.artifacts)) { $artifactsByRole[$artifact.role] = $artifact }
$expectedHostHash = (Get-FileHash -Algorithm SHA256 -Path $hostPath).Hash.ToLowerInvariant()
$expectedLauncherHash = (Get-FileHash -Algorithm SHA256 -Path $launcher).Hash.ToLowerInvariant()
if ($artifactsByRole["host"].sha256 -ne $expectedHostHash) { throw "NLC Node diagnostic host checksum does not match the installed host." }
if ($artifactsByRole["launcher"].sha256 -ne $expectedLauncherHash) { throw "NLC Node diagnostic launcher checksum does not match the installed launcher." }
if ($diagnosticsText -match '(?i)Bearer|authorization|"token"|[A-Za-z]:\\Users\\|/Users/|/home/|127\.0\.0\.1:\d+') {
  throw "NLC Node diagnostic report disclosed private connection data or a local path."
}
# Tray indicator, single instance (I04) and launch at login (C06).
$healthScript = Join-Path $PSScriptRoot "..\..\..\scripts\nlc-node\loopback-health.cjs"
$stateRoot = Join-Path $env:LOCALAPPDATA "NLC Node"
Add-Type -Namespace NlcNode -Name Win -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
'@
function Get-NlcTrayTitle {
  $handle = [NlcNode.Win]::FindWindow("NLCNodeTrayWindow", [NullString]::Value)
  if ($handle -eq [IntPtr]::Zero) { return $null }
  $builder = New-Object System.Text.StringBuilder 256
  [void][NlcNode.Win]::GetWindowText($handle, $builder, 256)
  return $builder.ToString()
}
function Wait-NlcTrayTitle {
  param([Parameter(Mandatory = $true)][string]$Expected, [int]$TimeoutMilliseconds = 15000)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    if ((Get-NlcTrayTitle) -eq $Expected) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "NLC Node tray did not show '$Expected' (it shows '$(Get-NlcTrayTitle)')."
}
function Assert-NlcHealthy {
  & node $healthScript --state-dir $stateRoot --timeout-ms 30000
  if ($LASTEXITCODE -ne 0) { throw "NLC Node did not answer ready on its loopback address." }
}
function Write-NlcIndicator([string]$State) {
  [System.IO.File]::WriteAllText((Join-Path $stateRoot "indicator.json"), "{`"state`":`"$State`"}`n")
}

# Start the way the Run key does: quiet, resident tray, host started on demand.
$trayProcess = Start-Process -FilePath $launcher -ArgumentList "--background" -PassThru
Wait-NlcPath -Path $ready -Operation "tray launch"
Wait-NlcTrayTitle -Expected "NLC Node - offline"
Assert-NlcHealthy
$hostPidBefore = (Get-Content -Raw -Path $ready | ConvertFrom-Json).pid
Write-NlcIndicator "connected"
Wait-NlcTrayTitle -Expected "NLC Node - connected" -TimeoutMilliseconds 8000
Write-NlcIndicator "paused"
Wait-NlcTrayTitle -Expected "NLC Node - paused" -TimeoutMilliseconds 8000

# I04: a second launch shows the existing window and starts nothing new.
Remove-Item -Force -ErrorAction SilentlyContinue -Path (Join-Path $stateRoot "last-open.txt")
$secondVerify = Start-Process -FilePath $launcher -ArgumentList "--verify" -PassThru
Wait-NlcProcess -Process $secondVerify -Operation "second launch (verify)"
$endpoint = Get-Content -Raw -Path (Join-Path $stateRoot "endpoint.json") | ConvertFrom-Json
$lastOpen = (Get-Content -Raw -Path (Join-Path $stateRoot "last-open.txt")).Trim()
if ($lastOpen -ne "http://127.0.0.1:$($endpoint.port)/") { throw "NLC Node second launch did not point at the existing window: $lastOpen" }
$secondQuiet = Start-Process -FilePath $launcher -ArgumentList "--background" -PassThru
Wait-NlcProcess -Process $secondQuiet -Operation "second launch (quiet)"
if ((Get-Content -Raw -Path $ready | ConvertFrom-Json).pid -ne $hostPidBefore) { throw "NLC Node second launch started a second host." }
if (@(Get-Process -Name "NLC Node" -ErrorAction SilentlyContinue).Count -ne 1) { throw "NLC Node has more than one tray after a second launch." }
if (@(Get-Process -Name "NLC Node Host" -ErrorAction SilentlyContinue).Count -ne 1) { throw "NLC Node has more than one host after a second launch." }

# HF-2026-11-09-14: the installer registered the restart supervisor, and its task really starts the Host again.
$supervisorXml = (& schtasks.exe /Query /TN "NLC Node" /XML | Out-String)
if ($LASTEXITCODE -ne 0 -or $supervisorXml -notmatch 'PT5M' -or $supervisorXml -notmatch '--supervised') { throw "NLC Node restart supervision was not registered by the installer." }
$killedHostPid = (Get-Content -Raw -Path $ready | ConvertFrom-Json).pid
Stop-Process -Id $killedHostPid -Force
$goneBy = [DateTime]::UtcNow.AddSeconds(20)
while ((Get-Process -Id $killedHostPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $goneBy) { Start-Sleep -Milliseconds 250 }
& schtasks.exe /Run /TN "NLC Node" | Out-Null
$restartBy = [DateTime]::UtcNow.AddSeconds(60)
$restartedHostPid = 0
while ([DateTime]::UtcNow -lt $restartBy) {
  try {
    $r = Get-Content -Raw -Path $ready | ConvertFrom-Json
    if ($r.state -eq "ready" -and $r.pid -ne $killedHostPid -and (Get-Process -Id ([int]$r.pid) -ErrorAction SilentlyContinue)) { $restartedHostPid = [int]$r.pid; break }
  } catch { }
  Start-Sleep -Milliseconds 500
}
if (-not $restartedHostPid) { throw "NLC Node was not started again by its restart supervisor after the Host was killed." }
Assert-NlcHealthy

# C06 (as far as a runner can): stop everything, then start exactly what the Run key starts at login.
Write-NlcIndicator "connected"
$stopHost = Start-Process -FilePath $hostPath -ArgumentList "--stop" -PassThru
Wait-NlcProcess -Process $stopHost -Operation "host stop"
Stop-Process -Name "NLC Node" -Force -ErrorAction SilentlyContinue
$gone = [DateTime]::UtcNow.AddSeconds(15)
while ((Get-NlcTrayTitle) -and [DateTime]::UtcNow -lt $gone) { Start-Sleep -Milliseconds 250 }
if (Get-NlcTrayTitle) { throw "NLC Node tray did not close." }
if ($runValue -notmatch '^"([^"]+)"\s*(.*)$') { throw "NLC Node launch-at-login entry is not in the expected form." }
$loginProcess = Start-Process -FilePath $Matches[1] -ArgumentList $Matches[2] -PassThru
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  $record = Get-Content -Raw -Path $ready | ConvertFrom-Json
  if ($record.state -eq "ready" -and $record.pid -ne $hostPidBefore) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
if ($record.state -ne "ready" -or $record.pid -eq $hostPidBefore) { throw "NLC Node did not start by itself from its launch-at-login entry." }
Wait-NlcTrayTitle -Expected "NLC Node - offline"
Assert-NlcHealthy
Remove-Item -Force -ErrorAction SilentlyContinue -Path (Join-Path $stateRoot "indicator.json")

# Files that belong to the customer must survive the uninstall below.
$sentinelId = [Guid]::NewGuid().ToString("N")
$trashRoot = Join-Path $env:USERPROFILE "NLC Trash"
$trashExisted = Test-Path $trashRoot
$trashSentinel = Join-Path $trashRoot "verify-sentinel-$sentinelId.txt"
$folderRoot = Join-Path $env:USERPROFILE "Documents\NLC-Node-Verify-$sentinelId"
$folderSentinel = Join-Path $folderRoot "clip.txt"
New-Item -ItemType Directory -Force -Path $trashRoot, $folderRoot | Out-Null
[System.IO.File]::WriteAllText($trashSentinel, "trash $sentinelId")
[System.IO.File]::WriteAllText($folderSentinel, "folder $sentinelId")

$uninstaller = Join-Path $env:LOCALAPPDATA "Programs\NLC Node\Uninstall NLC Node.exe"
if (-not (Test-Path $uninstaller)) { throw "NLC Node uninstaller was not installed." }
$uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList "/S" -PassThru
Wait-NlcProcess -Process $uninstallProcess -Operation "uninstall"
$cleanupDeadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  $runningHost = Get-Process -Name "NLC Node Host" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $hostPath }
  if (-not (Test-Path $launcher) -and -not (Test-Path $ready) -and -not (Test-Path $installMarker) -and -not (Test-Path $diagnosticsReport) -and -not (Test-Path $diagnosticsShortcut) -and -not $runningHost) { break }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $cleanupDeadline)
if (Test-Path $launcher) { throw "NLC Node launcher remains after uninstall." }
if (Test-Path $ready) { throw "NLC Node ready state remains after uninstall." }
if (Test-Path $installMarker) { throw "NLC Node install marker remains after uninstall." }
if (Test-Path $diagnosticsReport) { throw "NLC Node diagnostic report remains after uninstall." }
if (Test-Path $diagnosticsShortcut) { throw "NLC Node Diagnostics shortcut remains after uninstall." }
$runningHost = Get-Process -Name "NLC Node Host" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $hostPath }
if ($runningHost) { throw "NLC Node host remains after uninstall." }
if (Get-Process -Name "NLC Node" -ErrorAction SilentlyContinue) { throw "NLC Node tray remains after uninstall." }
if (Get-ItemProperty -Path $runKeyPath -Name "NLC Node" -ErrorAction SilentlyContinue) { throw "NLC Node launch-at-login entry remains after uninstall." }
if (Test-Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NLC Node") { throw "NLC Node Apps entry remains after uninstall." }
# I01: the customer's files and NLC Trash are untouched.
if ((Get-Content -Raw -Path $trashSentinel) -ne "trash $sentinelId") { throw "NLC Trash content changed or vanished during uninstall." }
if ((Get-Content -Raw -Path $folderSentinel) -ne "folder $sentinelId") { throw "A customer folder changed or vanished during uninstall." }
Remove-Item -Force -Path $trashSentinel, $folderSentinel
Remove-Item -Path $folderRoot
if (-not $trashExisted) { Remove-Item -Path $trashRoot }
Write-Output "NLC Node Windows install, launch, and uninstall verification passed."
