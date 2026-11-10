# Checking the install script before you run it

Do not pipe a script into a shell. Download it to a file, compare it, read it, then run that copy. Your NLC's `/node` page shows these steps with your own address in them.

## Mac

```
curl -fsSL "https://your-NLC-address/downloads/nlc-node/install.sh" -o nlc-node-install.sh
want=$(curl -fsSL "https://your-NLC-address/downloads/nlc-node/install.sh.sha256" | awk '{print $1}'); got=$(shasum -a 256 nlc-node-install.sh | awk '{print $1}'); [ "$want" = "$got" ] && echo OK || echo MISMATCH
cat nlc-node-install.sh
sh nlc-node-install.sh
```

## Windows (PowerShell)

```
Invoke-WebRequest -UseBasicParsing "https://your-NLC-address/downloads/nlc-node/install.ps1" -OutFile nlc-node-install.ps1
$want = ((Invoke-RestMethod "https://your-NLC-address/downloads/nlc-node/install.ps1.sha256").ToString().Trim() -split '\s+')[0]; $got = (Get-FileHash .\nlc-node-install.ps1 -Algorithm SHA256).Hash.ToLower(); if ($got -eq $want) { 'OK' } else { 'MISMATCH' }
Get-Content .\nlc-node-install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\nlc-node-install.ps1
```

The execution-policy option applies to that one run only; no setting on the computer is changed.

## Compare with this repository

The script you downloaded is `installer/nlc-node/one-line/install.sh` (or `install.ps1`) with `__NLC_ORIGIN__` replaced by your NLC's address and `__NLC_LINK__` by your connection link (or nothing). Any other difference is a reason not to run it.
