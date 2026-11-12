# NLC Node installer for Windows. Paste into PowerShell:  irm __NLC_ORIGIN__/downloads/nlc-node/install.ps1 | iex
# It installs for your user only (no administrator rights), starts NLC Node and opens its window.
# Remove it again:  $env:NLC_NODE_UNINSTALL='1'; irm __NLC_ORIGIN__/downloads/nlc-node/install.ps1 | iex
# Your own folders and the NLC Trash folder are never touched.
param([switch]$Uninstall, [switch]$NoCentralAttach)

$Origin = '__NLC_ORIGIN__'
$LinkDefault = '__NLC_LINK__'

function Say([string]$Text) { Write-Host $Text }
function Fail([string]$Text) { throw "NLC Node could not be installed: $Text" }

function Install-NlcNode {
  param([bool]$Remove)
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  if (-not $env:LOCALAPPDATA) { Fail 'no user profile was found.' }

  $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\NLC Node'
  $StateDir = Join-Path $env:LOCALAPPDATA 'NLC Node'
  $Launcher = Join-Path $InstallDir 'NLC Node.exe'
  $HostExe = Join-Path $InstallDir 'NLC Node Host.exe'
  $RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

  function Stop-Node {
    if (Test-Path -LiteralPath $HostExe) {
      try { Start-Process -FilePath $HostExe -ArgumentList '--stop' -WindowStyle Hidden -Wait | Out-Null } catch { }
    }
    Get-Process -Name 'NLC Node', 'NLC Node Host' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Launcher -or $_.Path -eq $HostExe } | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch { } }
  }

  if ($Remove) {
    Say 'Removing NLC Node from this computer...'
    # Take the restart supervisor away first, or it would start NLC Node again right after it is stopped.
    if (Test-Path -LiteralPath $HostExe) { try { Start-Process -FilePath $HostExe -ArgumentList '--remove-supervision' -WindowStyle Hidden -Wait | Out-Null } catch { } }
    try { Start-Process -FilePath 'schtasks.exe' -ArgumentList @('/Delete', '/TN', 'NLC Node', '/F') -WindowStyle Hidden -Wait | Out-Null } catch { }
    Stop-Node
    Remove-ItemProperty -Path $RunKey -Name 'NLC Node' -ErrorAction SilentlyContinue
    $menuDirGone = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\NLC Node'
    if (Test-Path -LiteralPath $menuDirGone) { Remove-Item -LiteralPath $menuDirGone -Recurse -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $StateDir) { Remove-Item -LiteralPath $StateDir -Recurse -Force -ErrorAction SilentlyContinue }
    Say 'NLC Node is removed. Your folders and the NLC Trash folder were left exactly as they were.'
    return
  }

  Say 'Installing NLC Node for this computer (no administrator rights needed)...'
  $Work = Join-Path ([IO.Path]::GetTempPath()) ('nlc-node-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $Work | Out-Null
  try {
    Say '1/5  Downloading NLC Node...'
    $zip = Join-Path $Work 'payload.zip'
    try {
      $payloadUrl = "$Origin/downloads/nlc-node/payload/win-x64.zip"
      $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
      $got = $false
      if (Test-Path -LiteralPath $curl) {
        # A connection that crawls (under 200 KB/s for 8 seconds) is dropped and the download carries on from where it was on a fresh one.
        # Silent and with its messages dropped: a native program's messages must never become a PowerShell error here.
        try { & $curl -s -L --retry 200 --retry-all-errors --retry-delay 1 --speed-limit 204800 --speed-time 8 -C - -o $zip $payloadUrl 2>$null; $got = ($LASTEXITCODE -eq 0) } catch { $got = $false }
      }
      if (-not $got) { Invoke-WebRequest -UseBasicParsing -Uri $payloadUrl -OutFile $zip }
      $shaText = (New-Object Net.WebClient).DownloadString("$Origin/downloads/nlc-node/payload/win-x64.zip.sha256")
    } catch { Fail 'the download did not work. NLC may still be preparing it; please try again in a few minutes.' }
    $want = ($shaText.Trim() -split '\s+')[0].ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($zip)
    try { $got = ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }
    if (-not $want -or $want -ne $got) { Fail 'the download is damaged (its check did not match). Nothing was installed. Please try again.' }
    # A self-update names the build the server announced; anything else is refused.
    if ($env:NLC_NODE_EXPECT_SHA -and $env:NLC_NODE_EXPECT_SHA.ToLowerInvariant() -ne $want) { Fail 'the published build is not the one that was announced. Nothing was installed.' }

    Say '2/5  Putting it in place...'
    $unpacked = Join-Path $Work 'unpacked'
    Expand-Archive -LiteralPath $zip -DestinationPath $unpacked -Force
    if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'NLC Node Host.exe'))) { Fail 'the download did not hold NLC Node.' }
    Stop-Node
    Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Get-ChildItem -LiteralPath $unpacked -Force | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $InstallDir -Force }
    Get-ChildItem -LiteralPath $InstallDir -Recurse -File | ForEach-Object { try { Unblock-File -LiteralPath $_.FullName } catch { } }
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $StateDir 'origin.txt'))) { [IO.File]::WriteAllText((Join-Path $StateDir 'origin.txt'), "$Origin`n") }
    [IO.File]::WriteAllText((Join-Path $InstallDir 'install.complete'), "nlc-node.install/v1`r`n")
    # The build now in place (the payload's checksum): the Node reports it, and the server only announces a build that differs.
    [IO.File]::WriteAllText((Join-Path $StateDir 'installed-build.txt'), "$want`n")

    Say '3/5  Setting it to start when you log in...'
    New-ItemProperty -Path $RunKey -Name 'NLC Node' -Value ('"{0}" --background' -f $Launcher) -PropertyType String -Force | Out-Null
    Say '     Setting it to start again by itself if it ever stops...'
    try { Start-Process -FilePath $HostExe -ArgumentList '--install-supervision' -WindowStyle Hidden -Wait | Out-Null } catch { Say '     (It will still start when you log in.)' }

    try {
      $menuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\NLC Node'
      New-Item -ItemType Directory -Path $menuDir -Force | Out-Null
      $shell = New-Object -ComObject WScript.Shell
      $lnk = $shell.CreateShortcut((Join-Path $menuDir 'NLC Node.lnk'))
      $lnk.TargetPath = $Launcher
      $lnk.WorkingDirectory = $InstallDir
      $lnk.Save()
    } catch { }

    Say '4/5  Starting NLC Node...'
    Start-Process -FilePath $Launcher -ArgumentList '--background' -WindowStyle Hidden
    $ready = Wait-NodeReady $StateDir 25
    if (-not $ready) {
      Start-Process -FilePath $HostExe -ArgumentList @('--launch-id', "install-$PID") -WindowStyle Hidden
      $ready = Wait-NodeReady $StateDir 25
    }
    if (-not $ready) { Fail 'NLC Node did not start. Please run the same line again; if it still fails, tell your assistant.' }
    $endpoint = Get-Content -Raw -LiteralPath (Join-Path $StateDir 'endpoint.json') | ConvertFrom-Json
    $port = [int]$endpoint.port

    $link = if ($env:NLC_NODE_LINK) { $env:NLC_NODE_LINK } else { $LinkDefault }
    if ($link -notmatch '^[A-Za-z0-9:/._-]+$') { $link = '' }
    $paired = $false
    if ($link -and -not (Test-Path -LiteralPath (Join-Path $StateDir 'node-token.bin')) -and (Test-Path -LiteralPath (Join-Path $StateDir 'token'))) {
      Say '     Connecting this computer to your assistant...'
      $key = (Get-Content -Raw -LiteralPath (Join-Path $StateDir 'token')).Trim()
      try {
        $answer = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/v1/window/pair" -Headers @{ Authorization = "Bearer $key" } -ContentType 'application/json' -Body (@{ code = $link } | ConvertTo-Json -Compress)
        if ($answer.ok -eq $true) { $paired = $true; Say '     Connected.' }
      } catch { }
      if (-not $paired) { Say '     The link did not work (it may have expired). Enter a fresh code in the NLC Node window instead.' }
    }

    if (-not $NoCentralAttach) {
      $attach = Start-Process -FilePath $HostExe -ArgumentList '--attach-central' -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $Work 'central-attach.json') -RedirectStandardError (Join-Path $Work 'central-attach-error.txt')
      if ($attach.ExitCode -ne 0) { Say '     Central kept its existing bridge; Node file tools are running.' }
    }
    Say '5/5  Done.'
    if ($env:NLC_NODE_NO_OPEN -ne '1' -and -not $paired) {
      Start-Process "http://127.0.0.1:$port/"
      Say ''
      Say 'The NLC Node window is open. To finish, open NLC Central, go to Installations, and press Allow on your NLC card, where this computer shows wants to connect.'
      Say 'Only if you were given a code or link, type it in the window and click Connect instead.'
    }
    Say ''
    Say 'NLC Node is installed and running. It starts by itself when you log in.'
    Say 'If Windows asks whether NLC Node may run, choose More info, then Run anyway. To remove it later, run the same line again after setting  $env:NLC_NODE_UNINSTALL=''1'''
  } finally {
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# Waits until NLC Node says it is ready and its process is alive.
function Wait-NodeReady([string]$StateDir, [int]$Seconds) {
  $file = Join-Path $StateDir 'ready.json'
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-Path -LiteralPath $file) {
      try {
        $r = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
        if ($r.state -eq 'ready' -and (Get-Process -Id ([int]$r.pid) -ErrorAction SilentlyContinue)) { return $true }
      } catch { }
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

Install-NlcNode -Remove ([bool]($Uninstall -or $env:NLC_NODE_UNINSTALL -eq '1'))
