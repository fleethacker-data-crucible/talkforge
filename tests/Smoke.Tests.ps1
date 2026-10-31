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
        @{ File = 'serve-windows.ps1'; Pattern = '(IPAddress\]?::Loopback|IPAddress\.Loopback|http://127\.0\.0\.1:|http://localhost:|http://\[::1\]:)'; Skip = $null }
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

Describe 'serve-windows.ps1 path guard' {
    BeforeAll {
        # Load only Test-PathUnderRoot from the script (the script itself starts a server).
        $path = Join-Path $script:RepoRootRun 'serve-windows.ps1'
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
        $text = [IO.File]::ReadAllText((Join-Path $script:RepoRootRun 'serve-windows.ps1'))
        $text | Should -Not -Match 'StartsWith\(\$Root'
    }
}

BeforeAll {
    $script:RepoRootRun = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
