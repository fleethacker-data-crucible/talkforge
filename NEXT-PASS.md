# Next pass: talkforge

Findings from a review on 2026-10-24. Work top to bottom; tick items off as you go. Line numbers are as of commit `722b950` and may have shifted.

The repo has no sanitize items: no personal data, internal docs or secrets were found. Tests pass offline (`node tests/tts-utils.test.mjs`, `node tests/syntax.test.mjs`), and `TalkForge-tts.html` makes no CDN or external calls at runtime.

## 1. A fresh clone can't run offline (TechStack: "bundle all deps")

- [ ] **HIGH: runtime assets aren't in the repo.** They are listed in `assets-manifest.json:3-112` but missing:
  - all 9 `models/*.onnx`
  - `wasm/piper_phonemize.data` (about 18 MB)
  - `vendor/onnx/ort-wasm-simd-threaded.jsep.wasm`, which `ort.min.mjs` requests

  Either commit them (LFS or a release zip built off-workstation) or document that the release zip is the only supported install.
- [ ] **HIGH: the workstation downloads assets.** (CDN and Hugging Face fallbacks are now opt-in only: -AllowUpstream / TALKFORGE_ALLOW_UPSTREAM=1.) `populate-assets.ps1:56,119` and `populate-assets.sh:71-73` pull from GitHub Releases, falling back to cdn.jsdelivr.net and huggingface.co. `README.md:19` tells Windows users to run it on the workstation. Make it a build-machine step only.
- [x] **HIGH: downloads aren't integrity-checked.** `assets-manifest.json` has no sha256 or sizes, and the "already exists → skip" logic (ps1:48/68/96, sh:65/85) keeps truncated or tampered files forever. Add hashes, verify them after download, and re-fetch on mismatch. Fixed: sha256 for every manifest entry, verified on download and on existing files.

## 2. Windows server (`serve-windows.ps1`)

- [ ] **HIGH (confirm on a non-admin account): `HttpListener` may need admin.** `serve-windows.ps1:70-74` uses it with `http://127.0.0.1:$port/`, and HTTP.sys usually refuses that prefix for non-admin users without a URL ACL. TechStack line 10 calls for `TcpListener`, which line 55 already uses for the port probe. Switch the server to it.
- [x] **MEDIUM: the path-traversal guard can be bypassed.** Fixed: the root check uses a trailing separator, the path is decoded once, and `.git`, `.env*`, `*.log` and `:` (alternate streams, drive letters) are refused (Pester tests).
- [~] **MEDIUM: assets are refetched for every sentence.** Line 88 sends `Cache-Control: no-store`, and `assets/vendor/piper-engine.js:45` builds a new phonemizer per sentence. Together they re-fetch about 18 MB `.data` + `.wasm` for each chunk and leak instances. Cache the phonemizer, and allow caching of static assets. Partly done: models, `.wasm` and `.data` now send `private, max-age=300`; the page, scripts and configs stay `no-store`. Still open: `piper-engine.js` builds a new phonemizer per sentence.

## 3. Bugs

- [x] **MEDIUM: "Download WAV" writes a malformed file.** `TalkForge-tts.html:865` concatenates whole WAV blobs, each with its own RIFF header, so most players play only the first one. Merge the PCM data under a single header. Fixed: one header plus concatenated PCM.
- [ ] **MEDIUM: the release workflow fails when main has moved.** `.github/workflows/release.yml:42` runs `git push origin HEAD:main` from the detached tag checkout, which fails non-fast-forward once main is past the tag. The stamp commit also lands after the tag, so the tag's source zip carries the old `release-base.txt`.
- [x] **MEDIUM: populate-assets has a stale fallback and fails silently.** `populate-assets.sh:44,48` and `populate-assets.ps1:31,35` fall back to `v1.0.0` while `assets/release-base.txt` says v1.2.0. The ps1 worker prints `FAIL` (line 136) but exits 0, and the `.bat` just pauses. Fixed: default is v1.3.0 of the org repo, exit code 1 on any failure.
- [x] **MEDIUM: PS 5.1 downloads can fail on TLS.** `populate-assets.ps1` never sets `[Net.ServicePointManager]::SecurityProtocol` to TLS 1.2, so `Invoke-WebRequest` fails on many Windows 10 / .NET 4.x setups. Also: Fixed: TLS 1.2 set, JSON parsed with ConvertFrom-Json, unused functions removed.
  - line 83 assigns to the automatic `$matches`
  - the regex depends on JSON key order
  - `Get-Asset` and `Get-AssetPreferRelease` (46-79) are never called
- [x] **LOW: the model can load twice at startup.** `populateVoices` and `preSynthesizeFirst` (`TalkForge-tts.html:1007-1010`) can both call `ensureEngine` at once, loading the 75 MB+ model twice. Fixed: one in-flight load per model (`loadOnce`, unit-tested).

## 4. Conformance and docs

- [x] **Launcher:** renamed to `TalkForge.bat` / `Start-TalkForge.ps1`, run with `-STA`; `serve.bat` and `serve-windows.ps1` remain as shims. (A `TalkForge.lnk` per the edge-ops launcher convention still needs generating on Windows.)
- [x] `serve.sh` uses Python `http.server` with no Host check. That's fine as a dev-only convenience; say so in the README. Its header (line 6) says port 8080, but the code (line 11) uses 25000.
- [x] `README.md:23` claims a CDN fallback that doesn't exist. `README.md:70` says the onnx files are in `wasm/onnx/`; they are in `assets/vendor/onnx/`.
- [x] `LOCAL-ASSET-PLAYBOOK.md:16,19,74-81,92` and `assets/MANIFEST.md:10-20,54` describe files that don't exist (`piper-tts-web.js`, `assets/wasm/onnx/`, `onnxruntime-web/`, `artifacts/`). The playbook also recommends `python3 -m http.server`.
- [x] `.github/workflows/tests.yml:14` has `continue-on-error: true`, so failing tests never block anything. `tests/syntax.test.mjs:27` checks only the first inline module and two vendor files. Fixed: tests block, with an offline synthesis smoke test.
- [x] Add `LICENSE` and `VERSION` per edge-ops `CONVENTIONS.md`. Both exist (VERSION is checked against PAGE_VERSION).

## 5. Cleanup

- [x] **Add a `.gitignore`.** There isn't one, so downloaded `.onnx`/`.data` files and `serve-windows.log` can be committed by accident. Exists.
- [ ] **Remove unused files** (`voices_static` is already gone): `onnx/ort.wasm.min.mjs` and `onnx/ort-wasm-simd-threaded.mjs`. The manifest and `release.yml:66` also ship the unused non-jsep `ort-wasm-simd-threaded.wasm`.
- [x] **Remove unused code in `TalkForge-tts.html`:** `checkLocalWasm` (437), `MULTI_SPEAKER_MODELS` (411) and `currentSession` (399). Removed.
