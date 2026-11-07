# populate-assets.ps1 - downloads the files listed in assets-manifest.json and verifies SHA-256.
# Downloads from the GitHub Release only (offline policy). The upstream url in the manifest (CDN or
# Hugging Face) is used ONLY when you pass -AllowUpstream or set TALKFORGE_ALLOW_UPSTREAM=1.
# If the GitHub CLI is installed and signed in (gh auth status), release assets are fetched with
# `gh release download` first, so a private repo works. -UseGh auto (default) | on | off, or env TALKFORGE_GH.
# on = require gh and never fall back; off = never use gh. A hash mismatch from gh is final (fail closed).
# Every entry must carry a sha256; a file that does not match is never kept and the script
# exits with code 1 and lists what failed.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\populate-assets.ps1
#   powershell -ExecutionPolicy Bypass -File .\populate-assets.ps1 -AssetRoot .\assets
#   powershell -ExecutionPolicy Bypass -File .\populate-assets.ps1 -AllowUpstream   (opt in to CDN/Hugging Face; still SHA-256 verified)
#   powershell -ExecutionPolicy Bypass -File .\populate-assets.ps1 -Only 'models/en_US-libritts_r-medium*','wasm/*','vendor/onnx/*.jsep.wasm'
#
# -Only takes wildcard patterns matched against the manifest "dest" (default: everything).
# Hash rule: .json files are hashed with CR bytes removed (checkouts may be CRLF).
# PowerShell 5.1 compatible, no admin rights needed.

param(
    [string]$AssetRoot = (Join-Path $PSScriptRoot 'assets'),
    [string]$Manifest = (Join-Path $PSScriptRoot 'assets-manifest.json'),
    [string[]]$Only,
    [switch]$AllowUpstream,
    [ValidateSet('auto', 'on', 'off')][string]$UseGh = 'auto'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

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
                return "https://github.com/$path/releases/download/v1.3.0"
            }
        }
    } catch {}
    return 'https://github.com/fleethacker-data-crucible/talkforge/releases/download/v1.3.0'
}

function ConvertTo-SeriesBase([string]$url) {
    return $url -replace '/releases/download/v(\d+)\.(\d+)\.\d+', '/releases/download/v$1.$2.0'
}

# Defined as text so the same function can be loaded inside the download runspaces.
$hashFunctionText = @'
function Get-AssetHash([string]$Path, [string]$Dest) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        if ($Dest -like '*.json') {
            $bytes = [IO.File]::ReadAllBytes($Path)
            $keep = New-Object 'System.Collections.Generic.List[byte]' $bytes.Length
            foreach ($b in $bytes) { if ($b -ne 13) { $keep.Add($b) } }
            $h = $sha.ComputeHash($keep.ToArray())
        } else {
            $fs = [IO.File]::OpenRead($Path)
            try { $h = $sha.ComputeHash($fs) } finally { $fs.Dispose() }
        }
    } finally { $sha.Dispose() }
    return ([BitConverter]::ToString($h) -replace '-', '').ToLowerInvariant()
}
'@
. ([scriptblock]::Create($hashFunctionText))

# powershell -File passes -Only 'a','b' as one string, so also split on commas.
if ($Only) { $Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ }) }

if ($env:TALKFORGE_GH) {
    if (@('auto', 'on', 'off') -notcontains $env:TALKFORGE_GH) { throw "TALKFORGE_GH must be auto, on or off (got $env:TALKFORGE_GH)" }
    $UseGh = $env:TALKFORGE_GH
}

if ($env:TALKFORGE_ALLOW_UPSTREAM -eq '1') { $AllowUpstream = $true }

$RELEASE_BASE = ConvertTo-SeriesBase (Get-ReleaseBase)
Write-Host "Using release base: $RELEASE_BASE"
Write-Host "Reading manifest: $Manifest"

$data = Get-Content $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$entries = @($data.assets)
Write-Host "Manifest entries: $($entries.Count)"

$failures = New-Object System.Collections.ArrayList

# Authenticated release download through the GitHub CLI. TALKFORGE_GH_BIN is a test hook (a fake gh).
$ghCmd = @(([string]$(if ($env:TALKFORGE_GH_BIN) { $env:TALKFORGE_GH_BIN } else { 'gh' })) -split ' ' | Where-Object { $_ })
$ghRepo = $null; $ghTag = $null
if ($RELEASE_BASE -match '^https://github\.com/([^/]+/[^/]+)/releases/download/([^/]+)$') { $ghRepo = $Matches[1]; $ghTag = $Matches[2] }
if ($env:TALKFORGE_GH_REPO) { $ghRepo = $env:TALKFORGE_GH_REPO }
if ($env:TALKFORGE_GH_TAG) { $ghTag = $env:TALKFORGE_GH_TAG }
$ghUsable = $false
if ($UseGh -ne 'off' -and $ghRepo -and $ghTag -and (Get-Command $ghCmd[0] -ErrorAction SilentlyContinue)) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $null = & $ghCmd[0] @($ghCmd | Select-Object -Skip 1) auth status 2>&1; $ghUsable = ($LASTEXITCODE -eq 0) } catch { $ghUsable = $false }
    $ErrorActionPreference = $prev
}
if ($ghUsable) { Write-Host "Using gh for release downloads: $ghRepo $ghTag" }
elseif ($UseGh -eq 'on') {
    [void]$failures.Add('gh is required (TALKFORGE_GH=on / -UseGh on) but is not installed, not signed in (run: gh auth login), or the release repo/tag is unknown')
}
if ($Only -and -not ($entries | Where-Object { $d = [string]$_.dest; $Only | Where-Object { $d -like $_ } })) {
    [void]$failures.Add("-Only matched no manifest entry: $($Only -join ', ')")
}
$tasks = @()
foreach ($e in $entries) {
    $destPath = [string]$e.dest
    if (-not $destPath -or -not $e.url) { continue }
    if ($Only) {
        $hit = $false
        foreach ($pat in $Only) { if ($destPath -like $pat) { $hit = $true } }
        if (-not $hit) { continue }
    }
    $expected = ([string]$e.sha256).ToLowerInvariant()
    $dest = Join-Path $AssetRoot $destPath
    $name = Split-Path $destPath -Leaf
    if ($expected -notmatch '^[0-9a-f]{64}$') {
        [void]$failures.Add("$name : manifest entry has no valid sha256 (refusing to use unverified files)")
        continue
    }
    $dir = Split-Path $dest -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if (Test-Path $dest) {
        $actual = Get-AssetHash $dest $destPath
        if ($actual -eq $expected) {
            Write-Host "  [ok]   $name already present, SHA-256 verified"
        } else {
            [void]$failures.Add("$name : file exists but SHA-256 does not match (expected $expected, got $actual). Delete $dest and run again.")
        }
        continue
    }
    $releaseUrl = if ($e.preferRelease) { "$RELEASE_BASE/$name" } else { $null }
    $tasks += [pscustomobject]@{
        Name        = $name
        Dest        = $dest
        Expected    = $expected
        GhRepo      = if ($ghUsable) { $ghRepo } else { $null }
        GhTag       = $ghTag
        GhCmd       = $ghCmd
        GhRequired  = ($UseGh -eq 'on')
        ReleaseUrl  = $releaseUrl
        FallbackUrl = if ($AllowUpstream) { [string]$e.url } else { $null }
        UpstreamUrl = [string]$e.url
    }
}

if ($UseGh -eq 'on' -and -not $ghUsable) { $tasks = @() }
if ($tasks.Count -gt 0) {
    Write-Host "Downloading $($tasks.Count) file(s) with up to 8 parallel connections..."

    # Download worker (runs inside a runspace). Downloads to .part, verifies, then moves into place.
    $worker = {
        param($task, $hashFnText)
        $ErrorActionPreference = 'Stop'
        $ProgressPreference = 'SilentlyContinue'
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
        . ([scriptblock]::Create($hashFnText))
        $part = $task.Dest + '.part'
        $problems = @()
        if ($task.GhRepo) {
            $tmp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Force -Path $tmp | Out-Null
            $ghOk = $false
            $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            try {
                $null = & $task.GhCmd[0] @($task.GhCmd | Select-Object -Skip 1) release download $task.GhTag --repo $task.GhRepo --pattern $task.Name --dir $tmp --clobber 2>&1
                $ghOk = (($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath (Join-Path $tmp $task.Name)))
            } catch { $ghOk = $false }
            $ErrorActionPreference = $prev
            if ($ghOk) {
                Move-Item -LiteralPath (Join-Path $tmp $task.Name) -Destination $part -Force
                Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
                $actual = Get-AssetHash $part $task.Dest
                if ($actual -eq $task.Expected) {
                    Move-Item -LiteralPath $part -Destination $task.Dest -Force
                    return [pscustomobject]@{ Name = $task.Name; Ok = $true; Message = "verified  $($task.Name)  <-  gh release $($task.GhTag)" }
                }
                Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
                return [pscustomobject]@{ Name = $task.Name; Ok = $false; Message = "SHA-256 MISMATCH from gh release $($task.GhTag) (expected $($task.Expected), got $actual); not trying other sources. The release and assets-manifest.json disagree." }
            }
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
            $problems += "gh release download failed for $($task.Name)"
            if ($task.GhRequired) { return [pscustomobject]@{ Name = $task.Name; Ok = $false; Message = ($problems -join '; ') + ' (gh required: no fallback)' } }
        }
        $urls = @()
        if ($task.ReleaseUrl) { $urls += $task.ReleaseUrl }
        if ($task.FallbackUrl) { $urls += $task.FallbackUrl }
        foreach ($url in $urls) {
            $got = $false
            for ($i = 1; $i -le 3 -and -not $got; $i++) {
                try {
                    Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing -TimeoutSec 300
                    $got = $true
                } catch {
                    if ($i -lt 3) { Start-Sleep -Seconds 2 }
                    else { $problems += "download failed from $url ($($_.Exception.Message))" }
                }
            }
            if (-not $got) { Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue; continue }
            $actual = Get-AssetHash $part $task.Dest
            if ($actual -eq $task.Expected) {
                Move-Item -LiteralPath $part -Destination $task.Dest -Force
                return [pscustomobject]@{ Name = $task.Name; Ok = $true; Message = "verified  $($task.Name)  <-  $url" }
            }
            $problems += "SHA-256 MISMATCH from $url (expected $($task.Expected), got $actual)"
            Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
        }
        if (-not $task.FallbackUrl) { $problems += "upstream download is off (offline policy); re-run with -AllowUpstream to use $($task.UpstreamUrl)" }
        return [pscustomobject]@{ Name = $task.Name; Ok = $false; Message = ($problems -join '; ') }
    }

    $pool = [runspacefactory]::CreateRunspacePool(1, 8)
    $pool.Open()
    $jobs = @()
    foreach ($task in $tasks) {
        $ps = [powershell]::Create()
        $ps.RunspacePool = $pool
        [void]$ps.AddScript($worker).AddArgument($task).AddArgument($hashFunctionText)
        $jobs += [pscustomobject]@{ Pipe = $ps; Handle = $ps.BeginInvoke(); Name = $task.Name }
    }

    while ($jobs | Where-Object { -not $_.Handle.IsCompleted }) {
        Start-Sleep -Milliseconds 500
    }
    Write-Host ""
    Write-Host "Sources:"
    foreach ($job in $jobs) {
        $result = $job.Pipe.EndInvoke($job.Handle) | Select-Object -Last 1
        if ($result -and $result.Ok) {
            Write-Host "  $($result.Message)"
        } else {
            $msg = if ($result) { $result.Message } else { 'worker returned nothing' }
            Write-Host "  FAIL     $($job.Name)  ($msg)"
            [void]$failures.Add("$($job.Name) : $msg")
        }
        $job.Pipe.Dispose()
    }
    $pool.Close()
    $pool.Dispose()
}

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "FAILED: $($failures.Count) asset(s) could not be verified:" -ForegroundColor Red
    foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
    Write-Host "No unverified file was kept. Fix the problem above and run this script again."
    exit 1
}
Write-Host "Done. All assets verified (SHA-256)."
Write-Host "Assets under: $AssetRoot"
