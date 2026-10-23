#!/usr/bin/env bash
# populate-assets.sh
# Downloads assets listed in assets-manifest.json.
# Prefers the GitHub Release for entries with preferRelease=true.
#
# Usage:
#   chmod +x populate-assets.sh
#   ./populate-assets.sh

set -euo pipefail

ASSET_ROOT="${ASSET_ROOT:-./assets}"
MANIFEST="${MANIFEST:-./assets-manifest.json}"

if [[ ! -f "${MANIFEST}" ]]; then
  echo "Error: manifest not found: ${MANIFEST}" >&2
  exit 1
fi

# Detect release base.
# Priority: TALKFORGE_RELEASE_BASE env, assets/release-base.txt, git remote, default.
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

to_series_base() {
  local url="$1"
  echo "${url}" | sed -E 's#/releases/download/v([0-9]+)\.([0-9]+)\.[0-9]+#/releases/download/v\1.\2.0#'
}

RELEASE_BASE="$(to_series_base "$(detect_release_base)")"
echo "Using release base: ${RELEASE_BASE}"
echo "Reading manifest: ${MANIFEST}"

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

# Parse manifest with python3 (available on the CI runner and most dev machines)
python3 - "${MANIFEST}" << 'PY' | while IFS=$'\t' read -r dest url prefer; do
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for a in data.get("assets", []):
    dest = a.get("dest", "")
    url = a.get("url", "")
    prefer = "1" if a.get("preferRelease") else "0"
    if dest and url:
        print(f"{dest}\t{url}\t{prefer}")
PY
  full_dest="${ASSET_ROOT}/${dest}"
  mkdir -p "$(dirname "${full_dest}")"
  filename=$(basename "${dest}")
  if [[ "${prefer}" == "1" ]]; then
    download_prefer_release "${filename}" "${url}" "${full_dest}"
  else
    download "${url}" "${full_dest}"
  fi
done

echo ""
echo "Done."
echo "Assets under: ${ASSET_ROOT}"
