param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$OutDir
)
# Installs NLC Node the way a customer does, then proves the tray app opens its own window, in light and in dark.
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$sidecar = Join-Path (Split-Path -Parent $InstallerPath) "origin.txt"
[System.IO.File]::WriteAllText($sidecar, "https://verify.example.test`n")
$install = Start-Process -FilePath $InstallerPath -ArgumentList "/S" -PassThru
if (-not $install.WaitForExit(120000)) { Stop-Process -Id $install.Id -Force; throw "The silent install timed out." }
if ($install.ExitCode -ne 0) { throw "The silent install failed with exit code $($install.ExitCode)." }
$launcher = Join-Path $env:LOCALAPPDATA "Programs\NLC Node\NLC Node.exe"
$hostPath = Join-Path $env:LOCALAPPDATA "Programs\NLC Node\NLC Node Host.exe"
$stateRoot = Join-Path $env:LOCALAPPDATA "NLC Node"
if (-not (Test-Path $launcher)) { throw "NLC Node.exe was not installed." }

$personalize = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
function Set-Theme([string]$Theme) {
  $value = if ($Theme -eq "dark") { 0 } else { 1 }
  New-Item -Path $personalize -Force | Out-Null
  Set-ItemProperty -Path $personalize -Name AppsUseLightTheme -Value $value -Type DWord
  Set-ItemProperty -Path $personalize -Name SystemUsesLightTheme -Value $value -Type DWord
}
function Stop-Everything {
  if (Test-Path $hostPath) { & $hostPath --stop | Out-Null }
  Get-Process -Name "NLC Node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process -Name "NLC Node Host" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "--app=http://127\.0\.0\.1:" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}
function Save-Screen([string]$Path) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
}
function Wait-Until([scriptblock]$Test, [int]$Seconds, [string]$What) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do { $r = & $Test; if ($r) { return $r }; Start-Sleep -Milliseconds 500 } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for $What."
}

try {
  foreach ($theme in @("light", "dark")) {
    Stop-Everything
    Remove-Item -Force -ErrorAction SilentlyContinue -Path (Join-Path $stateRoot "ready.json"), (Join-Path $stateRoot "last-open.txt")
    Set-Theme $theme
    Write-Output "== $theme"

    # Start the way the Run key does: quiet, resident tray, host started on demand.
    $tray = Start-Process -FilePath $launcher -ArgumentList "--background" -PassThru
    [void](Wait-Until { Test-Path (Join-Path $stateRoot "ready.json") } 60 "the host to be ready")
    [System.IO.File]::WriteAllText((Join-Path $stateRoot "indicator.json"), "{`"state`":`"connected`"}`n")
    Start-Sleep -Seconds 3
    Save-Screen (Join-Path $OutDir "windows-$theme-1-tray.png")

    # The tray icon's click: a second launch asks the running tray app to show its window.
    Start-Process -FilePath $launcher | Out-Null
    $endpoint = Get-Content -Raw -Path (Join-Path $stateRoot "endpoint.json") | ConvertFrom-Json
    $windowProcess = Wait-Until {
      Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match "--app=http://127\.0\.0\.1:$($endpoint.port)/" } | Select-Object -First 1
    } 60 "the NLC Node window (an app window, not a browser tab)"
    Write-Output "window process: $($windowProcess.CommandLine)"
    $title = Wait-Until {
      $p = Get-Process -Name msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
      if ($p) { $p.MainWindowTitle }
    } 60 "the window to show a title"
    Write-Output "window title: $title"
    Start-Sleep -Seconds 4
    Save-Screen (Join-Path $OutDir "windows-$theme-2-window.png")
    if (@(Get-Process -Name "NLC Node" -ErrorAction SilentlyContinue).Count -ne 1) { throw "More than one NLC Node tray app is running ($theme)." }
    Write-Output "$theme proof ok"
  }
  Write-Output "NLC Node tray window opened in light and dark."
} finally {
  Stop-Everything
  Set-Theme "light"
}
