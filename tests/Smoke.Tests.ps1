# Pester 5 smoke tests (FleetHacker standard). Run: Invoke-Pester -Path .\tests -Output Detailed
# Static checks only: they read files and never start the tool.
BeforeDiscovery {
    $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $skip = '[\\/](\.git|\.claude|node_modules|temp|vscode-ext-source)[\\/]'
    $script:ScriptFiles = @(Get-ChildItem -Path $script:RepoRoot -Recurse -File -Include *.ps1, *.psm1 |
        Where-Object { $_.FullName -notmatch $skip } |
        ForEach-Object { @{ Name = $_.FullName.Substring($script:RepoRoot.Length + 1); Path = $_.FullName } })
    # Server source files and the loopback bind expected. Fails only on +, *, 0.0.0.0 or a non-loopback bind.
    $script:Servers = @(
        @{ File = 'Start-TalkForge.ps1'; Pattern = '(IPAddress\]?::Loopback|IPAddress\.Loopback|http://127\.0\.0\.1:|http://localhost:|http://\[::1\]:)'; Skip = $null }
    )
}

Describe 'PowerShell 5.1 parse' {
    It 'parses <Name>' -ForEach $script:ScriptFiles {
        $tokens = $null; $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
        # TypeNotFound = class defined in another file (load-order dependency), not a syntax error.
        $real = @($errors | Where-Object { $_.ErrorId -ne 'TypeNotFound' } | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" })
        $real | Should -BeNullOrEmpty
    }
}

Describe 'Loopback-only bind' -Skip:($script:Servers.Count -eq 0) {
    It '<File> never binds a wildcard address' -ForEach $script:Servers {
        $text = [IO.File]::ReadAllText((Join-Path $script:RepoRootRun ($File -replace "\\", [IO.Path]::DirectorySeparatorChar)))
        $text | Should -Not -Match 'https?://(\+|\*|0\.0\.0\.0)[:/]'
        $text | Should -Not -Match 'IPAddress\]?::(Any|IPv6Any)\b'
    }
    It '<File> binds loopback (localhost, 127.0.0.1 or IPAddress.Loopback)' -ForEach $script:Servers {
        if ($Skip) { Set-ItResult -Skipped -Because $Skip; return }
        $text = [IO.File]::ReadAllText((Join-Path $script:RepoRootRun ($File -replace "\\", [IO.Path]::DirectorySeparatorChar)))
        $text | Should -Match $Pattern
    }
}

Describe 'Start-TalkForge.ps1 path guard' {
    BeforeAll {
        # Load only Test-PathUnderRoot from the script (the script itself starts a server).
        $path = Join-Path $script:RepoRootRun 'Start-TalkForge.ps1'
        $tokens = $null; $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
        $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-PathUnderRoot' }, $true)
        . ([scriptblock]::Create($fn.Extent.Text))
        $script:R = 'C:\TalkForge'
    }
    It 'accepts the root and files inside it' {
        Test-PathUnderRoot $script:R 'C:\TalkForge' | Should -BeTrue
        Test-PathUnderRoot $script:R 'C:\TalkForge\TalkForge-tts.html' | Should -BeTrue
        Test-PathUnderRoot $script:R 'C:\talkforge\assets\models\x.onnx' | Should -BeTrue
        Test-PathUnderRoot 'C:\TalkForge\' 'C:\TalkForge\a.js' | Should -BeTrue
    }
    It 'rejects a sibling folder that shares the prefix' {
        Test-PathUnderRoot $script:R 'C:\TalkForge-evil\secret.txt' | Should -BeFalse
        Test-PathUnderRoot $script:R 'C:\TalkForge2' | Should -BeFalse
    }
    It 'rejects the parent and unrelated paths' {
        Test-PathUnderRoot $script:R 'C:\' | Should -BeFalse
        Test-PathUnderRoot $script:R 'C:\Windows\win.ini' | Should -BeFalse
    }
    It 'does not use a bare StartsWith($Root) in the request loop' {
        $text = [IO.File]::ReadAllText((Join-Path $script:RepoRootRun 'Start-TalkForge.ps1'))
        $text | Should -Not -Match 'StartsWith\(\$Root'
    }
}

Describe 'launcher names and compatibility shims' {
    BeforeAll { $script:R = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
    It 'has TalkForge.bat and Start-TalkForge.ps1, and keeps serve.bat and serve-windows.ps1 as shims' {
        foreach ($f in 'TalkForge.bat', 'Start-TalkForge.ps1', 'serve.bat', 'serve-windows.ps1') {
            Test-Path -LiteralPath (Join-Path $script:R $f) | Should -BeTrue -Because $f
        }
    }
    It 'TalkForge.bat runs Start-TalkForge.ps1 in an STA host with no admin step' {
        $t = [IO.File]::ReadAllText((Join-Path $script:R 'TalkForge.bat'))
        $t | Should -Match '-STA'
        $t | Should -Match 'Start-TalkForge\.ps1'
        $t | Should -Match '%\*'
        $t | Should -Not -Match '(?i)runas|Start-Process .*-Verb'
    }
    It 'serve.bat hands over to TalkForge.bat with the same arguments' {
        $t = [IO.File]::ReadAllText((Join-Path $script:R 'serve.bat'))
        $t | Should -Match 'TalkForge\.bat'
        $t | Should -Match '%\*'
    }
    It 'serve-windows.ps1 forwards to Start-TalkForge.ps1 in its own STA process and keeps the old parameters' {
        $path = Join-Path $script:R 'serve-windows.ps1'
        $tokens = $null; $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
        $errors | Should -BeNullOrEmpty
        $names = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
        $names | Should -Be @('Port', 'Root', 'NoBrowser')
        $text = [IO.File]::ReadAllText($path)
        $text | Should -Match 'Start-TalkForge\.ps1'
        $text | Should -Match "'-STA'"
        $text | Should -Match 'exit \$LASTEXITCODE'
    }
    It 'does not leave the server logic in the shim' {
        ([IO.File]::ReadAllText((Join-Path $script:R 'serve-windows.ps1')) | Measure-Object -Line).Lines | Should -BeLessThan 30
    }
}

Describe 'Start-TalkForge.ps1 request path rules and caching' {
    BeforeAll {
        $path = Join-Path $script:RepoRootRun 'Start-TalkForge.ps1'
        $tokens = $null; $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
        foreach ($name in 'Test-RequestPathAllowed', 'Get-CacheControlFor') {
            $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
            . ([scriptblock]::Create($fn.Extent.Text))
        }
    }
    It 'allows normal asset and page paths' {
        foreach ($p in '', 'TalkForge-tts.html', 'assets/models/en_US-libritts-high.onnx', 'assets\\vendor\\piper-engine.js', 'README.md') {
            Test-RequestPathAllowed $p | Should -BeTrue -Because $p
        }
    }
    It 'refuses git internals, env files and logs in any case or depth' {
        foreach ($p in '.git/config', '.GIT/HEAD', 'assets/.git/x', '.env', '.env.local', 'sub/.ENV', 'serve-windows.log', 'TalkForge.log', 'logs/app.LOG') {
            Test-RequestPathAllowed $p | Should -BeFalse -Because $p
        }
    }
    It 'refuses NUL, drive letters and alternate data streams' {
        foreach ($p in "a$([char]0)b", 'C:/Windows/win.ini', 'TalkForge-tts.html::$DATA', 'file.txt:stream') {
            Test-RequestPathAllowed $p | Should -BeFalse -Because $p
        }
    }
    It 'decodes the request path once: an encoded backslash stays a literal character' {
        $uri = [uri]'http://127.0.0.1:25000/..%255Ctalkforge-other%255Cfile'
        $uri.LocalPath.TrimStart('/') | Should -Be '..%5Ctalkforge-other%5Cfile'
        $uri.LocalPath.Contains([string][char]92) | Should -BeFalse
        $text = [IO.File]::ReadAllText((Join-Path $script:RepoRootRun 'Start-TalkForge.ps1'))
        $text | Should -Not -Match 'UnescapeDataString\(\$req\.Url\.LocalPath'
    }
    It 'caches only immutable binaries, never the page or scripts' {
        Get-CacheControlFor 'C:\x\assets\models\a.onnx' | Should -Be 'private, max-age=300'
        Get-CacheControlFor 'C:\x\assets\wasm\piper_phonemize.DATA' | Should -Be 'private, max-age=300'
        Get-CacheControlFor 'C:\x\a.wasm' | Should -Be 'private, max-age=300'
        foreach ($f in 'TalkForge-tts.html', 'assets\\vendor\\piper-engine.js', 'a.json', 'b.mjs') { Get-CacheControlFor $f | Should -Be 'no-store' -Because $f }
    }
}

BeforeAll {
    $script:RepoRootRun = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
