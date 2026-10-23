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

$manifest = Get-Content $Manifest -Raw | ConvertFrom-Json
foreach ($asset in $manifest.assets) {
    $dest = Join-Path $AssetRoot $asset.dest
    $dir = Split-Path $dest -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $filename = Split-Path $asset.dest -Leaf
    if ($asset.preferRelease) {
        Get-AssetPreferRelease $filename $asset.url $dest
    } else {
        Get-Asset $asset.url $dest | Out-Null
    }
}

Write-Host ""
Write-Host "Done."
Write-Host "Assets under: $AssetRoot"
