# Pester 5 smoke tests for the port block + self-detection in serve-windows.ps1.
# Run: Invoke-Pester -Path .\tests -Output Detailed   (Windows PowerShell 5.1; uses scratch port 18500, starts real servers).
BeforeAll {
    $script:repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $script:hostExe = (Get-Process -Id $PID).Path
    $script:port = 18500
    Import-Module (Join-Path $repo 'FleetPort.psm1') -Force
    $html = [IO.File]::ReadAllText((Join-Path $repo 'piper-tts.html'))
    $script:version = [regex]::Match($html, "PAGE_VERSION\s*=\s*'([0-9.]+)'").Groups[1].Value

    # A throwaway copy of the server; -Version writes a stub page with that PAGE_VERSION (the "older TalkForge").
    function New-TalkForgeCopy([string]$Version) {
        $dir = Join-Path ([IO.Path]::GetTempPath()) ('talkforge-smoke-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Copy-Item (Join-Path $repo 'serve-windows.ps1'), (Join-Path $repo 'FleetPort.psm1'), (Join-Path $repo 'FleetPorts.psd1') $dir
        if ([IO.Path]::DirectorySeparatorChar -ne '\') {
            # Off Windows the managed HttpListener binds 127.0.0.1 and localhost (::1) as separate sockets, so the probe's
            # Host: localhost request on 127.0.0.1 gets a 400. http.sys on Windows routes both prefixes on one port.
            $f = Join-Path $dir 'serve-windows.ps1'
            [IO.File]::WriteAllText($f, ([IO.File]::ReadAllText($f) -replace '(?m)^\$listener\.Prefixes\.Add\(\$prefix\)\r?\n', ''))
        }
        Set-Content -LiteralPath (Join-Path $dir 'piper-tts.html') -Value ("<!doctype html><title>smoke</title><script>const PAGE_VERSION = '" + $Version + "';</script>") -Encoding Ascii
        return $dir
    }
    function Start-TalkForge([string]$Dir) {
        $out = [IO.Path]::GetTempFileName(); $err = [IO.Path]::GetTempFileName()
        $p = Start-Process $hostExe -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err -ArgumentList @(
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $Dir 'serve-windows.ps1') + '"'), '-Port', "$port", '-NoBrowser')
        # Windows PowerShell 5.1: read .Handle now, or ExitCode reads as $null after exit (Start-Process -PassThru with -Redirect*).
        [void]$p.Handle
        return @{ Process = $p; Out = $out; Err = $err; Script = (Join-Path $Dir 'serve-windows.ps1') }
    }
    function Wait-Id([int]$TimeoutMs = 15000) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
            $id = Test-FleetSelf -Port $port -Tool 'talkforge' -TimeoutMs 500
            if ($id) { return $id }
            Start-Sleep -Milliseconds 200
        }
        return $null
    }
    function Stop-TalkForge($s) {
        if (-not $s) { return }
        if (-not $s.Process.HasExited) {
            try { $r = [Net.HttpWebRequest]::Create("http://localhost:$port/__fleethacker/shutdown"); $r.Method = 'POST'; $r.Proxy = $null; $r.ContentLength = 0; $r.Headers['X-FleetHacker-Shutdown'] = '1'; $r.Timeout = 2000; $r.GetResponse().Close() } catch { }
            if (-not $s.Process.WaitForExit(5000)) { Stop-Process -Id $s.Process.Id -Force -ErrorAction SilentlyContinue }
        }
    }
    $script:current = New-TalkForgeCopy $version
}

AfterAll { if ($current) { Remove-Item -LiteralPath $current -Recurse -Force -ErrorAction SilentlyContinue } }

Describe 'serve-windows.ps1 port and self-detection' {
    It 'registry puts talkforge on 25000-25009, policy reuse' {
        $b = Get-FleetPortBlock -Tool 'talkforge' -RegistryPath (Join-Path $repo 'FleetPorts.psd1')
        $b.Start | Should -Be 25000
        $b.Size | Should -Be 10
        $b.Policy | Should -Be 'reuse'
    }

    It 'serves /__fleethacker/id with tool, version, pid and absolute script path, and still serves the page' {
        $s = Start-TalkForge $current
        try {
            $id = Wait-Id
            $id | Should -Not -BeNullOrEmpty
            $id.Version | Should -Be $version
            $id.Pid | Should -Be $s.Process.Id
            $id.Path | Should -Be ([IO.Path]::GetFullPath($s.Script))
            (Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$port/piper-tts.html" -TimeoutSec 5).StatusCode | Should -Be 200
        } finally { Stop-TalkForge $s }
    }

    It 'a second launch of the same version reuses the running copy and exits 0' {
        $s = Start-TalkForge $current
        try {
            $first = Wait-Id; $first | Should -Not -BeNullOrEmpty
            $t = Start-TalkForge $current
            $t.Process.WaitForExit(15000) | Should -BeTrue
            $t.Process.ExitCode | Should -Be 0
            (Get-Content -LiteralPath $t.Out -Raw) | Should -Match 'already running'
            (Wait-Id).Pid | Should -Be $first.Pid
        } finally { Stop-TalkForge $s }
    }

    It 'replaces an older running TalkForge' {
        $old = New-TalkForgeCopy '0.0.1'
        $s = Start-TalkForge $old
        $t = $null
        try {
            (Wait-Id).Version | Should -Be '0.0.1'
            $t = Start-TalkForge $current
            $s.Process.WaitForExit(15000) | Should -BeTrue
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $id = $null
            while ($sw.ElapsedMilliseconds -lt 15000) { $id = Wait-Id 1000; if ($id -and $id.Version -eq $version) { break } }
            $id.Version | Should -Be $version
            $id.Pid | Should -Be $t.Process.Id
        } finally { Stop-TalkForge $t; Stop-TalkForge $s; Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'POST /__fleethacker/shutdown stops it; a cross-origin shutdown is refused' {
        $s = Start-TalkForge $current
        try {
            (Wait-Id) | Should -Not -BeNullOrEmpty
            $r = [Net.HttpWebRequest]::Create("http://localhost:$port/__fleethacker/shutdown"); $r.Method = 'POST'; $r.Proxy = $null; $r.ContentLength = 0
            $r.Headers['X-FleetHacker-Shutdown'] = '1'; $r.Headers['Origin'] = 'http://evil.example'
            $code = 0
            try { $r.GetResponse().Close() } catch [Net.WebException] { $code = [int]$_.Exception.Response.StatusCode }
            $code | Should -Be 403
            $s.Process.HasExited | Should -BeFalse
            $r = [Net.HttpWebRequest]::Create("http://localhost:$port/__fleethacker/shutdown"); $r.Method = 'POST'; $r.Proxy = $null; $r.ContentLength = 0
            $r.Headers['X-FleetHacker-Shutdown'] = '1'
            $r.GetResponse().Close()
            $s.Process.WaitForExit(10000) | Should -BeTrue
        } finally { Stop-TalkForge $s }
    }
}
