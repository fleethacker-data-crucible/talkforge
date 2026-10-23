#!/usr/bin/env bash
# populate-assets.sh
# Downloads vendor libraries, WASM binaries, and Piper voice models
# into the assets/ directory for the offline / intranet Piper TTS page.
#
# Usage:
#   chmod +x populate-assets.sh
#   ./populate-assets.sh
#
# Requires: curl (or wget). Run from the directory that contains the assets/ folder
# (or the script will create assets/ relative to the current working directory).

set -euo pipefail

ASSET_ROOT="${ASSET_ROOT:-./assets}"
VENDOR_DIR="${ASSET_ROOT}/vendor"
WASM_DIR="${ASSET_ROOT}/wasm"
MODELS_DIR="${ASSET_ROOT}/models"
ONNX_WASM_DIR="${WASM_DIR}/onnx"

# Versions / sources
PIPER_TTS_WEB_VERSION="1.1.1"
LAMEJS_VERSION="1.2.1"
ONNXRUNTIME_WEB_VERSION="1.22.0"
DIFFUSION_PIPER_WASM_VERSION="1.0.0"

HF_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"

echo "Creating directory structure under ${ASSET_ROOT} ..."
mkdir -p "${VENDOR_DIR}" "${WASM_DIR}" "${ONNX_WASM_DIR}" "${MODELS_DIR}"

download() {
  local url="$1"
  local dest="$2"
  local name
  name=$(basename "${dest}")
  if [[ -f "${dest}" ]]; then
    echo "  [skip] ${name} already exists"
    return 0
  fi
  echo "  [get]  ${name}"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 -o "${dest}" "${url}"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 -O "${dest}" "${url}"
  else
    echo "Error: neither curl nor wget is available." >&2
    exit 1
  fi
}

echo ""
echo "=== Vendor JavaScript (full local package) ==="

# Download the main entry and the actual bundled modules so relative imports work offline
mkdir -p "${VENDOR_DIR}/dist"

download \
  "https://cdn.jsdelivr.net/npm/@realtimex/piper-tts-web@${PIPER_TTS_WEB_VERSION}/dist/piper-tts-web.js" \
  "${VENDOR_DIR}/piper-tts-web.js"

# The hashed chunk that the entry imports
download \
  "https://cdn.jsdelivr.net/npm/@realtimex/piper-tts-web@${PIPER_TTS_WEB_VERSION}/dist/piper-o91UDS6e.js" \
  "${VENDOR_DIR}/dist/piper-o91UDS6e.js"

# Voices data chunk
download \
  "https://cdn.jsdelivr.net/npm/@realtimex/piper-tts-web@${PIPER_TTS_WEB_VERSION}/dist/voices_static-D_OtJDHM.js" \
  "${VENDOR_DIR}/dist/voices_static-D_OtJDHM.js"

# lamejs
download \
  "https://cdn.jsdelivr.net/npm/lamejs@${LAMEJS_VERSION}/lame.min.js" \
  "${VENDOR_DIR}/lame.min.js"

echo ""
echo "=== Piper phonemizer WASM ==="

# From @diffusionstudio/piper-wasm (widely used by browser Piper builds)
download \
  "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@${DIFFUSION_PIPER_WASM_VERSION}/build/piper_phonemize.wasm" \
  "${WASM_DIR}/piper_phonemize.wasm"

download \
  "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@${DIFFUSION_PIPER_WASM_VERSION}/build/piper_phonemize.data" \
  "${WASM_DIR}/piper_phonemize.data"

echo ""
echo "=== ONNX Runtime Web WASM ==="

# Core WASM binaries for onnxruntime-web 1.22.x
# (older flat names like ort-wasm.wasm no longer exist in this version)
for f in \
  ort-wasm-simd-threaded.wasm \
  ort-wasm-simd-threaded.jsep.wasm
do
  download \
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNXRUNTIME_WEB_VERSION}/dist/${f}" \
    "${ONNX_WASM_DIR}/${f}"
done

echo ""
echo "=== Voice models (default: LibriTTS-R Medium) ==="

# Medium model (~75 MB) – required for the default selection
download \
  "${HF_BASE}/en/en_US/libritts_r/medium/en_US-libritts_r-medium.onnx" \
  "${MODELS_DIR}/en_US-libritts_r-medium.onnx"

download \
  "${HF_BASE}/en/en_US/libritts_r/medium/en_US-libritts_r-medium.onnx.json" \
  "${MODELS_DIR}/en_US-libritts_r-medium.onnx.json"

# VCTK multi-speaker model (British English, medium only — no high exists)
download \
  "${HF_BASE}/en/en_GB/vctk/medium/en_GB-vctk-medium.onnx" \
  "${MODELS_DIR}/en_GB-vctk-medium.onnx"

download \
  "${HF_BASE}/en/en_GB/vctk/medium/en_GB-vctk-medium.onnx.json" \
  "${MODELS_DIR}/en_GB-vctk-medium.onnx.json"

# Common single-speaker + LibriTTS high models
for model in \
  "en/en_US/lessac/medium/en_US-lessac-medium" \
  "en/en_US/lessac/high/en_US-lessac-high" \
  "en/en_US/amy/medium/en_US-amy-medium" \
  "en/en_US/hfc_female/medium/en_US-hfc_female-medium" \
  "en/en_US/hfc_male/medium/en_US-hfc_male-medium" \
  "en/en_GB/alan/medium/en_GB-alan-medium" \
  "en/en_US/libritts/high/en_US-libritts-high"
do
  base=$(basename "$model")
  download "${HF_BASE}/${model}.onnx" "${MODELS_DIR}/${base}.onnx"
  download "${HF_BASE}/${model}.onnx.json" "${MODELS_DIR}/${base}.onnx.json"
done

echo ""
echo "Done."
echo ""
echo "Assets populated under: ${ASSET_ROOT}"
echo "  vendor/  – piper-tts-web.js, lame.min.js"
echo "  wasm/    – piper_phonemize.wasm, piper_phonemize.data, onnx/"
echo "  models/  – en_US-libritts_r-medium.onnx (+ .json)"
echo ""
echo "Serve the parent directory with any static file server and open piper-tts.html."
echo "The page will show a green “Local assets” badge when it finds the local files."
