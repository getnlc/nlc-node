# A real window, shown for a few seconds, so the window watcher can be shown to see windows at all.
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'NLC-CONTROL'
$f.Show()
$t = [Diagnostics.Stopwatch]::StartNew()
while ($t.Elapsed.TotalSeconds -lt 6) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20 }
$f.Close()
