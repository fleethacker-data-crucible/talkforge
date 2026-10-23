#!/usr/bin/env bash
# populate-assets.sh
# Downloads vendor libraries, WASM binaries, and Piper voice models.
# Prefers assets from the GitHub Release; falls back to CDN / Hugging Face.
#
# Usage:
#   chmod +x populate-assets.sh
#   ./populate-assets.sh

set -euo pipefail

ASSET_ROOT="${ASSET_ROOT:-./assets}"
VENDOR_DIR="${ASSET_ROOT}/vendor"
WASM_DIR="${ASSET_ROOT}/wasm"
MODELS_DIR="${ASSET_ROOT}/models"
ONNX_WASM_DIR="${WASM_DIR}/onnx"

# Detect release base.
# Priority: TALKFORGE_RELEASE_BASE env, assets/release-base.txt (stamped by CI), git remote, default.
detect_release_base() {
  if [[ -n "${TALKFORGE_RELEASE_BASE:-}" ]]; then
    echo "${TALKFORGE_RELEASE_BASE}"
    return
  fi
  local stamp="${ASSET_ROOT}/release-base.txt"
  if [[ -f "${stamp}" ]]; then
    local line
    line=$(head -1 "${stamp}" | tr -d '[:space:]')
    if [[ -n "${line}" ]]; then
      echo "${line}"
      return
    fi
  fi
  local remote_url=""
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    remote_url=$(git remote get-url origin 2>/dev/null || true)
  fi
  if [[ -n "${remote_url}" ]]; then
    local path
    path=$(echo "${remote_url}" | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##')
    if [[ "${path}" =~ ^[^/]+/[^/]+$ ]]; then
      echo "https://github.com/${path}/releases/download/v1.0.0"
      return
    fi
  fi
  echo "https://github.com/seakintruth/talkforge/releases/download/v1.0.0"
}

RELEASE_BASE="$(detect_release_base)"
echo "Using release base: ${RELEASE_BASE}"
HF_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"

PIPER_TTS_WEB_VERSION="1.1.1"
LAMEJS_VERSION="1.2.1"
ONNXRUNTIME_WEB_VERSION="1.22.0"
DIFFUSION_PIPER_WASM_VERSION="1.0.0"

echo "Creating directory structure under ${ASSET_ROOT} ..."
mkdir -p "${VENDOR_DIR}/dist" "${WASM_DIR}" "${ONNX_WASM_DIR}" "${MODELS_DIR}"

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

# Try release URL first; fall back to the given CDN/HF URL
download_prefer_release() {
  local filename="$1"
  local fallback_url="$2"
  local dest="$3"
  local release_url="${RELEASE_BASE}/${filename}"
  if [[ -f "${dest}" ]]; then
    echo "  [skip] $(basename "${dest}") already exists"
    return 0
  fi
  echo "  [try]  $(basename "${dest}") from release"
  if download "${release_url}" "${dest}" 2>/dev/null; then
    return 0
  fi
  echo "  [fallback] $(basename "${dest}")"
  download "${fallback_url}" "${dest}"
}

echo ""
echo "=== Vendor JavaScript ==="

download \
  "https://cdn.jsdelivr.net/npm/@realtimex/piper-tts-web@${PIPER_TTS_WEB_VERSION}/dist/piper-tts-web.js" \
  "${VENDOR_DIR}/piper-tts-web.js"

download \
  "https://cdn.jsdelivr.net/npm/@realtimex/piper-tts-web@${PIPER_TTS_WEB_VERSION}/dist/piper-o91UDS6e.js" \
  "${VENDOR_DIR}/dist/piper-o91UDS6e.js"

download \
  "https://cdn.jsdelivr.net/npm/@realtimex/piper-tts-web@${PIPER_TTS_WEB_VERSION}/dist/voices_static-D_OtJDHM.js" \
  "${VENDOR_DIR}/dist/voices_static-D_OtJDHM.js"

download \
  "https://cdn.jsdelivr.net/npm/lamejs@${LAMEJS_VERSION}/lame.min.js" \
  "${VENDOR_DIR}/lame.min.js"

echo ""
echo "=== Piper phonemizer WASM ==="

download_prefer_release \
  "piper_phonemize.wasm" \
  "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@${DIFFUSION_PIPER_WASM_VERSION}/build/piper_phonemize.wasm" \
  "${WASM_DIR}/piper_phonemize.wasm"

download_prefer_release \
  "piper_phonemize.data" \
  "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@${DIFFUSION_PIPER_WASM_VERSION}/build/piper_phonemize.data" \
  "${WASM_DIR}/piper_phonemize.data"

echo ""
echo "=== ONNX Runtime Web WASM ==="

for f in ort-wasm-simd-threaded.wasm ort-wasm-simd-threaded.jsep.wasm; do
  download_prefer_release \
    "${f}" \
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNXRUNTIME_WEB_VERSION}/dist/${f}" \
    "${ONNX_WASM_DIR}/${f}"
done

echo ""
echo "=== Voice models ==="

for model in \
  "en/en_US/libritts_r/medium/en_US-libritts_r-medium" \
  "en/en_GB/vctk/medium/en_GB-vctk-medium" \
  "en/en_US/lessac/medium/en_US-lessac-medium" \
  "en/en_US/lessac/high/en_US-lessac-high" \
  "en/en_US/amy/medium/en_US-amy-medium" \
  "en/en_US/hfc_female/medium/en_US-hfc_female-medium" \
  "en/en_US/hfc_male/medium/en_US-hfc_male-medium" \
  "en/en_GB/alan/medium/en_GB-alan-medium" \
  "en/en_US/libritts/high/en_US-libritts-high"
do
  base=$(basename "$model")
  download_prefer_release \
    "${base}.onnx" \
    "${HF_BASE}/${model}.onnx" \
    "${MODELS_DIR}/${base}.onnx"
  download_prefer_release \
    "${base}.onnx.json" \
    "${HF_BASE}/${model}.onnx.json" \
    "${MODELS_DIR}/${base}.onnx.json"
done

echo ""
echo "Done."
echo "Assets under: ${ASSET_ROOT}"
echo "Large files prefer the v1.0.0 Release; missing ones fall back to CDN/Hugging Face."
