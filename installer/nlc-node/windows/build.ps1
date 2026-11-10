param(
  [string]$OutputRoot = "",
  [switch]$Sign,
  # Folder laid out by "build-payload.cjs windows-x64 --stage-tools" (ffmpeg, whisper and their notices); packed into the setup program.
  [string]$ToolsDir = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
if (-not $OutputRoot) { $OutputRoot = Join-Path $RepoRoot "dist/nlc-node/windows-x64" }
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$HostOutput = Join-Path $OutputRoot "host"
& node (Join-Path $RepoRoot "scripts/nlc-node/build-sea.cjs") --target windows-x64 --output-dir $HostOutput
if ($LASTEXITCODE -ne 0) { throw "NLC Node SEA host build failed." }

$LauncherPath = Join-Path $OutputRoot "NLC Node.exe"
& cl.exe /nologo /EHsc (Join-Path $PSScriptRoot "launcher.cpp") /link /SUBSYSTEM:WINDOWS user32.lib gdi32.lib shell32.lib "/OUT:$LauncherPath"
if ($LASTEXITCODE -ne 0) { throw "NLC Node launcher build failed." }

$HostPath = Join-Path $HostOutput "NLC Node Host.exe"
& editbin.exe /nologo /SUBSYSTEM:WINDOWS "$HostPath"
if ($LASTEXITCODE -ne 0) { throw "NLC Node host subsystem conversion failed." }

if ($Sign) {
  if (-not $env:NLC_NODE_WINDOWS_CERT_SUBJECT) { throw "NLC Node Windows signing requires NLC_NODE_WINDOWS_CERT_SUBJECT." }
  if (-not $env:NLC_NODE_WINDOWS_TIMESTAMP_URL) { throw "NLC Node Windows signing requires NLC_NODE_WINDOWS_TIMESTAMP_URL." }
  foreach ($file in @($HostPath, $LauncherPath)) {
    & signtool.exe sign /fd SHA256 /tr $env:NLC_NODE_WINDOWS_TIMESTAMP_URL /td SHA256 /n $env:NLC_NODE_WINDOWS_CERT_SUBJECT $file
    if ($LASTEXITCODE -ne 0) { throw "NLC Node component signing failed: $file" }
    & signtool.exe verify /pa /all /v $file
    if ($LASTEXITCODE -ne 0) { throw "NLC Node component signature verification failed: $file" }
  }
}

# Central is part of every setup payload, including builds without media tools.
if (-not $ToolsDir) { $ToolsDir = Join-Path $OutputRoot 'tools' }
& node (Join-Path $RepoRoot 'scripts/nlc-node/build-payload.cjs') windows-x64 --stage-tools $ToolsDir
if ($LASTEXITCODE -ne 0) { throw 'NLC Node Central dependency staging failed.' }

$InstallerName = (& node (Join-Path $RepoRoot "lib/nlc-node/artifact-names.cjs") setup).Trim()
$InstallerPath = Join-Path $OutputRoot $InstallerName
$Version = (Get-Content -Raw (Join-Path $PSScriptRoot "../release.json") | ConvertFrom-Json).version
$nsisArgs = @("/DOUTFILE=$InstallerPath", "/DLAUNCHER=$LauncherPath", "/DHOST=$HostPath", "/DVERSION=$Version")
# Pack the folder only when something was staged: the setup program refuses an empty one.
if ($ToolsDir -and (Test-Path $ToolsDir) -and (Get-ChildItem -Path $ToolsDir -Recurse -File -Force | Select-Object -First 1)) { $nsisArgs += "/DTOOLS_DIR=$((Resolve-Path $ToolsDir).Path)" }
& makensis.exe @nsisArgs (Join-Path $PSScriptRoot "nlc-node.nsi")
if ($LASTEXITCODE -ne 0) { throw "NLC Node installer build failed." }

if ($Sign) {
  & signtool.exe sign /fd SHA256 /tr $env:NLC_NODE_WINDOWS_TIMESTAMP_URL /td SHA256 /n $env:NLC_NODE_WINDOWS_CERT_SUBJECT $InstallerPath
  if ($LASTEXITCODE -ne 0) { throw "NLC Node Windows signing failed." }
  & signtool.exe verify /pa /all /v $InstallerPath
  if ($LASTEXITCODE -ne 0) { throw "NLC Node Windows signature verification failed." }
}

Write-Output $InstallerPath
