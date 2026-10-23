# populate-assets.ps1 — Windows equivalent of populate-assets.sh
# Prefers assets from the GitHub Release; falls back to CDN / Hugging Face.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\populate-assets.ps1
#   powershell -ExecutionPolicy Bypass -File .\populate-assets.ps1 -AssetRoot .\assets

param(
    [string]$AssetRoot = (Join-Path $PSScriptRoot 'assets')
)

$ErrorActionPreference = 'Stop'

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
    # Force .0 series: .../v1.0.1 → .../v1.0.0
    return $url -replace '/releases/download/v(\d+)\.(\d+)\.\d+', '/releases/download/v$1.$2.0'
}

$RELEASE_BASE = ConvertTo-SeriesBase (Get-ReleaseBase)
Write-Host "Using release base: $RELEASE_BASE"
$HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'

$PIPER_TTS_WEB_VERSION = '1.1.1'
$LAMEJS_VERSION = '1.2.1'
$ONNXRUNTIME_WEB_VERSION = '1.22.0'
$DIFFUSION_PIPER_WASM_VERSION = '1.0.0'

$VendorDir = Join-Path $AssetRoot 'vendor'
$WasmDir = Join-Path $AssetRoot 'wasm'
$ModelsDir = Join-Path $AssetRoot 'models'
$OnnxWasmDir = Join-Path $WasmDir 'onnx'
$VendorDist = Join-Path $VendorDir 'dist'

Write-Host "Creating directory structure under $AssetRoot ..."
New-Item -ItemType Directory -Force -Path $VendorDir, $WasmDir, $OnnxWasmDir, $ModelsDir, $VendorDist | Out-Null

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

Write-Host ""
Write-Host "=== Vendor JavaScript ==="

Get-Asset "https://cdn.jsdelivr.net/npm/@realtimex/piper-tts-web@$PIPER_TTS_WEB_VERSION/dist/piper-tts-web.js" (Join-Path $VendorDir 'piper-tts-web.js') | Out-Null
Get-Asset "https://cdn.jsdelivr.net/npm/@realtimex/piper-tts-web@$PIPER_TTS_WEB_VERSION/dist/piper-o91UDS6e.js" (Join-Path $VendorDist 'piper-o91UDS6e.js') | Out-Null
Get-Asset "https://cdn.jsdelivr.net/npm/@realtimex/piper-tts-web@$PIPER_TTS_WEB_VERSION/dist/voices_static-D_OtJDHM.js" (Join-Path $VendorDist 'voices_static-D_OtJDHM.js') | Out-Null
Get-Asset "https://cdn.jsdelivr.net/npm/lamejs@$LAMEJS_VERSION/lame.min.js" (Join-Path $VendorDir 'lame.min.js') | Out-Null

Write-Host ""
Write-Host "=== Piper phonemizer WASM ==="

Get-AssetPreferRelease 'piper_phonemize.wasm' "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@$DIFFUSION_PIPER_WASM_VERSION/build/piper_phonemize.wasm" (Join-Path $WasmDir 'piper_phonemize.wasm')
Get-AssetPreferRelease 'piper_phonemize.data' "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@$DIFFUSION_PIPER_WASM_VERSION/build/piper_phonemize.data" (Join-Path $WasmDir 'piper_phonemize.data')

Write-Host ""
Write-Host "=== ONNX Runtime Web WASM ==="

foreach ($f in @('ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.wasm')) {
    Get-AssetPreferRelease $f "https://cdn.jsdelivr.net/npm/onnxruntime-web@$ONNXRUNTIME_WEB_VERSION/dist/$f" (Join-Path $OnnxWasmDir $f)
}

Write-Host ""
Write-Host "=== Voice models ==="

$models = @(
    'en/en_US/libritts_r/medium/en_US-libritts_r-medium',
    'en/en_GB/vctk/medium/en_GB-vctk-medium',
    'en/en_US/lessac/medium/en_US-lessac-medium',
    'en/en_US/lessac/high/en_US-lessac-high',
    'en/en_US/amy/medium/en_US-amy-medium',
    'en/en_US/hfc_female/medium/en_US-hfc_female-medium',
    'en/en_US/hfc_male/medium/en_US-hfc_male-medium',
    'en/en_GB/alan/medium/en_GB-alan-medium',
    'en/en_US/libritts/high/en_US-libritts-high'
)

foreach ($model in $models) {
    $base = Split-Path $model -Leaf
    Get-AssetPreferRelease "$base.onnx" "$HF_BASE/$model.onnx" (Join-Path $ModelsDir "$base.onnx")
    Get-AssetPreferRelease "$base.onnx.json" "$HF_BASE/$model.onnx.json" (Join-Path $ModelsDir "$base.onnx.json")
}

Write-Host ""
Write-Host "Done."
Write-Host "Assets under: $AssetRoot"
Write-Host "Large files prefer the v1.0.0 Release; missing ones fall back to CDN/Hugging Face."
