param([Parameter(Mandatory = $true)][string]$InstallerPath)
$ErrorActionPreference = "Stop"

# HF-2026-11-14-07: after a restart NLC Node must start at sign-in even when records from before the restart are left behind: a ready record and an instance lock holding the id of another live program, and an old Quit marker.
# Fired the two ways Windows starts it at sign-in: the launch-at-login entry and the scheduled task.
function Wait-Until([scriptblock]$Test, [int]$Seconds, [string]$What) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do { if (& $Test) { return } Start-Sleep -Milliseconds 300 } while ([DateTime]::UtcNow -lt $deadline)
  throw "NLC Node did not $What."
}
$install = Start-Process -FilePath $InstallerPath -ArgumentList "/S" -PassThru
if (-not $install.WaitForExit(120000)) { Stop-Process -Id $install.Id -Force; throw "NLC Node silent install timed out." }
$dir = Join-Path $env:LOCALAPPDATA "Programs\NLC Node"
$hostExe = Join-Path $dir "NLC Node Host.exe"
$state = Join-Path $env:LOCALAPPDATA "NLC Node"
Wait-Until { Test-Path (Join-Path $dir "install.complete") } 30 "finish installing"
$runValue = (Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "NLC Node")."NLC Node"

function Set-StaleLeftovers([int]$OtherPid) {
  Get-Process -Name "NLC Node", "NLC Node Host" -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 1
  foreach ($name in "ready.json", "endpoint.json", "instance.lock", "user-stopped.json", "stop.request") { Remove-Item -Force -ErrorAction SilentlyContinue -Path (Join-Path $state $name) }
  $old = "2020-01-01T00:00:00.000Z"
  $ready = Join-Path $state "ready.json"
  [IO.File]::WriteAllText($ready, ('{{"state":"ready","version":"0.0.0","error":"","pid":{0},"launchId":"left-from-before-restart","updatedAt":"{1}"}}' -f $OtherPid, $old))
  (Get-Item $ready).LastWriteTime = [DateTime]"2020-01-01"
  [IO.File]::WriteAllText((Join-Path $state "instance.lock"), ('{{"pid":{0},"createdAt":"{1}"}}' -f $OtherPid, $old))
  [IO.File]::WriteAllText((Join-Path $state "user-stopped.json"), ('{{"at":"{0}"}}' -f $old))
}
function Wait-HostUp([int]$OtherPid, [string]$How) {
  $ready = Join-Path $state "ready.json"
  Wait-Until {
    if (-not (Test-Path $ready)) { return $false }
    try { $r = Get-Content -Raw $ready | ConvertFrom-Json } catch { return $false }
    $p = Get-Process -Id ([int]$r.pid) -ErrorAction SilentlyContinue
    return ($r.state -eq "ready" -and $r.pid -ne $OtherPid -and $p -and $p.ProcessName -eq "NLC Node Host")
  } 60 "start by itself from $How with records left from before the restart"
  Write-Host "NLC Node came up from $How (host pid $((Get-Content -Raw $ready | ConvertFrom-Json).pid))."
}
$other = Start-Process -FilePath "ping.exe" -ArgumentList @("-t", "127.0.0.1") -WindowStyle Hidden -PassThru
try {
  Set-StaleLeftovers $other.Id
  Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/s", "/c", ('"{0}"' -f $runValue)) -WindowStyle Hidden
  Wait-HostUp $other.Id "the launch-at-login entry"
  Set-StaleLeftovers $other.Id
  & schtasks.exe /Run /TN "NLC Node"
  if ($LASTEXITCODE -ne 0) { throw "schtasks /Run for the NLC Node task failed with exit code $LASTEXITCODE." }
  Wait-HostUp $other.Id "the scheduled task"
  Write-Output "NLC Node starts at sign-in from stale restart records: passed."
} finally {
  Stop-Process -Id $other.Id -Force -ErrorAction SilentlyContinue
  Get-Process -Name "NLC Node", "NLC Node Host" -ErrorAction SilentlyContinue | Stop-Process -Force
  $uninstaller = Join-Path $dir "Uninstall NLC Node.exe"
  if (Test-Path $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait }
}
