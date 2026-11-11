param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$OutDir
)
# Installs NLC Node the way a customer does, then proves the tray app opens its own native window (no Edge, no browser),
# showing the Node page, in light and in dark.
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NodeWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  // Visible top-level windows of the given class: "pid|title|left,top,right,bottom".
  public static List<string> Find(string className) {
    var found = new List<string>();
    EnumWindows((h, l) => {
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() == className && IsWindowVisible(h)) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        RECT r; GetWindowRect(h, out r);
        found.Add(pid + "|" + t + "|" + r.L + "," + r.T + "," + r.R + "," + r.B);
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

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
function Browser-Ids { @(Get-Process -Name msedge, chrome, firefox, iexplore -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }

try {
  foreach ($theme in @("light", "dark")) {
    Stop-Everything
    Remove-Item -Force -ErrorAction SilentlyContinue -Path (Join-Path $stateRoot "ready.json"), (Join-Path $stateRoot "last-open.txt"), (Join-Path $stateRoot "window-shown.txt"), (Join-Path $stateRoot "window-loaded.txt"), (Join-Path $stateRoot "window-error.txt")
    Set-Theme $theme
    Write-Output "== $theme"
    $browsersBefore = Browser-Ids

    # Start the way the Run key does: quiet, resident tray, host started on demand.
    $tray = Start-Process -FilePath $launcher -ArgumentList "--background" -PassThru
    [void](Wait-Until { Test-Path (Join-Path $stateRoot "ready.json") } 60 "the host to be ready")
    [System.IO.File]::WriteAllText((Join-Path $stateRoot "indicator.json"), "{`"state`":`"connected`"}`n")
    Start-Sleep -Seconds 3
    Save-Screen (Join-Path $OutDir "windows-$theme-1-tray.png")
    if ([NodeWin]::Find("NLCNodeWindow").Count -ne 0) { throw "The Node window was open before the tray icon was used ($theme)." }

    # The tray icon's click: a second launch asks the running tray app to show its window.
    Start-Process -FilePath $launcher | Out-Null
    $window = Wait-Until { [NodeWin]::Find("NLCNodeWindow") | Select-Object -First 1 } 60 "the NLC Node window"
    $parts = $window.Split("|")
    Write-Output "native window: owner process id $($parts[0]), title '$($parts[1])', rectangle $($parts[2])"
    if ([int]$parts[0] -ne $tray.Id) { throw "The window belongs to process $($parts[0]), not the NLC Node tray app $($tray.Id) ($theme)." }
    $loaded = Wait-Until {
      $p = Join-Path $stateRoot "window-loaded.txt"
      if (Test-Path $p) { (Get-Content -Raw $p).Trim() }
    } 90 "the Node page to load inside the window"
    Write-Output "page inside the window: $loaded"
    if ($loaded -notmatch "title=NLC Node") { throw "The window loaded the wrong page: $loaded" }
    $web = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -match "NLC Node" })
    Write-Output "web view processes tied to NLC Node: $($web.Count)"
    if ($web.Count -lt 1) { throw "No WebView2 process of the NLC Node was found ($theme)." }
    $browsersAfter = Browser-Ids
    $newBrowsers = @($browsersAfter | Where-Object { $browsersBefore -notcontains $_ })
    if ($newBrowsers.Count -gt 0) { throw "A browser process started while the window opened: $($newBrowsers -join ', ') ($theme)." }
    Write-Output "no Edge or other browser was started"
    Start-Sleep -Seconds 4
    Save-Screen (Join-Path $OutDir "windows-$theme-2-window.png")

    # A second click while it is open still gives one window and one tray app.
    Start-Process -FilePath $launcher | Out-Null
    Start-Sleep -Seconds 3
    if (@([NodeWin]::Find("NLCNodeWindow")).Count -ne 1) { throw "More than one NLC Node window is open ($theme)." }
    if (@(Get-Process -Name "NLC Node" -ErrorAction SilentlyContinue).Count -ne 1) { throw "More than one NLC Node tray app is running ($theme)." }
    Write-Output "$theme proof ok"
  }
  Write-Output "NLC Node tray window opened natively in light and dark."
} finally {
  Stop-Everything
  Set-Theme "light"
}
