#!/usr/bin/env bash
# populate-assets.sh
# Downloads assets listed in assets-manifest.json and verifies each SHA-256.
# Downloads from the GitHub Release only (offline policy). The upstream url in the manifest (CDN or
# Hugging Face) is used ONLY when TALKFORGE_ALLOW_UPSTREAM=1 (still SHA-256 verified).
# If the GitHub CLI is installed and signed in (gh auth status), release assets are fetched with
# `gh release download` first, so a private repo works. TALKFORGE_GH=auto (default) | on | off.
# on = require gh and never fall back; off = never use gh. Hash mismatch from gh is final (fail closed).
# A file that does not match its sha256 is never kept; exit code is 1 if anything failed.
#
# Usage:
#   chmod +x populate-assets.sh
#   ./populate-assets.sh
#   TALKFORGE_ONLY="models/en_US-lessac-high*,wasm/*,vendor/onnx/*.jsep.wasm" ./populate-assets.sh
#
# TALKFORGE_ONLY: comma-separated wildcard patterns matched against the manifest "dest".
# Hash rule: .json files are hashed with CR bytes removed (checkouts may be CRLF).

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

PY="$(command -v python3 || command -v python || true)"
if [[ -z "${PY}" ]]; then
  echo "Error: python3 (or python) is required to read the manifest." >&2
  exit 1
fi

# sha256 of a file; .json files are hashed with CR bytes removed.
sha256_of() {
  "${PY}" - "$1" "$2" << 'PYH' | tr -d '[:space:]'
import hashlib, sys
path, dest = sys.argv[1], sys.argv[2]
data = open(path, "rb").read()
if dest.endswith(".json"):
    data = data.replace(bytes([13]), b"")
print(hashlib.sha256(data).hexdigest())
PYH
}

fetch() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 2 -o "${out}" "${url}"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 -O "${out}" "${url}"
  else
    echo "Error: neither curl nor wget is available." >&2
    exit 1
  fi
}

FAILURES=()

# --- authenticated release download through the GitHub CLI -------------------------------------
GH_MODE="${TALKFORGE_GH:-auto}"
case "${GH_MODE}" in auto|on|off) ;; *) echo "Error: TALKFORGE_GH must be auto, on or off (got ${GH_MODE})" >&2; exit 1 ;; esac
GH_STATE=""; GH_REPO=""; GH_TAG=""
read -ra GH_CMD <<< "${TALKFORGE_GH_BIN:-gh}" # TALKFORGE_GH_BIN: test hook to swap in a fake gh

# True when gh can be used for this run (decided once). Sets GH_REPO / GH_TAG.
gh_enabled() {
  if [[ -z "${GH_STATE}" ]]; then
    GH_STATE=no
    if [[ "${GH_MODE}" != "off" ]]; then
      if [[ "${RELEASE_BASE}" =~ ^https://github\.com/([^/]+/[^/]+)/releases/download/([^/]+)$ ]]; then
        GH_REPO="${BASH_REMATCH[1]}"; GH_TAG="${BASH_REMATCH[2]}"
      fi
      GH_REPO="${TALKFORGE_GH_REPO:-${GH_REPO}}"; GH_TAG="${TALKFORGE_GH_TAG:-${GH_TAG}}"
      if [[ -n "${GH_REPO}" && -n "${GH_TAG}" ]] && command -v "${GH_CMD[0]}" >/dev/null 2>&1 && "${GH_CMD[@]}" auth status >/dev/null 2>&1; then
        GH_STATE=yes
        echo "Using gh for release downloads: ${GH_REPO} ${GH_TAG}"
      elif [[ "${GH_MODE}" == "on" ]]; then
        FAILURES+=("gh is required (TALKFORGE_GH=on) but is not installed, not signed in (run: gh auth login), or the release repo/tag is unknown")
      fi
    fi
  fi
  [[ "${GH_STATE}" == "yes" ]]
}

# gh_fetch <asset name> <output file>: download one release asset by exact name.
gh_fetch() {
  local name="$1" out="$2" tmp
  tmp="$(mktemp -d)" || return 1
  if "${GH_CMD[@]}" release download "${GH_TAG}" --repo "${GH_REPO}" --pattern "${name}" --dir "${tmp}" --clobber >/dev/null 2>&1 && [[ -f "${tmp}/${name}" ]]; then
    mv -f "${tmp}/${name}" "${out}"; rm -rf "${tmp}"; return 0
  fi
  rm -rf "${tmp}"; return 1
}

# $1 dest (relative)  $2 upstream url  $3 prefer release (1/0)  $4 expected sha256
process() {
  local dest="$1" url="$2" prefer="$3" expected="$4"
  local full_dest="${ASSET_ROOT}/${dest}" name
  name="$(basename "${dest}")"
  if ! [[ "${expected}" =~ ^[0-9a-f]{64}$ ]]; then
    FAILURES+=("${name} : manifest entry has no valid sha256 (refusing to use unverified files)")
    return
  fi
  mkdir -p "$(dirname "${full_dest}")"
  if [[ -f "${full_dest}" ]]; then
    local actual
    actual="$(sha256_of "${full_dest}" "${dest}")"
    if [[ "${actual}" == "${expected}" ]]; then
      echo "  [ok]   ${name} already present, SHA-256 verified"
    else
      FAILURES+=("${name} : file exists but SHA-256 does not match (expected ${expected}, got ${actual}). Delete ${full_dest} and run again.")
    fi
    return
  fi
  local urls=() problems_hint=""
  if [[ "${prefer}" == "1" ]]; then urls+=("${RELEASE_BASE}/${name}"); fi
  if [[ "${TALKFORGE_ALLOW_UPSTREAM:-}" == "1" ]]; then urls+=("${url}"); else problems_hint="upstream download is off (offline policy); set TALKFORGE_ALLOW_UPSTREAM=1 to use ${url}"; fi
  local part="${full_dest}.part" problems="" u actual
  if [[ "${prefer}" == "1" ]]; then
    if ! gh_enabled && [[ "${GH_MODE}" == "on" ]]; then return; fi # required but unavailable: already reported
    if gh_enabled; then
      echo "  [gh]   ${name} <- ${GH_REPO} ${GH_TAG}"
      if gh_fetch "${name}" "${part}"; then
        actual="$(sha256_of "${part}" "${dest}")"
        if [[ "${actual}" == "${expected}" ]]; then
          mv -f "${part}" "${full_dest}"
          echo "  [ok]   ${name} verified <- gh release ${GH_TAG}"
          return
        fi
        rm -f "${part}"
        FAILURES+=("${name} : SHA-256 MISMATCH from gh release ${GH_TAG} (expected ${expected}, got ${actual}); not trying other sources. The release and assets-manifest.json disagree.")
        return
      fi
      problems+="gh release download failed for ${name}; "
      if [[ "${GH_MODE}" == "on" ]]; then FAILURES+=("${name} : ${problems}(TALKFORGE_GH=on: no fallback)"); return; fi
    fi
  fi
  [[ "${#urls[@]}" -eq 0 ]] && problems+="${problems_hint}; "
  for u in "${urls[@]}"; do
    echo "  [get]  ${name} <- ${u}"
    if ! (fetch "${u}" "${part}") 2>/dev/null; then
      problems+="download failed from ${u}; "
      rm -f "${part}"
      continue
    fi
    actual="$(sha256_of "${part}" "${dest}")"
    if [[ "${actual}" == "${expected}" ]]; then
      mv -f "${part}" "${full_dest}"
      echo "  [ok]   ${name} verified <- ${u}"
      return
    fi
    problems+="SHA-256 MISMATCH from ${u} (expected ${expected}, got ${actual}); "
    rm -f "${part}"
  done
  [[ -n "${problems_hint}" && "${problems}" != *"${problems_hint}"* ]] && problems+="${problems_hint}; "
  FAILURES+=("${name} : ${problems}")
}

matches_only() {
  local dest="$1" pat
  [[ -z "${TALKFORGE_ONLY:-}" ]] && return 0
  IFS=',' read -ra pats <<< "${TALKFORGE_ONLY}"
  for pat in "${pats[@]}"; do
    # shellcheck disable=SC2053
    [[ "${dest}" == ${pat} ]] && return 0
  done
  return 1
}

MATCHED=0
CR="$(printf "%b" "\r")"
while IFS=$'	' read -r dest url prefer sha; do
  sha="${sha%$CR}"  # python on Windows prints CRLF
  if matches_only "${dest}"; then
    MATCHED=$((MATCHED + 1))
    process "${dest}" "${url}" "${prefer}" "${sha}"
  fi
done < <("${PY}" - "${MANIFEST}" << 'PYM'
import json, sys
with open(sys.argv[1], encoding="utf-8-sig") as f:
    data = json.load(f)
for a in data.get("assets", []):
    dest = a.get("dest", "")
    url = a.get("url", "")
    prefer = "1" if a.get("preferRelease") else "0"
    sha = (a.get("sha256") or "").lower()
    if dest and url:
        print(f"{dest}	{url}	{prefer}	{sha}")
PYM
)

if [[ -n "${TALKFORGE_ONLY:-}" && "${MATCHED}" -eq 0 ]]; then
  FAILURES+=("TALKFORGE_ONLY matched no manifest entry: ${TALKFORGE_ONLY}")
fi

echo ""
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo "FAILED: ${#FAILURES[@]} asset(s) could not be verified:" >&2
  for f in "${FAILURES[@]}"; do echo "  - ${f}" >&2; done
  echo "No unverified file was kept. Fix the problem above and run this script again." >&2
  exit 1
fi
echo "Done. All assets verified (SHA-256)."
echo "Assets under: ${ASSET_ROOT}"
