# TalkForge

> client-side neural text-to-speech (Piper, ONNX Runtime Web/WASM) with offline local assets.

Client-side neural text-to-speech in the browser. Runs Piper TTS models entirely in-browser (ONNX Runtime Web + WASM) with multi-speaker support, local-asset offline mode, and simple static servers for Linux and constrained Windows environments.

## Quick start

### Linux / macOS
```bash
git clone https://github.com/fleethacker-data-crucible/talkforge.git
cd talkforge
./populate-assets.sh          # optional: downloads large models if not using a Release
./serve.sh                    # starts on http://127.0.0.1:25000 (or next free port)
```

### Windows (PowerShell 5.1, no admin)
```bat
git clone https://github.com/fleethacker-data-crucible/talkforge.git
cd talkforge
populate-assets.bat           # optional: downloads large models
serve.bat                     # starts the local server and opens the page
```

`serve.bat` uses port block **25000-25009** (edge-ops PORTS.md). Launching it while TalkForge is already running opens the running copy instead of starting another; an older running copy is asked to stop (`POST /__fleethacker/shutdown`) and replaced. `-Port <n>` uses exactly that port. `GET http://127.0.0.1:<port>/__fleethacker/id` reports the running tool, version (the page's `PAGE_VERSION`), pid and script path.

Open `TalkForge-tts.html` in a browser. The page loads everything from the local `assets/` folder and makes no CDN or other external requests. If a model or WASM file is missing it stops with an error instead of fetching it from the internet; run `populate-assets` to download the files from the pinned GitHub Release.

## What’s in the repo vs. a Release

| In the repo (cloned) | In a GitHub Release (`.0` series only) |
|----------------------|----------------------------------------|
| Source, scripts, CI, docs | All `.onnx` model files |
| Small JS (piper-tts-web, lamejs, engine) | `piper_phonemize.data` (~17 MB) |
| Small WASM (`piper_phonemize.wasm`) | ONNX Runtime WASM binaries |
| `.onnx.json` configs | `release-base.txt` stamp |

### Asset storage policy

Large model and WASM files are uploaded **only** on series releases that end in `.0` (for example `v1.1.0`).  
Patch releases (`v1.1.1`, `v1.1.2`, …) reuse those same assets and do not re-upload them.

The populate scripts always request the matching `.0` series URL, so a clone or source zip from any patch release still finds the models.

```bash
# Series release (uploads large assets)
git tag v1.1.0
git push origin v1.1.0

# Patch release (stamp only, no large assets)
git tag v1.1.1
git push origin v1.1.1
```

After the workflow finishes, `populate-assets.sh` / `.ps1` / `.bat` will pull the large files from the `.0` release of the repo the script is running in (or from the stamped `assets/release-base.txt`).

### Integrity checks

Every asset in `assets-manifest.json` has a `sha256`. `populate-assets` downloads to a `.part` file, verifies it, and only then moves it into place; a mismatch is reported (expected vs actual), the file is not kept, and the script exits with code 1. Files already present are verified too. `.json` configs are hashed with CR bytes removed so CRLF checkouts match. `-Only` (PowerShell) or `TALKFORGE_ONLY` (shell) limits the run to wildcard patterns, for example `models/en_US-lessac-high*,wasm/*,vendor/onnx/*.jsep.wasm`.

If the page cannot find a file it needs, it lists exactly which `assets/...` files are missing and what to run.

## Features

- Multi-speaker models (LibriTTS-R, VCTK) with searchable speaker list
- Background first-sentence synthesis for faster start
- Read-all / selection / click-to-read modes
- MP3 download of generated audio
- Speed control
- Debug panel with copy-to-clipboard
- Pure-function test suite (`node tests/tts-utils.test.mjs`)
- Optional GitHub Actions tests (non-blocking)

## Layout

```
TalkForge-tts.html
assets/
  vendor/          # JS libraries and engine
  wasm/            # phonemizer WASM (data + onnx/ come from Release)
  models/          # .onnx.json configs (models come from Release)
populate-assets.sh / .ps1 / .bat
serve.sh / serve-windows.ps1 / serve.bat
tests/
.github/workflows/
```

## License

MIT for the page and scripts. Model files follow the licenses of the upstream Piper voices (see each model’s MODEL_CARD on Hugging Face).

