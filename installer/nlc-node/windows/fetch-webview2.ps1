param(
  [Parameter(Mandatory = $true)][string]$OutDir
)
# Fetches the pinned Microsoft WebView2 SDK (header and static loader, the parts the tray app's own window is built with),
# checks the download against its pinned SHA-256, and lays out include\ and lib\ under OutDir. Nothing here ships to customers
# as a separate file: the loader is linked into "NLC Node.exe"; the WebView2 runtime itself comes with Windows.
$ErrorActionPreference = "Stop"
$Version = "1.0.2903.40"
$Sha256 = "ef128016dd1e51c59178c827ed5b8aa3322c57afa8675d930f8109505542ad74"
$Url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$Version/microsoft.web.webview2.$Version.nupkg"

$include = Join-Path $OutDir "include"
$lib = Join-Path $OutDir "lib"
if ((Test-Path (Join-Path $include "WebView2.h")) -and (Test-Path (Join-Path $lib "WebView2LoaderStatic.lib"))) { return }

New-Item -ItemType Directory -Force -Path $OutDir, $include, $lib | Out-Null
$package = Join-Path $OutDir "webview2.nupkg"
Invoke-WebRequest -Uri $Url -OutFile $package -UseBasicParsing
$actual = (Get-FileHash -Algorithm SHA256 -Path $package).Hash.ToLowerInvariant()
if ($actual -ne $Sha256) { throw "WebView2 SDK $Version failed its checksum (got $actual)." }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($package)
try {
  foreach ($entry in $archive.Entries) {
    $target = $null
    if ($entry.FullName -eq "build/native/include/WebView2.h") { $target = Join-Path $include "WebView2.h" }
    elseif ($entry.FullName -eq "build/native/x64/WebView2LoaderStatic.lib") { $target = Join-Path $lib "WebView2LoaderStatic.lib" }
    if ($target) { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true) }
  }
} finally { $archive.Dispose() }
Remove-Item -Force $package
if (-not (Test-Path (Join-Path $include "WebView2.h")) -or -not (Test-Path (Join-Path $lib "WebView2LoaderStatic.lib"))) { throw "The WebView2 SDK did not contain the expected files." }
