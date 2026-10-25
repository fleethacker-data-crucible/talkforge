# populate-assets.ps1 — reads assets-manifest.json
# Prefers the GitHub Release for entries with preferRelease=true.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\populate-assets.ps1
#   powershell -ExecutionPolicy Bypass -File .\populate-assets.ps1 -AssetRoot .\assets

param(
    [string]$AssetRoot = (Join-Path $PSScriptRoot 'assets'),
    [string]$Manifest = (Join-Path $PSScriptRoot 'assets-manifest.json')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Manifest)) {
    throw "Manifest not found: $Manifest"
}

function Get-ReleaseBase {
    if ($env:TALKFORGE_RELEASE_BASE) { return $env:TALKFORGE_RELEASE_BASE }
    $stamp = Join-Path $AssetRoot 'release-base.txt'
    if (Test-Path $stamp) {
        $line = (Get-Content $stamp -TotalCount 1).Trim()
        if ($line) { return $line }
    }
    try {
        $remote = & git remote get-url origin 2>$null
        if ($remote) {
            $path = $remote -replace '^(https://github.com/|git@github.com:)', '' -replace '\.git$', ''
            if ($path -match '^[^/]+/[^/]+$') {
                return "https://github.com/$path/releases/download/v1.0.0"
            }
        }
    } catch {}
    return 'https://github.com/seakintruth/talkforge/releases/download/v1.0.0'
}

function ConvertTo-SeriesBase([string]$url) {
    return $url -replace '/releases/download/v(\d+)\.(\d+)\.\d+', '/releases/download/v$1.$2.0'
}

$RELEASE_BASE = ConvertTo-SeriesBase (Get-ReleaseBase)
Write-Host "Using release base: $RELEASE_BASE"
Write-Host "Reading manifest: $Manifest"

function Get-Asset([string]$Url, [string]$Dest) {
    $name = Split-Path $Dest -Leaf
    if (Test-Path $Dest) {
        Write-Host "  [skip] $name already exists"
        return $true
    }
    Write-Host "  [get]  $name"
    $retries = 3
    for ($i = 1; $i -le $retries; $i++) {
        try {
            Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -TimeoutSec 300
            return $true
        } catch {
            if ($i -eq $retries) { return $false }
            Write-Host "  [retry $i] $name"
            Start-Sleep -Seconds 2
        }
    }
    return $false
}

function Get-AssetPreferRelease([string]$Filename, [string]$FallbackUrl, [string]$Dest) {
    if (Test-Path $Dest) {
        Write-Host "  [skip] $(Split-Path $Dest -Leaf) already exists"
        return
    }
    $releaseUrl = "$RELEASE_BASE/$Filename"
    Write-Host "  [try]  $(Split-Path $Dest -Leaf) from release"
    if (Get-Asset $releaseUrl $Dest) { return }
    Write-Host "  [fallback] $(Split-Path $Dest -Leaf)"
    if (-not (Get-Asset $FallbackUrl $Dest)) {
        throw "Failed to download $(Split-Path $Dest -Leaf) from release or fallback"
    }
}

# PowerShell 5.1 JSON parsers are unreliable here; extract fields with regex.
$raw = Get-Content $Manifest -Raw -Encoding UTF8
$matches = [regex]::Matches($raw, '"dest"\s*:\s*"([^"]+)"\s*,\s*"url"\s*:\s*"([^"]+)"\s*,\s*"preferRelease"\s*:\s*(true|false)')
Write-Host "Manifest entries: $($matches.Count)"

# Build the download list first
$tasks = @()
foreach ($m in $matches) {
    $destPath = $m.Groups[1].Value
    $url = $m.Groups[2].Value
    $preferRelease = ($m.Groups[3].Value -eq 'true')
    if (-not $destPath -or -not $url) { continue }
    $dest = Join-Path $AssetRoot $destPath
    $dir = Split-Path $dest -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if (Test-Path $dest) {
        Write-Host "  [skip] $(Split-Path $dest -Leaf) already exists"
        continue
    }
    $filename = Split-Path $destPath -Leaf
    $releaseUrl = if ($preferRelease) { "$RELEASE_BASE/$filename" } else { $null }
    $tasks += [pscustomobject]@{
        Name       = $filename
        Dest       = $dest
        ReleaseUrl = $releaseUrl
        FallbackUrl = $url
    }
}

Write-Host "Downloading $($tasks.Count) file(s) with up to 8 parallel connections..."

# Download worker (runs inside a runspace)
$worker = {
    param($task)
    function Try-Download($url, $dest) {
        $retries = 3
        for ($i = 1; $i -le $retries; $i++) {
            try {
                Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 300
                return $true
            } catch {
                if ($i -lt $retries) { Start-Sleep -Seconds 2 }
            }
        }
        return $false
    }
    $name = $task.Name
    if ($task.ReleaseUrl) {
        if (Try-Download $task.ReleaseUrl $task.Dest) {
            return "release  $name  <-  $($task.ReleaseUrl)"
        }
    }
    if (Try-Download $task.FallbackUrl $task.Dest) {
        return "fallback $name  <-  $($task.FallbackUrl)"
    }
    return "FAIL     $name  (tried release and $($task.FallbackUrl))"
}

$pool = [runspacefactory]::CreateRunspacePool(1, 8)
$pool.Open()
$jobs = @()
foreach ($task in $tasks) {
    $ps = [powershell]::Create()
    $ps.RunspacePool = $pool
    [void]$ps.AddScript($worker).AddArgument($task)
    $jobs += [pscustomobject]@{ Pipe = $ps; Handle = $ps.BeginInvoke(); Name = $task.Name }
}

# Wait and report
while ($jobs | Where-Object { -not $_.Handle.IsCompleted }) {
    Start-Sleep -Milliseconds 500
}
Write-Host ""
Write-Host "Sources:"
foreach ($job in $jobs) {
    $result = $job.Pipe.EndInvoke($job.Handle)
    Write-Host "  $result"
    $job.Pipe.Dispose()
}
$pool.Close()
$pool.Dispose()

Write-Host ""
Write-Host "Done."
Write-Host "Assets under: $AssetRoot"
