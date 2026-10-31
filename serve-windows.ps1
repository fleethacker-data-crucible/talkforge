# serve-windows.ps1 - compatibility shim. The server is now Start-TalkForge.ps1; this forwards to it so
# existing shortcuts, scripts and notes that still call serve-windows.ps1 keep working. PowerShell 5.1.
# The real script runs in its own powershell.exe so its self-reported path (GET /__fleethacker/id) and
# the launcher's stop-the-old-copy check see Start-TalkForge.ps1, not this file.
param(
    [int]$Port = 25000,
    [string]$Root = $PSScriptRoot,
    [switch]$NoBrowser
)
$target = Join-Path $PSScriptRoot 'Start-TalkForge.ps1'
$argList = @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $target, '-Root', $Root)
if ($PSBoundParameters.ContainsKey('Port')) { $argList += @('-Port', [string]$Port) }
if ($NoBrowser) { $argList += '-NoBrowser' }
& (Join-Path $PSHOME 'powershell.exe') @argList
exit $LASTEXITCODE
