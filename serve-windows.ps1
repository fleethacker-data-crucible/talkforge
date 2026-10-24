# serve-windows.ps1 — static file server for Piper TTS (PowerShell 5.1, no admin, localhost only)
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\serve-windows.ps1
#   powershell -ExecutionPolicy Bypass -File .\serve-windows.ps1 -Port 26000
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

function Show-Fatal([string]$text) {
    Write-Log "[FATAL] $text"
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show("Piper TTS server could not start.`n`n$text`n`nLog: $logFile", 'Piper TTS Server',
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
    '.jpg'  = 'image/jpeg'
    '.ico'  = 'image/x-icon'
    '.md'   = 'text/plain; charset=utf-8'
    '.txt'  = 'text/plain; charset=utf-8'
}

function Test-PortFree([int]$p) {
    try {
        $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
        $l.Start()
        $l.Stop()
        return $true
    } catch { return $false }
}

# Find a free port starting at $Port
$chosen = $Port
while (-not (Test-PortFree $chosen)) {
    $chosen++
    if ($chosen -gt 65535) { Show-Fatal "No free port found starting from $Port" }
}
if ($chosen -ne $Port) { Write-Log "Port $Port in use. Using $chosen instead." }

$prefix = "http://127.0.0.1:$chosen/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

try { $listener.Start() }
catch { Show-Fatal "Failed to start listener on $prefix : $_" }

Write-Log "Serving $Root at $prefix"
Write-Log "Open: ${prefix}piper-tts.html"
Write-Log "Press Ctrl+C to stop."

if (-not $NoBrowser) {
    try { Start-Process "${prefix}piper-tts.html" } catch {}
}

function Send-File($res, $path, $req) {
    $ext = [IO.Path]::GetExtension($path).ToLower()
    $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
    $res.Headers['Cache-Control'] = 'no-store'
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
            $rel = [System.Uri]::UnescapeDataString($req.Url.LocalPath).TrimStart('/')
            if ([string]::IsNullOrEmpty($rel)) { $rel = 'piper-tts.html' }
            $full = [IO.Path]::GetFullPath((Join-Path $Root $rel))
            # Prevent path traversal
            if (-not $full.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
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
