# serve-windows.ps1 — static file server for the TalkForge-tts page (PowerShell 5.1, no admin, localhost only)
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\serve-windows.ps1
#   powershell -ExecutionPolicy Bypass -File .\serve-windows.ps1 -Port 25005   (exact port; default is the 25000-25009 block)
#   powershell -ExecutionPolicy Bypass -File .\serve-windows.ps1 -NoBrowser

param(
    [int]$Port = 25000,
    [string]$Root = $PSScriptRoot,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path $Root).Path
$logFile = Join-Path $Root 'serve-windows.log'

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Write-Host $line
    try { [IO.File]::AppendAllText($logFile, $line + "`r`n") } catch {}
}

# True only when $Full is the root itself or lives inside it. Compares against the root WITH a
# trailing separator, so a sibling such as C:\TalkForge-evil is not accepted for root C:\TalkForge.
function Test-PathUnderRoot([string]$Root, [string]$Full) {
    $trimRoot = $Root.TrimEnd('\', '/')
    if ($Full.TrimEnd('\', '/').Equals($trimRoot, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $Full.StartsWith($trimRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

# Request paths that must never be served even though they sit under the root: git internals, env files,
# log files, and anything that is not a plain relative path (NUL, ':' for NTFS alternate streams or drive
# letters). $Rel is the already-decoded path without the leading slash.
function Test-RequestPathAllowed([string]$Rel) {
    if ([string]::IsNullOrEmpty($Rel)) { return $true }
    if ($Rel.IndexOf([char]0) -ge 0 -or $Rel.Contains(':')) { return $false }
    $segments = $Rel -split '[\\/]'
    foreach ($seg in $segments) {
        if ($seg -ieq '.git' -or $seg -ilike '.env*') { return $false }
    }
    if ($segments[$segments.Count - 1] -ilike '*.log') { return $false }
    return $true
}

# Immutable binaries (models, WASM) may be cached for a few minutes, so the page is not re-fetching ~18 MB per
# sentence; everything else (the page, scripts, configs) stays no-store so edits show immediately.
function Get-CacheControlFor([string]$Path) {
    $ext = [IO.Path]::GetExtension($Path).ToLowerInvariant()
    if ($ext -in '.onnx', '.wasm', '.data') { return 'private, max-age=300' }
    return 'no-store'
}

function Show-Fatal([string]$text) {
    Write-Log "[FATAL] $text"
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show("TalkForge-tts server could not start.`n`n$text`n`nLog: $logFile", 'TalkForge-tts Server',
            [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    } catch {}
    exit 1
}

trap { Show-Fatal "$($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"; exit 1 }

# MIME types needed by the TTS page
$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript'
    '.mjs'  = 'text/javascript'
    '.css'  = 'text/css'
    '.json' = 'application/json'
    '.wasm' = 'application/wasm'
    '.onnx' = 'application/octet-stream'
    '.data' = 'application/octet-stream'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.woff2' = 'font/woff2'
    '.jpg'  = 'image/jpeg'
    '.ico'  = 'image/x-icon'
    '.md'   = 'text/plain; charset=utf-8'
    '.txt'  = 'text/plain; charset=utf-8'
}

# Port block 25000-25009, policy reuse (edge-ops PORTS.md). An explicit -Port is used exactly.
Import-Module (Join-Path $PSScriptRoot 'FleetPort.psm1') -Force
$version = '0.0.0'
$page = Join-Path $PSScriptRoot 'TalkForge-tts.html'
if ((Test-Path -LiteralPath $page) -and ([IO.File]::ReadAllText($page) -match "PAGE_VERSION\s*=\s*'([0-9.]+)'")) { $version = $Matches[1] }
$selfPath = [IO.Path]::GetFullPath($PSCommandPath)
$fleetArgs = @{ Tool = 'talkforge'; Version = $version; RegistryPath = (Join-Path $PSScriptRoot 'FleetPorts.psd1'); NoListener = $true }
if ($PSBoundParameters.ContainsKey('Port')) { $fleetArgs.Start = $Port; $fleetArgs.Size = 1 }
try { $slot = Resolve-FleetPort @fleetArgs } catch { Show-Fatal $_.Exception.Message }
if ($slot.Action -eq 'Reuse') {
    $page = "http://127.0.0.1:$($slot.Port)/TalkForge-tts.html"
    if ($slot.Note) { Write-Log $slot.Note }
    Write-Log "TalkForge $($slot.Existing.Version) is already running: $page"
    if (-not $NoBrowser) { try { Start-Process $page } catch {} }
    exit 0
}
$chosen = $slot.Port
if ($chosen -ne $Port) { Write-Log "Port $Port in use. Using $chosen instead." }

$prefix = "http://127.0.0.1:$chosen/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)
# Second prefix so /__fleethacker/id answers the FleetPort probe (Host: localhost:<port>).
$listener.Prefixes.Add("http://localhost:$chosen/")

try { $listener.Start() }
catch { Show-Fatal "Failed to start listener on $prefix : $_" }

Write-Log "Serving $Root at $prefix"
Write-Log "Open: ${prefix}TalkForge-tts.html"
Write-Log "Press Ctrl+C to stop."

if (-not $NoBrowser) {
    try { Start-Process "${prefix}TalkForge-tts.html" } catch {}
}

function Send-File($res, $path, $req) {
    $ext = [IO.Path]::GetExtension($path).ToLower()
    $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
    $res.Headers['Cache-Control'] = Get-CacheControlFor $path
    $res.AddHeader('Accept-Ranges', 'bytes')

    $fs = [IO.File]::OpenRead($path)
    try {
        $len = $fs.Length
        $start = 0L
        $end = $len - 1
        $range = if ($req) { $req.Headers['Range'] }
        if ($range -and $range -match '^bytes=(\d*)-(\d*)$') {
            if ($Matches[1] -eq '') { $start = [Math]::Max(0L, $len - [long]$Matches[2]) }
            else {
                $start = [long]$Matches[1]
                if ($Matches[2] -ne '') { $end = [Math]::Min([long]$Matches[2], $len - 1) }
            }
            if ($start -ge $len -or $start -gt $end) {
                $res.StatusCode = 416
                $res.AddHeader('Content-Range', "bytes */$len")
                $res.ContentLength64 = 0
                return
            }
            $res.StatusCode = 206
            $res.AddHeader('Content-Range', "bytes $start-$end/$len")
        }
        $count = $end - $start + 1
        $res.ContentLength64 = $count
        if ($req.HttpMethod -eq 'HEAD') { return }
        $fs.Position = $start
        $buf = New-Object byte[] ([Math]::Min(1MB, [Math]::Max(1, $count)))
        $left = $count
        while ($left -gt 0) {
            $n = $fs.Read($buf, 0, [int][Math]::Min($buf.Length, $left))
            if ($n -le 0) { break }
            $res.OutputStream.Write($buf, 0, $n)
            $left -= $n
        }
    } finally { $fs.Dispose() }
}

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response
        try {
            $fleet = Invoke-FleetIdEndpoint -Context $ctx -Tool 'talkforge' -Version $version -Path $selfPath
            if ($fleet) {
                Write-Log "$($req.HttpMethod) $($req.Url.AbsolutePath) -> $fleet"
                if ($fleet -eq 'shutdown') { $listener.Stop() }
                continue
            }
            # Url.LocalPath is already percent-decoded once; decoding again would turn /..%255C into a real backslash.
            $rel = $req.Url.LocalPath.TrimStart('/')
            if ([string]::IsNullOrEmpty($rel)) { $rel = 'TalkForge-tts.html' }
            $full = [IO.Path]::GetFullPath((Join-Path $Root $rel))
            # Prevent path traversal
            if (-not (Test-RequestPathAllowed $rel) -or -not (Test-PathUnderRoot $Root $full)) {
                $res.StatusCode = 403
                Write-Log "$($req.HttpMethod) /$rel -> 403"
            } elseif (Test-Path $full -PathType Leaf) {
                Send-File $res $full $req
                Write-Log "$($req.HttpMethod) /$rel -> $($res.StatusCode)"
            } else {
                $res.StatusCode = 404
                $msg = [Text.Encoding]::UTF8.GetBytes("Not found: $rel")
                $res.ContentType = 'text/plain'
                $res.ContentLength64 = $msg.Length
                $res.OutputStream.Write($msg, 0, $msg.Length)
                Write-Log "$($req.HttpMethod) /$rel -> 404"
            }
        } catch {
            Write-Log "Request error for $($req.Url.LocalPath): $_"
            try { $res.StatusCode = 500 } catch {}
        } finally {
            try { $res.Close() } catch {}
        }
    }
} finally {
    $listener.Stop()
    Write-Log "Server stopped."
}
